import { migrate, type Pool } from '@shopnow/platform';
import { fold, PRICE_RANGES, type SearchDoc, type SearchEngine, type SearchItem, type SearchQuery, type SearchResult } from '../types';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** Dựng WHERE có tham số. `skip` bỏ bớt một chiều lọc (vd tính facet giá không áp bộ lọc giá). */
export function buildWhere(q: SearchQuery, skip: { price?: boolean } = {}) {
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const conds: string[] = [];
  const text = q.q ? fold(q.q) : '';
  if (text) {
    const words = text.split(' ').filter(Boolean).slice(0, 8);
    // Mỗi từ phải khớp đầu một từ trong tài liệu (không dấu, nên "ao th" khớp "Áo thun");
    // từ ≥ 4 ký tự được chấp nhận gần đúng theo trigram (gõ sai nhẹ: "thunn" ≈ "thun").
    for (const w of words) {
      const prefix = `doc_folded LIKE ${p(`% ${escapeLike(w)}%`)}`;
      conds.push(w.length >= 4 ? `(${prefix} OR ${p(w)} <% doc_folded)` : prefix);
    }
  }
  if (q.categoryId) conds.push(`${p(q.categoryId)} = ANY(category_ids)`);
  if (q.shopId) conds.push(`shop_id = ${p(q.shopId)}`);
  if (!skip.price && q.minPrice !== undefined) conds.push(`min_price >= ${p(q.minPrice)}`);
  if (!skip.price && q.maxPrice !== undefined) conds.push(`min_price <= ${p(q.maxPrice)}`);
  if (q.rating !== undefined) conds.push(`rating_avg >= ${p(q.rating)}`);
  if (q.inStock) conds.push('in_stock');
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params, text };
}

export function orderBy(q: SearchQuery, scoreExpr: string | null) {
  switch (q.sort) {
    case 'price_asc':
      return 'min_price ASC, sold_count DESC, product_id';
    case 'price_desc':
      return 'min_price DESC, sold_count DESC, product_id';
    case 'newest':
      return 'created_at DESC, product_id';
    case 'best_selling':
      return 'sold_count DESC, rating_avg DESC, product_id';
    default:
      return scoreExpr ? `${scoreExpr} DESC, sold_count DESC, product_id` : 'sold_count DESC, created_at DESC, product_id';
  }
}

interface Row {
  product_id: string;
  slug: string;
  title: string;
  image: string | null;
  shop_id: string;
  shop_name: string;
  category_id: string;
  min_price: number;
  max_price: number;
  rating_avg: number;
  rating_count: number;
  sold_count: number;
  in_stock: boolean;
  total_count: number;
}

const toItem = (r: Row): SearchItem => ({
  id: r.product_id, slug: r.slug, title: r.title, image: r.image, shopId: r.shop_id, shopName: r.shop_name, categoryId: r.category_id,
  minPrice: Number(r.min_price), maxPrice: Number(r.max_price), ratingAvg: Number(r.rating_avg), ratingCount: r.rating_count,
  soldCount: r.sold_count, inStock: r.in_stock,
});

const IN_STOCK_EXPR = `(NOT EXISTS (SELECT 1 FROM search_stock s WHERE s.sku_id = ANY(search_products.sku_ids))
   OR EXISTS (SELECT 1 FROM search_stock s WHERE s.sku_id = ANY(search_products.sku_ids) AND s.available > 0))`;

export class PostgresEngine implements SearchEngine {
  readonly name = 'postgres' as const;
  constructor(private pool: Pool, private migrationsDir: string) {}

  async init() {
    await migrate(this.pool, this.migrationsDir);
  }
  ping() {
    return this.pool.query('SELECT 1');
  }

  async upsert(d: SearchDoc) {
    // bọc khoảng trắng hai đầu để LIKE '% từ%' khớp đầu từ mà vẫn dùng được GIN trigram
    const docFolded = ` ${fold([d.title, d.brand ?? '', ...d.categoryNames, d.attributesText, d.shopName].join(' '))} `;
    // updated_at cũ hơn bản đang có → bỏ qua (sự kiện đến trễ / phát lại)
    await this.pool.query(
      `INSERT INTO search_products (product_id, slug, title, brand, shop_id, shop_name, category_id, category_ids, category_names, image,
         min_price, max_price, rating_avg, rating_count, sold_count, sku_ids, title_folded, doc_folded, created_at, updated_at, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
       ON CONFLICT (product_id) DO UPDATE SET slug=EXCLUDED.slug, title=EXCLUDED.title, brand=EXCLUDED.brand, shop_id=EXCLUDED.shop_id,
         shop_name=EXCLUDED.shop_name, category_id=EXCLUDED.category_id, category_ids=EXCLUDED.category_ids, category_names=EXCLUDED.category_names,
         image=EXCLUDED.image, min_price=EXCLUDED.min_price, max_price=EXCLUDED.max_price, rating_avg=EXCLUDED.rating_avg,
         rating_count=EXCLUDED.rating_count, sold_count=EXCLUDED.sold_count, sku_ids=EXCLUDED.sku_ids, title_folded=EXCLUDED.title_folded,
         doc_folded=EXCLUDED.doc_folded, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, indexed_at=now()
       WHERE search_products.updated_at <= EXCLUDED.updated_at`,
      [d.id, d.slug, d.title, d.brand, d.shopId, d.shopName, d.categoryId, d.categoryIds, d.categoryNames, d.image, d.minPrice, d.maxPrice,
        d.ratingAvg, d.ratingCount, d.soldCount, d.skuIds, fold(d.title), docFolded, d.createdAt, d.updatedAt],
    );
    await this.pool.query(`UPDATE search_products SET in_stock = ${IN_STOCK_EXPR} WHERE product_id = $1`, [d.id]);
  }

  async remove(productId: string) {
    await this.pool.query('DELETE FROM search_products WHERE product_id = $1', [productId]);
  }

  async setRating(productId: string, ratingAvg: number, ratingCount: number) {
    await this.pool.query('UPDATE search_products SET rating_avg = $2, rating_count = $3 WHERE product_id = $1', [productId, ratingAvg, ratingCount]);
  }

  async setStock(skuId: string, available: number) {
    await this.pool.query(
      `INSERT INTO search_stock (sku_id, available, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (sku_id) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
      [skuId, available],
    );
    await this.pool.query(`UPDATE search_products SET in_stock = ${IN_STOCK_EXPR} WHERE $1 = ANY(sku_ids)`, [skuId]);
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const { where, params, text } = buildWhere(q);
    let score: string | null = null;
    const listParams = [...params];
    if (text) {
      const i = listParams.push(text);
      const j = listParams.push(`%${escapeLike(text)}%`);
      score = `(word_similarity($${i}, title_folded) * 2 + word_similarity($${i}, doc_folded) + CASE WHEN title_folded LIKE $${j} THEN 1 ELSE 0 END)`;
    }
    const offset = (q.page - 1) * q.pageSize;
    const list = this.pool.query<Row>(
      `SELECT product_id, slug, title, image, shop_id, shop_name, category_id, min_price, max_price, rating_avg, rating_count, sold_count, in_stock,
              count(*) OVER() AS total_count
         FROM search_products ${where} ORDER BY ${orderBy(q, score)} LIMIT ${q.pageSize} OFFSET ${offset}`,
      listParams,
    );
    const cats = this.pool.query<{ id: string; name: string; count: number }>(
      `SELECT c.id, c.name, count(*)::int AS count
         FROM search_products CROSS JOIN LATERAL unnest(category_ids, category_names) AS c(id, name)
         ${where} GROUP BY c.id, c.name ORDER BY count DESC, c.name LIMIT 30`,
      params,
    );
    const pw = buildWhere(q, { price: true });
    const ranges = PRICE_RANGES.map((r, i) => {
      const conds = [r.min !== null ? `min_price >= ${r.min}` : null, r.max !== null ? `min_price < ${r.max}` : null].filter(Boolean).join(' AND ');
      return `count(*) FILTER (WHERE ${conds})::int AS r${i}`;
    });
    const prices = this.pool.query<Record<string, number>>(`SELECT ${ranges.join(', ')} FROM search_products ${pw.where}`, pw.params);
    const [l, c, pr] = await Promise.all([list, cats, prices]);
    let total = l.rows[0]?.total_count ?? 0;
    if (l.rows.length === 0 && offset > 0) total = (await this.pool.query(`SELECT count(*)::int n FROM search_products ${where}`, params)).rows[0].n;
    return {
      items: l.rows.map(toItem),
      total: Number(total),
      facets: {
        categories: c.rows,
        priceRanges: PRICE_RANGES.map((r, i) => ({ ...r, count: pr.rows[0][`r${i}`] ?? 0 })),
      },
    };
  }

  async suggest(prefix: string, limit: number) {
    const f = fold(prefix);
    if (!f) {
      const { rows } = await this.pool.query<{ q: string }>('SELECT q FROM search_queries ORDER BY hits DESC, last_at DESC LIMIT $1', [limit]);
      return rows.map((r) => r.q);
    }
    const like = escapeLike(f);
    const [queries, titles] = await Promise.all([
      this.pool.query<{ q: string }>(`SELECT q FROM search_queries WHERE q_folded LIKE $1 ORDER BY hits DESC, last_at DESC LIMIT $2`, [`${like}%`, limit]),
      this.pool.query<{ title: string }>(
        `SELECT title FROM search_products
          WHERE title_folded LIKE $1 OR title_folded LIKE $2 OR (length($3) >= 4 AND $3 <% title_folded)
          ORDER BY (title_folded LIKE $1) DESC, (title_folded LIKE $2) DESC, word_similarity($3, title_folded) DESC, sold_count DESC
          LIMIT $4`,
        [`${like}%`, `% ${like}%`, f, limit],
      ),
    ]);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...queries.rows.map((r) => r.q), ...titles.rows.map((r) => r.title)]) {
      const k = fold(s);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  async recordQuery(q: string) {
    const display = q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    const f = fold(display);
    if (f.length < 2) return;
    // ưu tiên lưu bản có dấu để gợi ý hiển thị đẹp
    await this.pool.query(
      `INSERT INTO search_queries (q_folded, q) VALUES ($1,$2)
       ON CONFLICT (q_folded) DO UPDATE SET hits = search_queries.hits + 1, last_at = now(),
         q = CASE WHEN EXCLUDED.q <> EXCLUDED.q_folded THEN EXCLUDED.q ELSE search_queries.q END`,
      [f, display],
    );
  }

  async close() {
    await this.pool.end();
  }
}
