import {
  badRequest,
  conflict,
  createEvent,
  enqueue,
  newId,
  notFound,
  parsePage,
  requireUser,
  slugify,
  withTx,
  z,
  type Auth,
  type FastifyInstance,
  type Pool,
  type PoolClient,
} from '@shopnow/platform';
import { Topics, type ShopSnapshot } from '@shopnow/contracts';
import { last4, mask, type Sealer } from './crypto';

type Db = Pool | PoolClient;
type ShopStatus = ShopSnapshot['status'];

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const text = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} tối thiểu ${min} ký tự`).max(max, `${label} tối đa ${max} ký tự`);

const pickupAddress = z.object({
  line1: text(3, 255, 'Địa chỉ'),
  ward: text(1, 120, 'Phường/xã'),
  district: text(1, 120, 'Quận/huyện'),
  province: text(1, 120, 'Tỉnh/thành'),
});
const kyc = z.object({
  legalName: text(2, 150, 'Tên pháp lý'),
  taxCode: z.string().trim().regex(/^\d{10}(-\d{3})?$/, 'Mã số thuế gồm 10 số (hoặc 10 số-3 số)').nullable().optional(),
  idNumber: z.string().trim().regex(/^(\d{9}|\d{12})$/, 'Số CMND/CCCD gồm 9 hoặc 12 chữ số'),
});
const bankAccount = z.object({
  bankName: text(2, 100, 'Tên ngân hàng'),
  accountNumber: z.string().trim().regex(/^\d{6,20}$/, 'Số tài khoản gồm 6–20 chữ số'),
  holder: text(2, 100, 'Chủ tài khoản'),
});

// Cho phép gửi KYC lồng trong `kyc` hoặc phẳng (legalName/taxCode/idNumber) ở gốc
const liftKyc = (v: unknown) => {
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (o.kyc !== undefined || !('idNumber' in o || 'legalName' in o)) return o;
  const { legalName, taxCode, idNumber, ...rest } = o;
  return { ...rest, kyc: { legalName, taxCode, idNumber } };
};

const shopFields = {
  name: text(3, 80, 'Tên shop'),
  description: z.string().trim().max(2000).default(''),
  logoUrl: z.string().url().max(500).regex(/^https?:\/\//, 'logoUrl phải là http(s)').nullable().optional(),
  phone: z.string().trim().regex(/^(0|\+84)\d{9,10}$/, 'Số điện thoại không hợp lệ'),
  pickupAddress,
  kyc,
  bankAccount,
};
const createShopInput = z.preprocess(liftKyc, z.object(shopFields));
const updateShopInput = z.preprocess(
  liftKyc,
  z.object({ ...shopFields, description: z.string().trim().max(2000) }).partial(),
);

interface ShopRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  phone: string;
  pickup_address: { line1: string; ward: string; district: string; province: string };
  pickup_province: string;
  legal_name: string;
  tax_code: string | null;
  id_number_last4: string;
  bank_name: string;
  bank_account_last4: string;
  bank_holder: string;
  status: ShopStatus;
  reject_reason: string | null;
  suspend_reason: string | null;
  follower_count: number;
  submitted_at: Date;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function snapshot(s: ShopRow): ShopSnapshot {
  return { id: s.id, ownerId: s.owner_id, name: s.name, slug: s.slug, status: s.status, pickupProvince: s.pickup_province, createdAt: s.created_at.toISOString() };
}

export function publicView(s: ShopRow) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    logoUrl: s.logo_url,
    pickupProvince: s.pickup_province,
    followerCount: s.follower_count,
    status: s.status,
    createdAt: s.created_at.toISOString(),
    approvedAt: s.approved_at?.toISOString() ?? null,
  };
}

/** Dành cho chủ shop / admin — KYC chỉ trả dạng che. */
export function ownerView(s: ShopRow) {
  return {
    ...publicView(s),
    ownerId: s.owner_id,
    phone: s.phone,
    pickupAddress: s.pickup_address,
    rejectReason: s.reject_reason,
    suspendReason: s.suspend_reason,
    kyc: { legalName: s.legal_name, taxCode: s.tax_code, idNumber: mask(s.id_number_last4) },
    bankAccount: { bankName: s.bank_name, accountNumber: mask(s.bank_account_last4), holder: s.bank_holder },
    submittedAt: s.submitted_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
  };
}

async function emit(c: PoolClient, type: string, s: ShopRow, reason?: string | null) {
  const data = reason ? { ...snapshot(s), reason } : snapshot(s);
  await enqueue(c, Topics.sellerShop, createEvent(type, 'seller', s.id, data));
}

async function uniqueSlug(c: PoolClient, name: string, excludeId?: string) {
  const base = slugify(name) || 'shop';
  for (let i = 0; ; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const r = await c.query('SELECT 1 FROM shops WHERE slug = $1 AND id IS DISTINCT FROM $2', [slug, excludeId ?? null]);
    if (r.rowCount === 0) return slug;
  }
}

async function loadShop(db: Db, idOrSlug: string, forUpdate = false) {
  const col = isUuid(idOrSlug) ? 'id' : 'slug';
  const { rows } = await db.query<ShopRow>(`SELECT * FROM shops WHERE ${col} = $1${forUpdate ? ' FOR UPDATE' : ''}`, [idOrSlug]);
  return rows[0];
}

const uniqueViolation = (e: unknown) => {
  const err = e as { code?: string; constraint?: string };
  if (err.code !== '23505') return e;
  return err.constraint?.includes('owner') ? conflict('Mỗi tài khoản chỉ được mở 1 shop') : conflict('Tên shop đã được dùng, hãy chọn tên khác');
};

export function registerRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Auth; sealer: Sealer }) {
  const { pool, auth, sealer } = deps;
  const authed = { preHandler: auth.authenticate };
  const admin = { preHandler: auth.requireRole('admin') };

  // ---------------- Chủ shop ----------------
  app.post('/shops', authed, async (req, reply) => {
    const u = requireUser(req);
    const b = createShopInput.parse(req.body);
    const shop = await withTx(pool, async (c) => {
      const existing = await c.query('SELECT 1 FROM shops WHERE owner_id = $1', [u.id]);
      if (existing.rowCount) throw conflict('Mỗi tài khoản chỉ được mở 1 shop');
      const { rows } = await c
        .query<ShopRow>(
          `INSERT INTO shops (id, owner_id, name, slug, description, logo_url, phone, pickup_address, pickup_province,
             legal_name, tax_code, id_number_enc, id_number_last4, bank_name, bank_account_enc, bank_account_last4, bank_holder)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [
            newId(), u.id, b.name, await uniqueSlug(c, b.name), b.description, b.logoUrl ?? null, b.phone, b.pickupAddress, b.pickupAddress.province,
            b.kyc.legalName, b.kyc.taxCode ?? null, sealer.seal(b.kyc.idNumber), last4(b.kyc.idNumber),
            b.bankAccount.bankName, sealer.seal(b.bankAccount.accountNumber), last4(b.bankAccount.accountNumber), b.bankAccount.holder,
          ],
        )
        .catch((e) => {
          throw uniqueViolation(e);
        });
      const s = rows[0];
      await c.query('INSERT INTO shop_status_history (id, shop_id, from_status, to_status, actor_id) VALUES ($1,$2,NULL,$3,$4)', [newId(), s.id, 'PENDING', u.id]);
      await emit(c, 'shop.submitted', s);
      return s;
    });
    return reply.status(201).send(ownerView(shop));
  });

  app.get('/shops/me', authed, async (req) => {
    const { rows } = await pool.query<ShopRow>('SELECT * FROM shops WHERE owner_id = $1', [requireUser(req).id]);
    if (!rows[0]) throw notFound('Bạn chưa mở shop');
    return ownerView(rows[0]);
  });

  app.put('/shops/me', authed, async (req) => {
    const u = requireUser(req);
    const b = updateShopInput.parse(req.body ?? {});
    const shop = await withTx(pool, async (c) => {
      const { rows } = await c.query<ShopRow>('SELECT * FROM shops WHERE owner_id = $1 FOR UPDATE', [u.id]);
      const cur = rows[0];
      if (!cur) throw notFound('Bạn chưa mở shop');
      const sets: string[] = [];
      const args: unknown[] = [cur.id];
      const set = (col: string, v: unknown) => {
        args.push(v);
        sets.push(`${col} = $${args.length}`);
      };
      if (b.name !== undefined && b.name !== cur.name) {
        set('name', b.name);
        // Đã duyệt thì giữ slug cố định (link shop không đổi)
        if (cur.status !== 'APPROVED' && cur.status !== 'SUSPENDED') set('slug', await uniqueSlug(c, b.name, cur.id));
      }
      if (b.description !== undefined) set('description', b.description);
      if (b.logoUrl !== undefined) set('logo_url', b.logoUrl);
      if (b.phone !== undefined) set('phone', b.phone);
      if (b.pickupAddress) {
        set('pickup_address', b.pickupAddress);
        set('pickup_province', b.pickupAddress.province);
      }
      if (b.kyc) {
        set('legal_name', b.kyc.legalName);
        if (b.kyc.taxCode !== undefined) set('tax_code', b.kyc.taxCode);
        set('id_number_enc', sealer.seal(b.kyc.idNumber));
        set('id_number_last4', last4(b.kyc.idNumber));
      }
      if (b.bankAccount) {
        set('bank_name', b.bankAccount.bankName);
        set('bank_account_enc', sealer.seal(b.bankAccount.accountNumber));
        set('bank_account_last4', last4(b.bankAccount.accountNumber));
        set('bank_holder', b.bankAccount.holder);
      }
      const resubmit = cur.status === 'REJECTED';
      if (resubmit) sets.push(`status = 'PENDING'`, 'reject_reason = NULL', 'submitted_at = now()');
      if (sets.length === 0) return cur;
      const upd = await c
        .query<ShopRow>(`UPDATE shops SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`, args)
        .catch((e) => {
          throw uniqueViolation(e);
        });
      const s = upd.rows[0];
      if (resubmit) {
        await c.query('INSERT INTO shop_status_history (id, shop_id, from_status, to_status, actor_id) VALUES ($1,$2,$3,$4,$5)', [newId(), s.id, 'REJECTED', 'PENDING', u.id]);
        await emit(c, 'shop.submitted', s);
      } else if ((s.status === 'APPROVED' || s.status === 'SUSPENDED') && (s.name !== cur.name || s.pickup_province !== cur.pickup_province)) {
        // Bổ sung ngoài hợp đồng: catalog/search cập nhật tên shop
        await emit(c, 'shop.updated', s);
      }
      return s;
    });
    return ownerView(shop);
  });

  // ---------------- Công khai ----------------
  app.get('/shops', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { page, pageSize, offset, limit } = parsePage(q);
    const args: unknown[] = [];
    let where = `status = 'APPROVED'`;
    if (q.q?.trim()) {
      args.push(`%${q.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&')}%`);
      where += ` AND lower(name) LIKE $${args.length}`;
    }
    const total = (await pool.query(`SELECT count(*)::int n FROM shops WHERE ${where}`, args)).rows[0].n;
    const { rows } = await pool.query<ShopRow>(`SELECT * FROM shops WHERE ${where} ORDER BY follower_count DESC, id LIMIT ${limit} OFFSET ${offset}`, args);
    return { items: rows.map(publicView), page, pageSize, total };
  });

  app.get<{ Params: { idOrSlug: string } }>('/shops/:idOrSlug', { preHandler: auth.optionalAuth }, async (req) => {
    const s = await loadShop(pool, req.params.idOrSlug);
    if (!s || s.status !== 'APPROVED') throw notFound('Không tìm thấy shop');
    let following = false;
    if (req.user) {
      const r = await pool.query('SELECT 1 FROM shop_followers WHERE shop_id = $1 AND user_id = $2', [s.id, req.user.id]);
      following = Boolean(r.rowCount);
    }
    return { ...publicView(s), following };
  });

  // ---------------- Theo dõi shop ----------------
  app.post<{ Params: { id: string } }>('/shops/:id/follow', authed, async (req) => {
    const u = requireUser(req);
    return withTx(pool, async (c) => {
      const s = isUuid(req.params.id) ? await loadShop(c, req.params.id, true) : undefined;
      if (!s || s.status !== 'APPROVED') throw notFound('Không tìm thấy shop');
      if (s.owner_id === u.id) throw badRequest('Không thể tự theo dõi shop của mình');
      const ins = await c.query('INSERT INTO shop_followers (shop_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [s.id, u.id]);
      const { rows } = await c.query('UPDATE shops SET follower_count = follower_count + $2 WHERE id = $1 RETURNING follower_count', [s.id, ins.rowCount ? 1 : 0]);
      return { following: true, followerCount: rows[0].follower_count as number };
    });
  });

  app.delete<{ Params: { id: string } }>('/shops/:id/follow', authed, async (req) => {
    const u = requireUser(req);
    if (!isUuid(req.params.id)) throw notFound('Không tìm thấy shop');
    return withTx(pool, async (c) => {
      const s = await loadShop(c, req.params.id, true);
      if (!s) throw notFound('Không tìm thấy shop');
      const del = await c.query('DELETE FROM shop_followers WHERE shop_id = $1 AND user_id = $2', [s.id, u.id]);
      const { rows } = await c.query('UPDATE shops SET follower_count = GREATEST(0, follower_count - $2) WHERE id = $1 RETURNING follower_count', [s.id, del.rowCount ? 1 : 0]);
      return { following: false, followerCount: rows[0].follower_count as number };
    });
  });

  app.get('/me/following-shops', authed, async (req) => {
    const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>);
    const userId = requireUser(req).id;
    const base = `FROM shop_followers f JOIN shops s ON s.id = f.shop_id WHERE f.user_id = $1 AND s.status = 'APPROVED'`;
    const total = (await pool.query(`SELECT count(*)::int n ${base}`, [userId])).rows[0].n;
    const { rows } = await pool.query<ShopRow>(`SELECT s.* ${base} ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]);
    return { items: rows.map(publicView), page, pageSize, total };
  });

  // ---------------- Admin ----------------
  app.get('/admin/shops', admin, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { page, pageSize, offset, limit } = parsePage(q);
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.status) {
      args.push(q.status.toUpperCase());
      where.push(`status = $${args.length}`);
    }
    if (q.q?.trim()) {
      args.push(`%${q.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(lower(name) LIKE $${args.length} OR slug LIKE $${args.length})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await pool.query(`SELECT count(*)::int n FROM shops ${w}`, args)).rows[0].n;
    const { rows } = await pool.query<ShopRow>(`SELECT * FROM shops ${w} ORDER BY submitted_at, id LIMIT ${limit} OFFSET ${offset}`, args);
    return { items: rows.map(ownerView), page, pageSize, total };
  });

  app.get<{ Params: { id: string } }>('/admin/shops/:id', admin, async (req) => {
    const s = isUuid(req.params.id) ? await loadShop(pool, req.params.id) : undefined;
    if (!s) throw notFound('Không tìm thấy shop');
    const { rows } = await pool.query(
      'SELECT from_status, to_status, reason, actor_id, created_at FROM shop_status_history WHERE shop_id = $1 ORDER BY created_at',
      [s.id],
    );
    return {
      ...ownerView(s),
      history: rows.map((r) => ({ from: r.from_status, to: r.to_status, reason: r.reason, actorId: r.actor_id, at: r.created_at.toISOString() })),
    };
  });

  const transitions = {
    approve: { from: ['PENDING', 'SUSPENDED'], to: 'APPROVED', event: 'shop.approved', needReason: false },
    reject: { from: ['PENDING'], to: 'REJECTED', event: 'shop.rejected', needReason: true },
    suspend: { from: ['APPROVED'], to: 'SUSPENDED', event: 'shop.suspended', needReason: false },
  } as const;

  for (const [action, t] of Object.entries(transitions)) {
    app.post<{ Params: { id: string } }>(`/admin/shops/:id/${action}`, admin, async (req) => {
      const reasonSchema = z.string().trim().min(3, 'Lý do tối thiểu 3 ký tự').max(500);
      const { reason } = z.object({ reason: t.needReason ? reasonSchema : reasonSchema.optional() }).parse(req.body ?? {});
      const shop = await withTx(pool, async (c) => {
        const cur = isUuid(req.params.id) ? await loadShop(c, req.params.id, true) : undefined;
        if (!cur) throw notFound('Không tìm thấy shop');
        if (!(t.from as readonly string[]).includes(cur.status)) throw conflict(`Không thể ${action} shop đang ở trạng thái ${cur.status}`);
        const { rows } = await c.query<ShopRow>(
          `UPDATE shops SET status = $2::text,
             reject_reason = CASE WHEN $2::text = 'REJECTED' THEN $3::text ELSE NULL END,
             suspend_reason = CASE WHEN $2::text = 'SUSPENDED' THEN $3::text ELSE NULL END,
             approved_at = CASE WHEN $2::text = 'APPROVED' THEN COALESCE(approved_at, now()) ELSE approved_at END,
             updated_at = now()
           WHERE id = $1 RETURNING *`,
          [cur.id, t.to, reason ?? null],
        );
        await c.query('INSERT INTO shop_status_history (id, shop_id, from_status, to_status, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [
          newId(), cur.id, cur.status, t.to, reason ?? null, requireUser(req).id,
        ]);
        await emit(c, t.event, rows[0], reason);
        return rows[0];
      });
      return ownerView(shop);
    });
  }

  // ---------------- Nội bộ ----------------
  app.get<{ Params: { id: string } }>('/internal/shops/:id', { preHandler: auth.internalOnly }, async (req) => {
    const s = isUuid(req.params.id) ? await loadShop(pool, req.params.id) : undefined;
    if (!s) throw notFound('Không tìm thấy shop');
    return { id: s.id, ownerId: s.owner_id, name: s.name, status: s.status, pickupProvince: s.pickup_province };
  });
}
