import { counter, serviceClient, type FastifyInstance, type FastifyRequest, type ServiceClient } from '@shopnow/platform';
import type { Upstreams } from './config';

/** Lấy mảng từ phản hồi dạng `[...]` hoặc `{ items: [...] }`. */
export function itemsOf<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  const items = (v as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

interface ProductLike {
  id: string;
  variants?: { id: string }[];
}

type Tasks = Record<string, Promise<unknown>>;
type Settled<T extends Tasks> = { [K in keyof T]: Awaited<T[K]> | null } & { errors: Partial<Record<keyof T, unknown>> };

const bffDegraded = () => counter('bff_degraded_total', 'Số lần BFF trả kết quả thiếu nguồn', ['endpoint', 'source']);

/** Chạy song song; nguồn lỗi → null + ghi tên vào degraded (không làm hỏng cả trang). */
async function settle<T extends Tasks>(req: FastifyRequest, endpoint: string, tasks: T, degraded: string[]): Promise<Settled<T>> {
  const keys = Object.keys(tasks);
  const results = await Promise.allSettled(Object.values(tasks));
  const errors: Record<string, unknown> = {};
  const out: Record<string, unknown> = { errors };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[keys[i]] = r.value;
    else {
      out[keys[i]] = null;
      errors[keys[i]] = r.reason;
      degraded.push(keys[i]);
      bffDegraded().inc({ endpoint, source: keys[i] });
      req.log.warn({ source: keys[i], err: (r.reason as Error)?.message }, 'BFF: nguồn phụ lỗi, trả kết quả thiếu');
    }
  });
  return out as Settled<T>;
}

export function registerBff(app: FastifyInstance, deps: { upstreams: Upstreams; timeoutMs: number }) {
  const mk = (name: string, baseUrl: string): ServiceClient =>
    serviceClient({ name, baseUrl, timeoutMs: deps.timeoutMs, retries: 0, breaker: { failureThreshold: 5, openMs: 10_000 } });
  const catalog = mk('catalog', deps.upstreams.catalog);
  const promotion = mk('promotion', deps.upstreams.promotion);
  const inventory = mk('inventory', deps.upstreams.inventory);
  const review = mk('review', deps.upstreams.review);
  const ai = mk('ai', deps.upstreams.ai);

  /** Chuyển tiếp token + request-id để trace nối liền và service tự phân quyền. */
  const fwd = (req: FastifyRequest) => {
    const h: Record<string, string> = { 'x-request-id': req.id };
    if (req.headers.authorization) h.authorization = req.headers.authorization;
    return h;
  };

  app.get('/api/bff/home', async (req) => {
    const h = fwd(req);
    const degraded: string[] = [];
    const userId = req.user?.id;
    const r = await settle(
      req,
      'home',
      {
        newProducts: catalog.get('/products?sort=newest&pageSize=12', h),
        banners: catalog.get('/banners', h),
        categories: catalog.get('/categories', h),
        flashSales: promotion.get('/flash-sales/active', h),
        recommendations: userId ? ai.get(`/recommendations/user/${encodeURIComponent(userId)}?limit=12`, h) : Promise.resolve(null),
      },
      degraded,
    );
    // Chỉ catalog (danh sách sản phẩm) là nguồn bắt buộc
    if (r.errors.newProducts) throw r.errors.newProducts;
    return {
      banners: itemsOf(r.banners),
      flashSales: itemsOf(r.flashSales),
      categories: itemsOf(r.categories),
      recommendations: itemsOf(r.recommendations),
      newProducts: itemsOf(r.newProducts),
      degraded,
    };
  });

  app.get<{ Params: { idOrSlug: string } }>('/api/bff/products/:idOrSlug', async (req) => {
    const h = fwd(req);
    // Lỗi catalog (404, chết…) → trả lỗi luôn
    const product = await catalog.get<ProductLike>(`/products/${encodeURIComponent(req.params.idOrSlug)}`, h);
    const skuIds = (product.variants ?? []).map((v) => v.id);
    const degraded: string[] = [];
    const r = await settle(
      req,
      'product',
      {
        stock: skuIds.length ? inventory.get(`/stock?skuIds=${skuIds.map(encodeURIComponent).join(',')}`, h) : Promise.resolve([]),
        reviewSummary: review.get(`/products/${encodeURIComponent(product.id)}/summary`, h),
        flashSales: promotion.get('/flash-sales/active', h),
        recommendations: ai.get(`/recommendations/product/${encodeURIComponent(product.id)}?limit=12`, h),
      },
      degraded,
    );
    // Flash sale đang chạy có chứa sản phẩm / SKU này (không phụ thuộc chi tiết schema của promotion)
    const ids = [product.id, ...skuIds];
    const flashSale = itemsOf(r.flashSales).find((fs) => {
      const s = JSON.stringify(fs);
      return ids.some((id) => s.includes(`"${id}"`));
    }) ?? null;
    return {
      product,
      stock: r.stock === null ? null : itemsOf(r.stock),
      reviewSummary: r.reviewSummary,
      flashSale,
      recommendations: itemsOf(r.recommendations),
      degraded,
    };
  });
}
