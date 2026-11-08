import { Client } from '@opensearch-project/opensearch';
import { fold, PRICE_RANGES, type SearchDoc, type SearchEngine, type SearchItem, type SearchQuery, type SearchResult } from '../types';

type Json = Record<string, unknown>;

// ---------------- Mapping (thuần, test được) ----------------

const ANALYSIS = {
  filter: { autocomplete_edge: { type: 'edge_ngram', min_gram: 1, max_gram: 20 } },
  analyzer: {
    // asciifolding: "Áo thun" ≡ "ao thun" (cả "đ" → "d")
    vi_folding: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] },
    // edge_ngram cho gợi ý tiền tố: "ao th" khớp "áo thun"
    vi_autocomplete: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'autocomplete_edge'] },
  },
};

export function productIndexBody() {
  return {
    settings: { number_of_shards: 1, number_of_replicas: 1, analysis: ANALYSIS },
    mappings: {
      dynamic: 'strict',
      properties: {
        id: { type: 'keyword' },
        slug: { type: 'keyword' },
        title: {
          type: 'text',
          analyzer: 'vi_folding',
          fields: { suggest: { type: 'text', analyzer: 'vi_autocomplete', search_analyzer: 'vi_folding' }, raw: { type: 'keyword', ignore_above: 256 } },
        },
        brand: { type: 'text', analyzer: 'vi_folding' },
        shopId: { type: 'keyword' },
        shopName: { type: 'text', analyzer: 'vi_folding' },
        categoryId: { type: 'keyword' },
        categoryIds: { type: 'keyword' },
        /** "id|tên" cho terms aggregation (trả cả id lẫn tên danh mục) */
        categoryFacet: { type: 'keyword' },
        categoryText: { type: 'text', analyzer: 'vi_folding' },
        attributesText: { type: 'text', analyzer: 'vi_folding' },
        image: { type: 'keyword', index: false },
        minPrice: { type: 'long' },
        maxPrice: { type: 'long' },
        ratingAvg: { type: 'float' },
        ratingCount: { type: 'integer' },
        soldCount: { type: 'integer' },
        skuIds: { type: 'keyword' },
        inStock: { type: 'boolean' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
      },
    },
  };
}

export function queryIndexBody() {
  return {
    settings: { number_of_shards: 1, analysis: ANALYSIS },
    mappings: {
      properties: {
        q: { type: 'text', analyzer: 'vi_folding', fields: { suggest: { type: 'text', analyzer: 'vi_autocomplete', search_analyzer: 'vi_folding' } } },
        qFolded: { type: 'keyword' },
        hits: { type: 'long' },
        lastAt: { type: 'date' },
      },
    },
  };
}

export function toIndexDoc(d: SearchDoc, inStock: boolean) {
  return {
    id: d.id, slug: d.slug, title: d.title, brand: d.brand, shopId: d.shopId, shopName: d.shopName, categoryId: d.categoryId,
    categoryIds: d.categoryIds, categoryFacet: d.categoryIds.map((id, i) => `${id}|${d.categoryNames[i] ?? ''}`),
    categoryText: d.categoryNames.join(' '), attributesText: d.attributesText, image: d.image, minPrice: d.minPrice, maxPrice: d.maxPrice,
    ratingAvg: d.ratingAvg, ratingCount: d.ratingCount, soldCount: d.soldCount, skuIds: d.skuIds, inStock, createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

// ---------------- Dựng truy vấn (thuần, test được) ----------------

function priceFilter(q: SearchQuery): Json | null {
  if (q.minPrice === undefined && q.maxPrice === undefined) return null;
  const range: Json = {};
  if (q.minPrice !== undefined) range.gte = q.minPrice;
  if (q.maxPrice !== undefined) range.lte = q.maxPrice;
  return { range: { minPrice: range } };
}

function sortOf(q: SearchQuery, hasText: boolean): (Json | string)[] {
  switch (q.sort) {
    case 'price_asc':
      return [{ minPrice: 'asc' }, { soldCount: 'desc' }];
    case 'price_desc':
      return [{ minPrice: 'desc' }, { soldCount: 'desc' }];
    case 'newest':
      return [{ createdAt: 'desc' }];
    case 'best_selling':
      return [{ soldCount: 'desc' }, { ratingAvg: 'desc' }];
    default:
      return hasText ? ['_score', { soldCount: 'desc' }] : [{ soldCount: 'desc' }, { createdAt: 'desc' }];
  }
}

/**
 * bool query: multi_match fuzzy (sai chính tả nhẹ) + match_phrase tăng điểm; lọc ở `filter` (không tính điểm, cache được).
 * Lọc giá đặt ở post_filter để facet khoảng giá vẫn đếm đủ mọi khoảng; facet danh mục bọc filter giá để khớp kết quả.
 */
export function buildSearchBody(q: SearchQuery): Json {
  const text = q.q?.trim() ?? '';
  const filter: Json[] = [];
  if (q.categoryId) filter.push({ term: { categoryIds: q.categoryId } });
  if (q.shopId) filter.push({ term: { shopId: q.shopId } });
  if (q.rating !== undefined) filter.push({ range: { ratingAvg: { gte: q.rating } } });
  if (q.inStock) filter.push({ term: { inStock: true } });
  const must: Json[] = text
    ? [
        {
          multi_match: {
            query: text,
            fields: ['title^3', 'brand^2', 'categoryText', 'attributesText', 'shopName'],
            type: 'best_fields',
            operator: 'and',
            fuzziness: 'AUTO',
            prefix_length: 1,
          },
        },
      ]
    : [{ match_all: {} }];
  const should: Json[] = text ? [{ match_phrase: { title: { query: text, boost: 2 } } }] : [];
  const pf = priceFilter(q);
  return {
    from: (q.page - 1) * q.pageSize,
    size: q.pageSize,
    track_total_hits: true,
    query: { bool: { must, should, filter } },
    ...(pf ? { post_filter: pf } : {}),
    sort: sortOf(q, Boolean(text)),
    _source: ['id', 'slug', 'title', 'image', 'shopId', 'shopName', 'categoryId', 'minPrice', 'maxPrice', 'ratingAvg', 'ratingCount', 'soldCount', 'inStock'],
    aggs: {
      categories: { filter: pf ?? { match_all: {} }, aggs: { items: { terms: { field: 'categoryFacet', size: 30 } } } },
      priceRanges: {
        range: {
          field: 'minPrice',
          keyed: true,
          ranges: PRICE_RANGES.map((r) => ({ key: r.key, ...(r.min !== null ? { from: r.min } : {}), ...(r.max !== null ? { to: r.max } : {}) })),
        },
      },
    },
  };
}

export function buildSuggestBodies(prefix: string, limit: number) {
  const text = prefix.trim();
  return {
    products: {
      size: limit,
      _source: ['title'],
      query: text
        ? { bool: { should: [{ match: { 'title.suggest': { query: text, operator: 'and' } } }, { match: { title: { query: text, fuzziness: 'AUTO', prefix_length: 1 } } }], minimum_should_match: 1 } }
        : { match_none: {} },
      sort: ['_score', { soldCount: 'desc' }],
    },
    queries: {
      size: limit,
      _source: ['q'],
      query: text ? { match: { 'q.suggest': { query: text, operator: 'and' } } } : { match_all: {} },
      sort: text ? ['_score', { hits: 'desc' }] : [{ hits: 'desc' }],
    },
  };
}

interface Hit<T> {
  _id: string;
  _source: T;
}

export function parseSearchResponse(body: Json): SearchResult {
  const hits = (body.hits as { total: { value: number } | number; hits: Hit<Json>[] }) ?? { total: 0, hits: [] };
  const aggs = (body.aggregations ?? {}) as {
    categories?: { items?: { buckets: { key: string; doc_count: number }[] } };
    priceRanges?: { buckets: Record<string, { doc_count: number }> };
  };
  return {
    items: hits.hits.map((h) => {
      const s = h._source;
      return {
        id: String(s.id ?? h._id), slug: String(s.slug ?? ''), title: String(s.title ?? ''), image: (s.image as string) ?? null,
        shopId: String(s.shopId ?? ''), shopName: String(s.shopName ?? ''), categoryId: String(s.categoryId ?? ''),
        minPrice: Number(s.minPrice ?? 0), maxPrice: Number(s.maxPrice ?? 0), ratingAvg: Number(s.ratingAvg ?? 0),
        ratingCount: Number(s.ratingCount ?? 0), soldCount: Number(s.soldCount ?? 0), inStock: s.inStock !== false,
      } satisfies SearchItem;
    }),
    total: typeof hits.total === 'number' ? hits.total : (hits.total?.value ?? 0),
    facets: {
      categories: (aggs.categories?.items?.buckets ?? []).map((b) => {
        const i = b.key.indexOf('|');
        return { id: b.key.slice(0, i), name: b.key.slice(i + 1), count: b.doc_count };
      }),
      priceRanges: PRICE_RANGES.map((r) => ({ ...r, count: aggs.priceRanges?.buckets?.[r.key]?.doc_count ?? 0 })),
    },
  };
}

// ---------------- Engine ----------------

export class OpenSearchEngine implements SearchEngine {
  readonly name = 'opensearch' as const;
  private client: Client;
  readonly products: string;
  readonly stock: string;
  readonly queries: string;

  constructor(opts: { node: string; username?: string; password?: string; prefix: string; client?: Client }) {
    this.client = opts.client ?? new Client({ node: opts.node, ...(opts.username ? { auth: { username: opts.username, password: opts.password ?? '' } } : {}) });
    this.products = `${opts.prefix}products`;
    this.stock = `${opts.prefix}stock`;
    this.queries = `${opts.prefix}queries`;
  }

  async init() {
    const ensure = async (index: string, body: Json) => {
      const exists = await this.client.indices.exists({ index });
      if (!exists.body) await this.client.indices.create({ index, body });
    };
    await ensure(this.products, productIndexBody());
    await ensure(this.queries, queryIndexBody());
    await ensure(this.stock, { settings: { number_of_shards: 1 }, mappings: { properties: { available: { type: 'integer' } } } });
  }

  ping() {
    return this.client.ping();
  }

  private async inStockOf(skuIds: string[]) {
    if (skuIds.length === 0) return true;
    const r = await this.client.mget({ index: this.stock, body: { ids: skuIds } });
    const docs = ((r.body as { docs: { found: boolean; _source?: { available: number } }[] }).docs ?? []).filter((d) => d.found);
    return docs.length === 0 || docs.some((d) => (d._source?.available ?? 0) > 0);
  }

  async upsert(d: SearchDoc) {
    // external_gte theo updatedAt: bản cũ đến trễ bị từ chối (409) thay vì ghi đè bản mới.
    try {
      await this.client.index({
        index: this.products,
        id: d.id,
        body: toIndexDoc(d, await this.inStockOf(d.skuIds)),
        version: Date.parse(d.updatedAt),
        version_type: 'external_gte',
      });
    } catch (e) {
      if ((e as { meta?: { statusCode?: number } }).meta?.statusCode !== 409) throw e;
    }
  }

  async remove(productId: string) {
    try {
      await this.client.delete({ index: this.products, id: productId });
    } catch (e) {
      if ((e as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) throw e;
    }
  }

  async setRating(productId: string, ratingAvg: number, ratingCount: number) {
    await this.client.updateByQuery({
      index: this.products,
      body: { query: { term: { id: productId } }, script: { source: 'ctx._source.ratingAvg = params.a; ctx._source.ratingCount = params.c', params: { a: ratingAvg, c: ratingCount } } },
    });
  }

  async setStock(skuId: string, available: number) {
    await this.client.index({ index: this.stock, id: skuId, body: { available }, refresh: true });
    const r = await this.client.search({ index: this.products, body: { size: 50, _source: ['skuIds'], query: { term: { skuIds: skuId } } } });
    for (const h of (r.body as { hits: { hits: Hit<{ skuIds: string[] }>[] } }).hits.hits) {
      const inStock = await this.inStockOf(h._source.skuIds ?? []);
      await this.client.update({ index: this.products, id: h._id, body: { doc: { inStock } } });
    }
  }

  async search(q: SearchQuery) {
    const r = await this.client.search({ index: this.products, body: buildSearchBody(q) });
    return parseSearchResponse(r.body as Json);
  }

  async suggest(prefix: string, limit: number) {
    const b = buildSuggestBodies(prefix, limit);
    const res = await this.client.msearch({ body: [{ index: this.queries }, b.queries, { index: this.products }, b.products] });
    const [qs, ps] = (res.body as { responses: { hits?: { hits: Hit<{ q?: string; title?: string }>[] } }[] }).responses;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...(qs.hits?.hits ?? []).map((h) => h._source.q), ...(ps.hits?.hits ?? []).map((h) => h._source.title)]) {
      if (!s || seen.has(fold(s))) continue;
      seen.add(fold(s));
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  async recordQuery(q: string) {
    const display = q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    const f = fold(display);
    if (f.length < 2) return;
    await this.client.update({
      index: this.queries,
      id: f,
      body: {
        script: { source: 'ctx._source.hits += 1; ctx._source.lastAt = params.now; if (params.q != params.f) { ctx._source.q = params.q }', params: { now: new Date().toISOString(), q: display, f } },
        upsert: { q: display, qFolded: f, hits: 1, lastAt: new Date().toISOString() },
      },
      retry_on_conflict: 3,
    });
  }

  async close() {
    await this.client.close();
  }
}
