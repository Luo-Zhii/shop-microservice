import { createEvent, enqueue, type Pool, type PoolClient } from '@shopnow/platform';
import { Topics, type ProductSnapshot, type VariantSnapshot } from '@shopnow/contracts';

type Db = Pool | PoolClient;

interface ProductRow {
  id: string;
  shop_id: string;
  shop_name: string;
  category_id: string;
  title: string;
  slug: string;
  description: string;
  brand: string | null;
  attributes: Record<string, string>;
  images: string[];
  status: ProductSnapshot['status'];
  reject_reason: string | null;
  min_price: number;
  max_price: number;
  rating_avg: number;
  rating_count: number;
  sold_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function categoryPath(db: Db, categoryId: string): Promise<string[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, name, 0 AS depth FROM categories WHERE id = $1
       UNION ALL SELECT c.id, c.parent_id, c.name, up.depth + 1 FROM categories c JOIN up ON c.id = up.parent_id)
     SELECT name FROM up ORDER BY depth DESC`,
    [categoryId],
  );
  return rows.map((r) => r.name);
}

/** Danh sách id của danh mục và mọi danh mục con (lọc theo danh mục cha). */
export async function categoryWithDescendants(db: Db, categoryId: string): Promise<string[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE down AS (SELECT id FROM categories WHERE id = $1
       UNION ALL SELECT c.id FROM categories c JOIN down ON c.parent_id = down.id) SELECT id FROM down`,
    [categoryId],
  );
  return rows.map((r) => r.id);
}

function variantRow(v: Record<string, any>): VariantSnapshot {
  return {
    id: v.id,
    sku: v.sku,
    options: v.options ?? {},
    price: Number(v.price),
    compareAtPrice: v.compare_at_price == null ? null : Number(v.compare_at_price),
    weightGrams: v.weight_grams,
    status: v.status,
  };
}

export async function loadProducts(db: Db, ids: string[]): Promise<(ProductSnapshot & { rejectReason: string | null })[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<ProductRow>('SELECT * FROM products WHERE id = ANY($1::uuid[])', [ids]);
  const { rows: vrows } = await db.query('SELECT * FROM variants WHERE product_id = ANY($1::uuid[]) ORDER BY price, sku', [ids]);
  const paths = new Map<string, string[]>();
  for (const r of rows) if (!paths.has(r.category_id)) paths.set(r.category_id, await categoryPath(db, r.category_id));
  const byId = new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        shopId: r.shop_id,
        shopName: r.shop_name,
        categoryId: r.category_id,
        categoryPath: paths.get(r.category_id) ?? [],
        title: r.title,
        slug: r.slug,
        description: r.description,
        brand: r.brand,
        attributes: r.attributes,
        images: r.images,
        status: r.status,
        rejectReason: r.reject_reason,
        minPrice: Number(r.min_price),
        maxPrice: Number(r.max_price),
        ratingAvg: Number(r.rating_avg),
        ratingCount: r.rating_count,
        soldCount: r.sold_count,
        variants: vrows.filter((v) => v.product_id === r.id).map(variantRow),
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
}

export async function loadProduct(db: Db, idOrSlug: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const { rows } = await db.query('SELECT id FROM products WHERE ' + (isUuid ? 'id = $1' : 'slug = $1'), [idOrSlug]);
  if (!rows[0]) return undefined;
  return (await loadProducts(db, [rows[0].id]))[0];
}

/** Tính lại khoảng giá rồi phát product.upserted qua outbox (cùng transaction). */
export async function refreshAndEmit(c: PoolClient, productId: string) {
  await c.query(
    `UPDATE products p SET
       min_price = COALESCE((SELECT min(price) FROM variants WHERE product_id = p.id AND status = 'ACTIVE'), 0),
       max_price = COALESCE((SELECT max(price) FROM variants WHERE product_id = p.id AND status = 'ACTIVE'), 0),
       updated_at = now()
     WHERE id = $1`,
    [productId],
  );
  const p = await loadProduct(c, productId);
  if (!p) return;
  const { rejectReason: _r, ...snapshot } = p;
  await enqueue(c, Topics.catalogProduct, createEvent('product.upserted', 'catalog', p.id, snapshot));
}
