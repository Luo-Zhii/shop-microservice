import type Redis from 'ioredis';
import {
  badRequest,
  conflict,
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
  type PoolClient,
} from '@shopnow/platform';

export const MAX_ADDRESSES = 10;
export const MAX_WISHLIST = 500;
export const RECENTLY_VIEWED_MAX = 50;
const RECENTLY_VIEWED_TTL = 90 * 24 * 3600;

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const text = (min: number, max: number, label: string) => z.string().trim().min(min, `${label} không hợp lệ`).max(max);
const phone = z.string().trim().regex(/^(0|\+84)\d{9,10}$/, 'Số điện thoại không hợp lệ');
const productId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'productId không hợp lệ');

const addressInput = z.object({
  fullName: text(2, 120, 'Họ tên người nhận'),
  phone,
  line1: text(3, 255, 'Địa chỉ'),
  ward: text(1, 120, 'Phường/xã'),
  district: text(1, 120, 'Quận/huyện'),
  province: text(1, 120, 'Tỉnh/thành'),
  isDefault: z.boolean().optional(),
});

const birthday = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày sinh dạng YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && d < new Date() && d.getUTCFullYear() >= 1900;
  }, 'Ngày sinh không hợp lệ');

const profileInput = z
  .object({
    fullName: text(2, 120, 'Họ tên'),
    phone: phone.nullable(),
    avatarUrl: z.string().url().max(500).regex(/^https?:\/\//, 'avatarUrl phải là http(s)').nullable(),
    gender: z.enum(['male', 'female', 'other']).nullable(),
    birthday: birthday.nullable(),
  })
  .partial()
  .strict();

const PROFILE_COLS = `user_id, email, full_name, phone, avatar_url, gender, to_char(birthday, 'YYYY-MM-DD') AS birthday, created_at, updated_at`;
const ADDRESS_COLS = 'id, user_id, full_name, phone, line1, ward, district, province, is_default, created_at, updated_at';

function profileOut(r: Record<string, any>) {
  return {
    userId: r.user_id,
    email: r.email,
    fullName: r.full_name,
    phone: r.phone,
    avatarUrl: r.avatar_url,
    gender: r.gender,
    birthday: r.birthday,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function addressOut(r: Record<string, any>) {
  return {
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    line1: r.line1,
    ward: r.ward,
    district: r.district,
    province: r.province,
    isDefault: r.is_default,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export function registerRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Auth; redis: Redis }) {
  const { pool, auth, redis } = deps;
  const authed = { preHandler: auth.authenticate };
  const uid = (req: FastifyRequest) => requireUser(req).id;
  const rvKey = (userId: string) => `rv:${userId}`;

  /** Hồ sơ tạo lười nếu sự kiện user.registered chưa tới kịp. */
  async function ensureProfile(db: Pool | PoolClient, req: FastifyRequest) {
    const u = requireUser(req);
    await db.query('INSERT INTO profiles (user_id, email) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING', [u.id, u.email]);
  }

  /** Khoá theo user để đếm/đặt mặc định địa chỉ không bị chạy đua. */
  const lockUser = (c: PoolClient, userId: string) => c.query(`SELECT pg_advisory_xact_lock(hashtext('addr:' || $1))`, [userId]);

  async function ownAddress(c: PoolClient | Pool, id: string, userId: string) {
    if (!isUuid(id)) throw notFound('Không tìm thấy địa chỉ');
    const { rows } = await c.query(`SELECT ${ADDRESS_COLS} FROM addresses WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!rows[0]) throw notFound('Không tìm thấy địa chỉ');
    return rows[0];
  }

  // ---------------- Hồ sơ ----------------
  app.get('/me/profile', authed, async (req) => {
    await ensureProfile(pool, req);
    const { rows } = await pool.query(`SELECT ${PROFILE_COLS} FROM profiles WHERE user_id = $1`, [uid(req)]);
    return profileOut(rows[0]);
  });

  app.put('/me/profile', authed, async (req) => {
    const b = profileInput.parse(req.body ?? {});
    const cols: Record<string, string> = { fullName: 'full_name', phone: 'phone', avatarUrl: 'avatar_url', gender: 'gender', birthday: 'birthday' };
    const sets: string[] = [];
    const args: unknown[] = [uid(req)];
    for (const [k, col] of Object.entries(cols)) {
      const v = (b as Record<string, unknown>)[k];
      if (v === undefined) continue;
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    }
    await ensureProfile(pool, req);
    const { rows } = await pool.query(
      `UPDATE profiles SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE user_id = $1 RETURNING ${PROFILE_COLS}`,
      args,
    );
    return profileOut(rows[0]);
  });

  // ---------------- Sổ địa chỉ ----------------
  app.get('/me/addresses', authed, async (req) => {
    const { rows } = await pool.query(`SELECT ${ADDRESS_COLS} FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`, [uid(req)]);
    return { items: rows.map(addressOut) };
  });

  app.get<{ Params: { id: string } }>('/me/addresses/:id', authed, async (req) => addressOut(await ownAddress(pool, req.params.id, uid(req))));

  app.post('/me/addresses', authed, async (req, reply) => {
    const b = addressInput.parse(req.body);
    const userId = uid(req);
    const row = await withTx(pool, async (c) => {
      await lockUser(c, userId);
      const n = (await c.query('SELECT count(*)::int n FROM addresses WHERE user_id = $1', [userId])).rows[0].n;
      if (n >= MAX_ADDRESSES) throw conflict(`Tối đa ${MAX_ADDRESSES} địa chỉ, hãy xoá bớt trước khi thêm`);
      const isDefault = b.isDefault === true || n === 0;
      if (isDefault) await c.query('UPDATE addresses SET is_default = false, updated_at = now() WHERE user_id = $1 AND is_default', [userId]);
      const { rows } = await c.query(
        `INSERT INTO addresses (id, user_id, full_name, phone, line1, ward, district, province, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${ADDRESS_COLS}`,
        [newId(), userId, b.fullName, b.phone, b.line1, b.ward, b.district, b.province, isDefault],
      );
      return rows[0];
    });
    return reply.status(201).send(addressOut(row));
  });

  app.put<{ Params: { id: string } }>('/me/addresses/:id', authed, async (req) => {
    const b = addressInput.parse(req.body);
    const userId = uid(req);
    const row = await withTx(pool, async (c) => {
      await lockUser(c, userId);
      const cur = await ownAddress(c, req.params.id, userId);
      // Bỏ tick mặc định ở địa chỉ đang mặc định thì vẫn giữ (luôn có đúng một mặc định) — đổi bằng cách đặt địa chỉ khác
      const makeDefault = b.isDefault === true && !cur.is_default;
      if (makeDefault) await c.query('UPDATE addresses SET is_default = false, updated_at = now() WHERE user_id = $1 AND is_default', [userId]);
      const { rows } = await c.query(
        `UPDATE addresses SET full_name=$3, phone=$4, line1=$5, ward=$6, district=$7, province=$8,
           is_default = is_default OR $9, updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING ${ADDRESS_COLS}`,
        [cur.id, userId, b.fullName, b.phone, b.line1, b.ward, b.district, b.province, makeDefault],
      );
      return rows[0];
    });
    return addressOut(row);
  });

  app.post<{ Params: { id: string } }>('/me/addresses/:id/default', authed, async (req) => {
    const userId = uid(req);
    const row = await withTx(pool, async (c) => {
      await lockUser(c, userId);
      const cur = await ownAddress(c, req.params.id, userId);
      await c.query('UPDATE addresses SET is_default = false, updated_at = now() WHERE user_id = $1 AND is_default AND id <> $2', [userId, cur.id]);
      const { rows } = await c.query(`UPDATE addresses SET is_default = true, updated_at = now() WHERE id = $1 RETURNING ${ADDRESS_COLS}`, [cur.id]);
      return rows[0];
    });
    return addressOut(row);
  });

  app.delete<{ Params: { id: string } }>('/me/addresses/:id', authed, async (req) => {
    const userId = uid(req);
    await withTx(pool, async (c) => {
      await lockUser(c, userId);
      const cur = await ownAddress(c, req.params.id, userId);
      await c.query('DELETE FROM addresses WHERE id = $1', [cur.id]);
      if (cur.is_default) {
        // Xoá địa chỉ mặc định → địa chỉ mới nhất còn lại thành mặc định
        await c.query(
          `UPDATE addresses SET is_default = true, updated_at = now()
            WHERE id = (SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
          [userId],
        );
      }
    });
    return { ok: true };
  });

  // ---------------- Wishlist ----------------
  app.get('/me/wishlist', authed, async (req) => {
    const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>);
    const userId = uid(req);
    const total = (await pool.query('SELECT count(*)::int n FROM wishlist WHERE user_id = $1', [userId])).rows[0].n;
    const { rows } = await pool.query(
      'SELECT product_id, created_at FROM wishlist WHERE user_id = $1 ORDER BY created_at DESC, product_id LIMIT $2 OFFSET $3',
      [userId, limit, offset],
    );
    return { items: rows.map((r) => ({ productId: r.product_id, createdAt: r.created_at.toISOString() })), page, pageSize, total };
  });

  app.get<{ Params: { productId: string } }>('/me/wishlist/:productId', authed, async (req) => {
    const r = await pool.query('SELECT 1 FROM wishlist WHERE user_id = $1 AND product_id = $2', [uid(req), req.params.productId]);
    return { productId: req.params.productId, inWishlist: Boolean(r.rowCount) };
  });

  app.post('/me/wishlist', authed, async (req, reply) => {
    const b = z.object({ productId }).parse(req.body);
    const userId = uid(req);
    const inserted = await withTx(pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('wish:' || $1))`, [userId]);
      const n = (await c.query('SELECT count(*)::int n FROM wishlist WHERE user_id = $1', [userId])).rows[0].n;
      const r = await c.query('INSERT INTO wishlist (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [userId, b.productId]);
      if (r.rowCount && n >= MAX_WISHLIST) throw conflict(`Danh sách yêu thích tối đa ${MAX_WISHLIST} sản phẩm`);
      return Boolean(r.rowCount);
    });
    return reply.status(inserted ? 201 : 200).send({ productId: b.productId, inWishlist: true });
  });

  app.delete<{ Params: { productId: string } }>('/me/wishlist/:productId', authed, async (req) => {
    await pool.query('DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2', [uid(req), req.params.productId]);
    return { ok: true };
  });

  // ---------------- Đã xem gần đây (Redis list, mới nhất trước, không trùng) ----------------
  app.post('/me/recently-viewed', authed, async (req, reply) => {
    const b = z.object({ productId }).parse(req.body);
    const key = rvKey(uid(req));
    try {
      await redis
        .multi()
        .lrem(key, 0, b.productId)
        .lpush(key, b.productId)
        .ltrim(key, 0, RECENTLY_VIEWED_MAX - 1)
        .expire(key, RECENTLY_VIEWED_TTL)
        .exec();
      return { ok: true };
    } catch (err) {
      // Tính năng phụ: Redis lỗi không làm hỏng trang sản phẩm
      req.log.warn({ err }, 'không ghi được recently-viewed');
      return reply.status(202).send({ ok: false });
    }
  });

  app.get('/me/recently-viewed', authed, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(RECENTLY_VIEWED_MAX, Math.max(1, Number.parseInt(q.limit ?? '', 10) || RECENTLY_VIEWED_MAX));
    try {
      return { items: await redis.lrange(rvKey(uid(req)), 0, limit - 1) };
    } catch (err) {
      req.log.warn({ err }, 'không đọc được recently-viewed');
      return { items: [], degraded: true };
    }
  });

  app.delete('/me/recently-viewed', authed, async (req) => {
    await redis.del(rvKey(uid(req)));
    return { ok: true };
  });

  // ---------------- Nội bộ: order lấy địa chỉ giao hàng ----------------
  app.get<{ Params: { id: string }; Querystring: { userId?: string } }>(
    '/internal/addresses/:id',
    { preHandler: auth.internalOnly },
    async (req) => {
      const userId = req.query.userId;
      if (!userId) throw badRequest('Thiếu userId');
      const a = addressOut(await ownAddress(pool, req.params.id, userId));
      return { id: a.id, userId, fullName: a.fullName, phone: a.phone, line1: a.line1, ward: a.ward, district: a.district, province: a.province, isDefault: a.isDefault };
    },
  );
}
