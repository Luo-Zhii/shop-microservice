import { counter, parsePage, z, type FastifyInstance, type Logger } from '@shopnow/platform';
import { SORTS, type SearchEngine, type SearchQuery } from './types';

const num = z.coerce.number().int().min(0);
const searchQuery = z.object({
  q: z.string().max(200).optional(),
  categoryId: z.string().max(64).optional(),
  shopId: z.string().max(64).optional(),
  minPrice: num.optional(),
  maxPrice: num.optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(SORTS).default('relevance'),
});

export const searchRequests = () => counter('search_requests_total', 'Số request tìm kiếm', ['engine', 'endpoint']);

export function parseSearchQuery(raw: Record<string, unknown>): SearchQuery {
  const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined));
  const b = searchQuery.parse(clean);
  const { page, pageSize } = parsePage(raw, 60);
  return {
    q: b.q?.trim() || undefined,
    categoryId: b.categoryId,
    shopId: b.shopId,
    minPrice: b.minPrice,
    maxPrice: b.maxPrice,
    rating: b.rating,
    inStock: b.inStock === 'true' || undefined,
    sort: b.sort,
    page,
    pageSize,
  };
}

export function registerRoutes(app: FastifyInstance, deps: { engine: SearchEngine; log: Logger }) {
  const { engine, log } = deps;

  app.get('/search', async (req) => {
    searchRequests().inc({ engine: engine.name, endpoint: 'search' });
    const q = parseSearchQuery(req.query as Record<string, unknown>);
    const r = await engine.search(q);
    // chỉ ghi nhận truy vấn có kết quả để gợi ý không bị rác
    if (q.q && r.total > 0 && q.page === 1) engine.recordQuery(q.q).catch((err) => log.warn({ err }, 'không ghi được truy vấn phổ biến'));
    return { items: r.items, total: r.total, page: q.page, pageSize: q.pageSize, facets: r.facets };
  });

  app.get('/suggest', async (req) => {
    searchRequests().inc({ engine: engine.name, endpoint: 'suggest' });
    const q = z.object({ q: z.string().max(100).default(''), limit: z.coerce.number().int().min(1).max(20).default(8) }).parse(req.query);
    return { suggestions: await engine.suggest(q.q, q.limit) };
  });
}
