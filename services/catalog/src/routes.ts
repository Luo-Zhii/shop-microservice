import {
  badRequest,
  conflict,
  createEvent,
  enqueue,
  forbidden,
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
import { Topics } from '@shopnow/contracts';
import { categoryWithDescendants, loadProduct, loadProducts, refreshAndEmit } from './repo';
import type { createStorage } from './storage';

const variantInput = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1).max(64),
  options: z.record(z.string()).default({}),
  price: z.number().int().min(1000),
  compareAtPrice: z.number().int().nullable().optional(),
  weightGrams: z.number().int().min(1).max(50_000).default(200),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

const productInput = z.object({
  categoryId: z.string().uuid(),
  title: z.string().min(5).max(200),
  description: z.string().max(10_000).default(''),
  brand: z.string().max(80).nullable().optional(),
  attributes: z.record(z.string()).default({}),
  images: z.array(z.string().url()).max(9).default([]),
  variants: z.array(variantInput).min(1).max(100),
});

const categoryInput = z.object({
  name: z.string().min(2).max(80),
  parentId: z.string().uuid().nullable().optional(),
  icon: z.string().max(200).nullable().optional(),
  sort: z.number().int().default(0),
});

async function uniqueSlug(c: PoolClient, title: string, excludeId?: string) {
  const base = slugify(title) || 'san-pham';
  for (let i = 0; ; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const r = await c.query('SELECT 1 FROM products WHERE slug = $1 AND id IS DISTINCT FROM $2', [slug, excludeId ?? null]);
    if (r.rowCount === 0) return slug;
  }
}

async function upsertVariants(c: PoolClient, productId: string, variants: z.infer<typeof variantInput>[]) {
  const skus = variants.map((v) => v.sku);
  if (new Set(skus).size !== skus.length) throw badRequest('Mã SKU bị trùng trong sản phẩm');
  const keep: string[] = [];
  for (const v of variants) {
    const id = v.id ?? newId();
    keep.push(id);
    await c.query(
      `INSERT INTO variants (id, product_id, sku, options, price, compare_at_price, weight_grams, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, options = EXCLUDED.options, price = EXCLUDED.price,
         compare_at_price = EXCLUDED.compare_at_price, weight_grams = EXCLUDED.weight_grams, status = EXCLUDED.status
       WHERE variants.product_id = EXCLUDED.product_id`,
      [id, productId, v.sku, v.options, v.price, v.compareAtPrice ?? null, v.weightGrams, v.status],
    );
  }
  // Biến thể bị bỏ khỏi form → INACTIVE (giữ lại cho lịch sử đơn hàng)
  await c.query(`UPDATE variants SET status = 'INACTIVE' WHERE product_id = $1 AND NOT (id = ANY($2::uuid[]))`, [productId, keep]);
}

export function registerRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Auth; storage: ReturnType<typeof createStorage> }) {
  const { pool, auth, storage } = deps;
  const seller = { preHandler: auth.requireRole('seller') };
  const admin = { preHandler: auth.requireRole('admin') };

  // ---------------- Danh mục ----------------
  app.get('/categories', async () => {
    const { rows } = await pool.query('SELECT id, parent_id, name, slug, icon, sort FROM categories ORDER BY sort, name');
    const nodes = new Map(rows.map((r) => [r.id, { id: r.id, parentId: r.parent_id, name: r.name, slug: r.slug, icon: r.icon, children: [] as unknown[] }]));
    const roots: unknown[] = [];
    for (const n of nodes.values()) (n.parentId && nodes.get(n.parentId) ? nodes.get(n.parentId)!.children : roots).push(n);
    return { items: roots };
  });

  app.post('/admin/categories', admin, async (req, reply) => {
    const b = categoryInput.parse(req.body);
    const id = newId();
    await pool.query('INSERT INTO categories (id, parent_id, name, slug, icon, sort) VALUES ($1,$2,$3,$4,$5,$6)', [
      id, b.parentId ?? null, b.name, `${slugify(b.name)}-${id.slice(-4)}`, b.icon ?? null, b.sort,
    ]);
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>('/admin/categories/:id', admin, async (req) => {
    const b = categoryInput.parse(req.body);
    if (b.parentId === req.params.id) throw badRequest('Danh mục không thể là cha của chính nó');
    const r = await pool.query('UPDATE categories SET name=$2, parent_id=$3, icon=$4, sort=$5 WHERE id=$1', [
      req.params.id, b.name, b.parentId ?? null, b.icon ?? null, b.sort,
    ]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/admin/categories/:id', admin, async (req) => {
    const used = await pool.query('SELECT 1 FROM products WHERE category_id = $1 LIMIT 1', [req.params.id]);
    if (used.rowCount) throw conflict('Danh mục đang có sản phẩm');
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // ---------------- Sản phẩm (công khai) ----------------
  app.get('/products', { preHandler: auth.optionalAuth }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { page, pageSize, offset, limit } = parsePage(q);
    const where: string[] = [];
    const args: unknown[] = [];
    const isAdmin = req.user?.roles.includes('admin');
    const ownShop = req.user?.shopId && q.shopId === req.user.shopId;
    if (q.status && (isAdmin || ownShop)) {
      args.push(q.status);
      where.push(`p.status = $${args.length}`);
    } else if (!isAdmin && !ownShop) {
      where.push(`p.status = 'APPROVED' AND COALESCE(s.status, 'APPROVED') = 'APPROVED'`);
    }
    if (q.shopId) {
      args.push(q.shopId);
      where.push(`p.shop_id = $${args.length}`);
    }
    if (q.categoryId) {
      args.push(await categoryWithDescendants(pool, q.categoryId));
      where.push(`p.category_id = ANY($${args.length}::uuid[])`);
    }
    if (q.ids) {
      args.push(q.ids.split(',').filter(Boolean));
      where.push(`p.id = ANY($${args.length}::uuid[])`);
    }
    const order = { newest: 'p.created_at DESC', price_asc: 'p.min_price ASC', price_desc: 'p.min_price DESC', best_selling: 'p.sold_count DESC' }[
      q.sort ?? 'newest'
    ] ?? 'p.created_at DESC';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await pool.query(`SELECT count(*)::int n FROM products p LEFT JOIN shops_cache s ON s.shop_id = p.shop_id ${whereSql}`, args)).rows[0].n;
    args.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT p.id FROM products p LEFT JOIN shops_cache s ON s.shop_id = p.shop_id ${whereSql} ORDER BY ${order}, p.id LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return { items: await loadProducts(pool, rows.map((r) => r.id)), page, pageSize, total };
  });

  app.get<{ Params: { idOrSlug: string } }>('/products/:idOrSlug', { preHandler: auth.optionalAuth }, async (req) => {
    const p = await loadProduct(pool, req.params.idOrSlug);
    const canSeeHidden = req.user?.roles.includes('admin') || (req.user?.shopId && req.user.shopId === p?.shopId);
    if (!p || (p.status !== 'APPROVED' && !canSeeHidden)) throw notFound('Không tìm thấy sản phẩm');
    return p;
  });

  // ---------------- Người bán ----------------
  function shopOf(req: Parameters<typeof requireUser>[0]) {
    const u = requireUser(req);
    if (!u.shopId) throw forbidden('Tài khoản chưa có shop được duyệt');
    return u.shopId;
  }

  async function ownProduct(c: PoolClient | Pool, id: string, shopId: string) {
    const r = await c.query('SELECT id, status FROM products WHERE id = $1 AND shop_id = $2', [id, shopId]);
    if (!r.rows[0]) throw notFound('Không tìm thấy sản phẩm của shop');
    return r.rows[0] as { id: string; status: string };
  }

  app.get('/seller/products', seller, async (req) => {
    const shopId = shopOf(req);
    const q = req.query as Record<string, string | undefined>;
    const { page, pageSize, offset, limit } = parsePage(q);
    const args: unknown[] = [shopId];
    let filter = '';
    if (q.status) {
      args.push(q.status);
      filter = ' AND status = $2';
    }
    const total = (await pool.query(`SELECT count(*)::int n FROM products WHERE shop_id = $1${filter}`, args)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT id FROM products WHERE shop_id = $1${filter} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
      args,
    );
    return { items: await loadProducts(pool, rows.map((r) => r.id)), page, pageSize, total };
  });

  app.post('/seller/products', seller, async (req, reply) => {
    const shopId = shopOf(req);
    const b = productInput.parse(req.body);
    const id = newId();
    await withTx(pool, async (c) => {
      const cat = await c.query('SELECT 1 FROM categories WHERE id = $1', [b.categoryId]);
      if (!cat.rowCount) throw badRequest('Danh mục không tồn tại');
      const shop = await c.query('SELECT name FROM shops_cache WHERE shop_id = $1', [shopId]);
      await c.query(
        `INSERT INTO products (id, shop_id, shop_name, category_id, title, slug, description, brand, attributes, images, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT')`,
        [id, shopId, shop.rows[0]?.name ?? '', b.categoryId, b.title, await uniqueSlug(c, b.title), b.description, b.brand ?? null,
          b.attributes, JSON.stringify(b.images)],
      );
      await upsertVariants(c, id, b.variants);
      await refreshAndEmit(c, id);
    });
    return reply.status(201).send(await loadProduct(pool, id));
  });

  app.put<{ Params: { id: string } }>('/seller/products/:id', seller, async (req) => {
    const shopId = shopOf(req);
    const b = productInput.parse(req.body);
    await withTx(pool, async (c) => {
      const cur = await ownProduct(c, req.params.id, shopId);
      await c.query(
        `UPDATE products SET category_id=$2, title=$3, slug=$4, description=$5, brand=$6, attributes=$7, images=$8,
           status = CASE WHEN status = 'REJECTED' THEN 'DRAFT' ELSE status END
         WHERE id = $1`,
        [cur.id, b.categoryId, b.title, await uniqueSlug(c, b.title, cur.id), b.description, b.brand ?? null, b.attributes, JSON.stringify(b.images)],
      );
      await upsertVariants(c, cur.id, b.variants);
      await refreshAndEmit(c, cur.id);
    });
    return loadProduct(pool, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/seller/products/:id/submit', seller, async (req) => {
    const shopId = shopOf(req);
    await withTx(pool, async (c) => {
      const cur = await ownProduct(c, req.params.id, shopId);
      if (!['DRAFT', 'REJECTED', 'HIDDEN'].includes(cur.status)) throw conflict(`Không thể gửi duyệt sản phẩm ở trạng thái ${cur.status}`);
      await c.query(`UPDATE products SET status='PENDING', reject_reason=NULL WHERE id=$1`, [cur.id]);
      await refreshAndEmit(c, cur.id);
    });
    return { ok: true, status: 'PENDING' };
  });

  app.post<{ Params: { id: string } }>('/seller/products/:id/hide', seller, async (req) => {
    const shopId = shopOf(req);
    await withTx(pool, async (c) => {
      const cur = await ownProduct(c, req.params.id, shopId);
      await c.query(`UPDATE products SET status='HIDDEN' WHERE id=$1`, [cur.id]);
      await refreshAndEmit(c, cur.id);
    });
    return { ok: true, status: 'HIDDEN' };
  });

  app.delete<{ Params: { id: string } }>('/seller/products/:id', seller, async (req) => {
    const shopId = shopOf(req);
    await withTx(pool, async (c) => {
      const cur = await ownProduct(c, req.params.id, shopId);
      await c.query('DELETE FROM products WHERE id = $1', [cur.id]);
      await enqueue(c, Topics.catalogProduct, createEvent('product.deleted', 'catalog', cur.id, { productId: cur.id }));
    });
    return { ok: true };
  });

  app.post('/seller/uploads', seller, async (req) => {
    const shopId = shopOf(req);
    const { contentType } = z.object({ contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']) }).parse(req.body);
    return storage.presignUpload(shopId, contentType);
  });

  // ---------------- Admin duyệt sản phẩm ----------------
  app.get('/admin/products', admin, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { page, pageSize, offset, limit } = parsePage(q);
    const status = q.status ?? 'PENDING';
    const total = (await pool.query('SELECT count(*)::int n FROM products WHERE status = $1', [status])).rows[0].n;
    const { rows } = await pool.query('SELECT id FROM products WHERE status = $1 ORDER BY updated_at LIMIT $2 OFFSET $3', [status, limit, offset]);
    return { items: await loadProducts(pool, rows.map((r) => r.id)), page, pageSize, total };
  });

  for (const action of ['approve', 'reject', 'hide'] as const) {
    app.post<{ Params: { id: string } }>(`/admin/products/:id/${action}`, admin, async (req) => {
      const reason = action === 'approve' ? null : z.object({ reason: z.string().min(3).max(500) }).parse(req.body ?? {}).reason;
      const status = { approve: 'APPROVED', reject: 'REJECTED', hide: 'HIDDEN' }[action];
      await withTx(pool, async (c) => {
        const r = await c.query('UPDATE products SET status=$2, reject_reason=$3 WHERE id=$1', [req.params.id, status, reason]);
        if (!r.rowCount) throw notFound();
        await refreshAndEmit(c, req.params.id);
      });
      return { ok: true, status };
    });
  }

  // ---------------- Banner (CMS nhẹ) ----------------
  app.get('/banners', async () => {
    const { rows } = await pool.query('SELECT id, title, image_url, link_url, sort FROM banners WHERE active ORDER BY sort, created_at DESC');
    return { items: rows.map((r) => ({ id: r.id, title: r.title, imageUrl: r.image_url, linkUrl: r.link_url, sort: r.sort })) };
  });
  app.post('/admin/banners', admin, async (req, reply) => {
    const b = z.object({ title: z.string().min(2), imageUrl: z.string().url(), linkUrl: z.string().nullable().optional(), sort: z.number().int().default(0) }).parse(req.body);
    const id = newId();
    await pool.query('INSERT INTO banners (id, title, image_url, link_url, sort) VALUES ($1,$2,$3,$4,$5)', [id, b.title, b.imageUrl, b.linkUrl ?? null, b.sort]);
    return reply.status(201).send({ id });
  });
  app.delete<{ Params: { id: string } }>('/admin/banners/:id', admin, async (req) => {
    await pool.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // ---------------- Nội bộ: tra SKU cho cart / order ----------------
  app.post('/internal/skus', { preHandler: auth.internalOnly }, async (req) => {
    const { skuIds } = z.object({ skuIds: z.array(z.string().uuid()).max(500) }).parse(req.body);
    if (skuIds.length === 0) return { items: [] };
    const { rows } = await pool.query(
      `SELECT v.id, v.product_id, v.options, v.price, v.weight_grams, v.status, v.sku,
              p.shop_id, p.shop_name, p.title, p.images, p.status AS product_status, COALESCE(s.status,'APPROVED') AS shop_status
         FROM variants v JOIN products p ON p.id = v.product_id LEFT JOIN shops_cache s ON s.shop_id = p.shop_id
        WHERE v.id = ANY($1::uuid[])`,
      [skuIds],
    );
    return {
      items: rows.map((r) => ({
        skuId: r.id,
        sku: r.sku,
        productId: r.product_id,
        shopId: r.shop_id,
        shopName: r.shop_name,
        title: r.title,
        variantLabel: Object.values(r.options ?? {}).join(' / '),
        image: (r.images as string[])[0] ?? null,
        price: Number(r.price),
        weightGrams: r.weight_grams,
        status: r.status,
        productStatus: r.product_status,
        purchasable: r.status === 'ACTIVE' && r.product_status === 'APPROVED' && r.shop_status === 'APPROVED',
      })),
    };
  });
}
