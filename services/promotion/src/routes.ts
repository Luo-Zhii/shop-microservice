import {
  badRequest,
  conflict,
  forbidden,
  newId,
  notFound,
  parsePage,
  requireUser,
  withTx,
  z,
  type Auth,
  type FastifyInstance,
  type FastifyRequest,
  type Pool,
} from '@shopnow/platform';
import type { FlashStore } from './flash';
import { quote, quoteSchema } from './quote';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const voucherBase = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().max(2000).default(''),
  type: z.enum(['PERCENT', 'FIXED', 'FREESHIP']),
  value: z.number().int().min(0).default(0),
  maxDiscount: z.number().int().min(0).nullable().optional(),
  minOrder: z.number().int().min(0).default(0),
  usageLimit: z.number().int().positive().nullable().optional(),
  perUserLimit: z.number().int().positive().nullable().optional().default(1),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  active: z.boolean().default(true),
});
const voucherCreate = voucherBase.extend({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,32}$/, 'Mã chỉ gồm chữ, số, -, _ (3–32 ký tự)'),
});

function checkVoucher(v: { type: string; value: number; startsAt: Date; endsAt: Date }) {
  if (v.endsAt <= v.startsAt) throw badRequest('Thời gian kết thúc phải sau thời gian bắt đầu');
  if (v.type === 'PERCENT' && (v.value < 1 || v.value > 100)) throw badRequest('Voucher phần trăm phải có giá trị 1–100');
  if (v.type === 'FIXED' && v.value < 1) throw badRequest('Voucher giảm tiền phải có giá trị lớn hơn 0');
}

const flashInput = z.object({
  name: z.string().trim().min(2).max(200),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  active: z.boolean().default(true),
  items: z
    .array(
      z.object({
        skuId: z.string().min(1).max(64),
        productId: z.string().min(1).max(64),
        salePrice: z.number().int().min(0),
        quota: z.number().int().positive().max(1_000_000),
        perUserLimit: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

function voucherOut(r: Record<string, any>) {
  return {
    id: r.id,
    code: r.code,
    scope: r.scope,
    shopId: r.shop_id,
    type: r.type,
    title: r.title,
    description: r.description,
    value: Number(r.value),
    maxDiscount: r.max_discount == null ? null : Number(r.max_discount),
    minOrder: Number(r.min_order),
    usageLimit: r.usage_limit,
    perUserLimit: r.per_user_limit,
    used: Number(r.used ?? 0),
    remaining: r.usage_limit == null ? null : Math.max(0, r.usage_limit - Number(r.used ?? 0)),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    active: r.active,
    createdAt: r.created_at,
  };
}

const USED_SQL = `(SELECT count(*) FROM redemptions rd WHERE rd.voucher_id = v.id AND rd.status <> 'RELEASED')::int AS used`;

export function registerRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Auth; flash: FlashStore }) {
  const { pool, auth, flash } = deps;
  const seller = { preHandler: auth.requireRole('seller') };
  const admin = { preHandler: auth.requireRole('admin') };

  function shopOf(req: FastifyRequest) {
    const u = requireUser(req);
    if (!u.shopId) throw forbidden('Tài khoản chưa có shop được duyệt');
    return u.shopId;
  }

  // ---------------- Công khai ----------------
  app.get('/vouchers', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const args: unknown[] = [];
    let scopeSql: string;
    if (q.shopId) {
      args.push(q.shopId);
      scopeSql = `v.scope = 'SHOP' AND v.shop_id = $1`;
    } else scopeSql = `v.scope = 'PLATFORM'`;
    const { rows } = await pool.query(
      `SELECT * FROM (SELECT v.*, ${USED_SQL} FROM vouchers v
         WHERE ${scopeSql} AND v.active AND v.starts_at <= now() AND v.ends_at > now()) x
        WHERE usage_limit IS NULL OR used < usage_limit
        ORDER BY ends_at, code`,
      args,
    );
    return { items: rows.map(voucherOut) };
  });

  async function flashSalesOut(where: string, args: unknown[]) {
    const { rows: sales } = await pool.query(`SELECT * FROM flash_sales ${where} ORDER BY starts_at, id`, args);
    if (sales.length === 0) return [];
    const { rows: items } = await pool.query('SELECT * FROM flash_sale_items WHERE flash_sale_id = ANY($1::uuid[]) ORDER BY sale_price, id', [sales.map((s) => s.id)]);
    for (const i of items) await flash.ensureCounter(pool, i.id);
    const sold = await flash.soldMany(items.map((i) => i.id));
    return sales.map((s) => ({
      id: s.id,
      name: s.name,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      active: s.active,
      items: items
        .filter((i) => i.flash_sale_id === s.id)
        .map((i) => ({
          id: i.id,
          skuId: i.sku_id,
          productId: i.product_id,
          salePrice: Number(i.sale_price),
          quota: i.quota,
          sold: Math.min(i.quota, sold.get(i.id) ?? 0),
          remaining: Math.max(0, i.quota - (sold.get(i.id) ?? 0)),
          perUserLimit: i.per_user_limit,
        })),
    }));
  }

  app.get('/flash-sales/active', async () => ({ items: await flashSalesOut('WHERE active AND starts_at <= now() AND ends_at > now()', []) }));

  // ---------------- Nội bộ: báo giá cho order ----------------
  app.post('/quote', { preHandler: auth.internalOnly }, async (req) => quote({ pool, flash }, quoteSchema.parse(req.body)));

  // ---------------- CRUD voucher (seller: shop mình; admin: voucher sàn) ----------------
  function voucherCrud(prefix: '/seller/vouchers' | '/admin/vouchers', opts: typeof seller, scopeOf: (req: FastifyRequest) => { scope: 'SHOP' | 'PLATFORM'; shopId: string | null }) {
    /** Điều kiện "voucher thuộc phạm vi của người gọi"; idx = số thứ tự tham số SQL cho shop_id. */
    const own = (req: FastifyRequest, idx: number) => {
      const s = scopeOf(req);
      return s.scope === 'SHOP'
        ? { sql: `scope = 'SHOP' AND shop_id = $${idx}`, args: [s.shopId] as unknown[] }
        : { sql: `scope = 'PLATFORM'`, args: [] as unknown[] };
    };

    app.get(prefix, opts, async (req) => {
      const s = scopeOf(req);
      const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>);
      const where = s.scope === 'SHOP' ? `v.scope = 'SHOP' AND v.shop_id = $1` : `v.scope = 'PLATFORM'`;
      const args = s.scope === 'SHOP' ? [s.shopId] : [];
      const total = (await pool.query(`SELECT count(*)::int n FROM vouchers v WHERE ${where}`, args)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT v.*, ${USED_SQL} FROM vouchers v WHERE ${where} ORDER BY v.created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, limit, offset],
      );
      return { items: rows.map(voucherOut), page, pageSize, total };
    });

    app.post(prefix, opts, async (req, reply) => {
      const s = scopeOf(req);
      const b = voucherCreate.parse(req.body);
      checkVoucher(b);
      const id = newId();
      try {
        await pool.query(
          `INSERT INTO vouchers (id, code, scope, shop_id, type, title, description, value, max_discount, min_order, usage_limit, per_user_limit,
             starts_at, ends_at, active, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, b.code, s.scope, s.shopId, b.type, b.title, b.description, b.type === 'FREESHIP' ? 0 : b.value, b.maxDiscount ?? null, b.minOrder,
            b.usageLimit ?? null, b.perUserLimit ?? null, b.startsAt, b.endsAt, b.active, requireUser(req).id],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict(`Mã ${b.code} đã tồn tại`);
        throw e;
      }
      const { rows } = await pool.query(`SELECT v.*, ${USED_SQL} FROM vouchers v WHERE id = $1`, [id]);
      return reply.status(201).send(voucherOut(rows[0]));
    });

    app.put<{ Params: { id: string } }>(`${prefix}/:id`, opts, async (req) => {
      if (!UUID_RE.test(req.params.id)) throw notFound('Không tìm thấy voucher');
      const b = voucherBase.parse(req.body);
      checkVoucher(b);
      const o = own(req, 13);
      const r = await pool.query(
        `UPDATE vouchers SET type=$2, title=$3, description=$4, value=$5, max_discount=$6, min_order=$7, usage_limit=$8, per_user_limit=$9,
           starts_at=$10, ends_at=$11, active=$12, updated_at=now()
         WHERE id = $1 AND ${o.sql} RETURNING id`,
        [req.params.id, b.type, b.title, b.description, b.type === 'FREESHIP' ? 0 : b.value, b.maxDiscount ?? null, b.minOrder,
          b.usageLimit ?? null, b.perUserLimit ?? null, b.startsAt, b.endsAt, b.active, ...o.args],
      );
      if (!r.rowCount) throw notFound('Không tìm thấy voucher');
      const { rows } = await pool.query(`SELECT v.*, ${USED_SQL} FROM vouchers v WHERE id = $1`, [req.params.id]);
      return voucherOut(rows[0]);
    });

    app.delete<{ Params: { id: string } }>(`${prefix}/:id`, opts, async (req) => {
      if (!UUID_RE.test(req.params.id)) throw notFound('Không tìm thấy voucher');
      const o = own(req, 2);
      return withTx(pool, async (c) => {
        const cur = await c.query(`SELECT id FROM vouchers WHERE id = $1 AND ${o.sql} FOR UPDATE`, [req.params.id, ...o.args]);
        if (!cur.rowCount) throw notFound('Không tìm thấy voucher');
        const used = await c.query('SELECT 1 FROM redemptions WHERE voucher_id = $1 LIMIT 1', [req.params.id]);
        // Đã có lượt dùng → chỉ tắt (giữ lịch sử đối soát)
        if (used.rowCount) {
          await c.query('UPDATE vouchers SET active = false, updated_at = now() WHERE id = $1', [req.params.id]);
          return { ok: true, deactivated: true };
        }
        await c.query('DELETE FROM vouchers WHERE id = $1', [req.params.id]);
        return { ok: true, deleted: true };
      });
    });
  }

  voucherCrud('/seller/vouchers', seller, (req) => ({ scope: 'SHOP', shopId: shopOf(req) }));
  voucherCrud('/admin/vouchers', admin, () => ({ scope: 'PLATFORM', shopId: null }));

  // ---------------- Flash sale (admin) ----------------
  app.get('/admin/flash-sales', admin, async () => ({ items: await flashSalesOut('', []) }));

  async function saveItems(c: Parameters<Parameters<typeof withTx>[1]>[0], saleId: string, items: z.infer<typeof flashInput>['items']) {
    const skus = items.map((i) => i.skuId);
    if (new Set(skus).size !== skus.length) throw badRequest('SKU bị trùng trong chương trình flash sale');
    for (const i of items) {
      const cur = await c.query('SELECT id FROM flash_sale_items WHERE flash_sale_id = $1 AND sku_id = $2', [saleId, i.skuId]);
      if (cur.rows[0]) {
        const sold = (await flash.soldMany([cur.rows[0].id])).get(cur.rows[0].id) ?? 0;
        if (i.quota < sold) throw badRequest(`Quota của SKU ${i.skuId} không được nhỏ hơn số suất đã bán (${sold})`);
        await c.query('UPDATE flash_sale_items SET product_id=$2, sale_price=$3, quota=$4, per_user_limit=$5 WHERE id=$1', [
          cur.rows[0].id, i.productId, i.salePrice, i.quota, i.perUserLimit ?? null,
        ]);
      } else {
        await c.query(
          'INSERT INTO flash_sale_items (id, flash_sale_id, sku_id, product_id, sale_price, quota, per_user_limit) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [newId(), saleId, i.skuId, i.productId, i.salePrice, i.quota, i.perUserLimit ?? null],
        );
      }
    }
    const removed = await c.query(
      `SELECT i.id FROM flash_sale_items i WHERE i.flash_sale_id = $1 AND NOT (i.sku_id = ANY($2::text[]))`,
      [saleId, skus],
    );
    for (const r of removed.rows) {
      const held = await c.query('SELECT 1 FROM flash_sale_holds WHERE item_id = $1 LIMIT 1', [r.id]);
      if (held.rowCount) throw badRequest('Không thể bỏ SKU đã có người mua khỏi flash sale');
      await c.query('DELETE FROM flash_sale_items WHERE id = $1', [r.id]);
    }
  }

  app.post('/admin/flash-sales', admin, async (req, reply) => {
    const b = flashInput.parse(req.body);
    if (b.endsAt <= b.startsAt) throw badRequest('Thời gian kết thúc phải sau thời gian bắt đầu');
    const id = newId();
    await withTx(pool, async (c) => {
      await c.query('INSERT INTO flash_sales (id, name, starts_at, ends_at, active) VALUES ($1,$2,$3,$4,$5)', [id, b.name, b.startsAt, b.endsAt, b.active]);
      await saveItems(c, id, b.items);
    });
    return reply.status(201).send((await flashSalesOut('WHERE id = $1', [id]))[0]);
  });

  app.put<{ Params: { id: string } }>('/admin/flash-sales/:id', admin, async (req) => {
    if (!UUID_RE.test(req.params.id)) throw notFound('Không tìm thấy flash sale');
    const b = flashInput.parse(req.body);
    if (b.endsAt <= b.startsAt) throw badRequest('Thời gian kết thúc phải sau thời gian bắt đầu');
    await withTx(pool, async (c) => {
      const r = await c.query('UPDATE flash_sales SET name=$2, starts_at=$3, ends_at=$4, active=$5, updated_at=now() WHERE id=$1', [
        req.params.id, b.name, b.startsAt, b.endsAt, b.active,
      ]);
      if (!r.rowCount) throw notFound('Không tìm thấy flash sale');
      await saveItems(c, req.params.id, b.items);
    });
    return (await flashSalesOut('WHERE id = $1', [req.params.id]))[0];
  });

  app.delete<{ Params: { id: string } }>('/admin/flash-sales/:id', admin, async (req) => {
    if (!UUID_RE.test(req.params.id)) throw notFound('Không tìm thấy flash sale');
    // Không xoá cứng (giữ sổ suất đã bán) → tắt chương trình
    const r = await pool.query('UPDATE flash_sales SET active = false, updated_at = now() WHERE id = $1', [req.params.id]);
    if (!r.rowCount) throw notFound('Không tìm thấy flash sale');
    return { ok: true, deactivated: true };
  });
}
