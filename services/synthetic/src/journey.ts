// Hành trình mua hàng tổng hợp (synthetic transaction) đi qua gateway như một khách vãng lai:
//   home → search → product → cart_add → cart_view → cart_remove
// Dừng TRƯỚC checkout có chủ đích: checkout tạo đơn thật, giữ tồn kho, sinh bút toán kế toán và phiếu xuất kho → không
// được chạy trên prod. Luồng đặt hàng được giám sát bằng SLO order-saga-success trên traffic thật.
// Mỗi bước gắn với service chịu trách nhiệm (owner) → cảnh báo mang đúng nhãn service để AIOps mở sự cố và RCA.

export type StepName = 'home' | 'search' | 'product' | 'cart_add' | 'cart_view' | 'cart_remove';
export const STEP_SERVICE: Record<StepName, string> = {
  home: 'api-gateway', search: 'search', product: 'catalog', cart_add: 'cart', cart_view: 'cart', cart_remove: 'cart',
};

export interface StepResult { step: StepName; service: string; ok: boolean; status: number | null; ms: number; error?: string }
export interface JourneyResult { journey: 'browse_to_cart'; location: string; ok: boolean; startedAt: string; ms: number; steps: StepResult[]; failedStep: StepName | null }
export interface JourneyOptions { baseUrl: string; token?: string; query: string; timeoutMs: number; location: string; fetchImpl?: typeof fetch; now?: () => number }

class StepError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

export async function runJourney(o: JourneyOptions): Promise<JourneyResult> {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const startedAt = new Date().toISOString();
  const steps: StepResult[] = [];
  const base: Record<string, string> = { 'user-agent': 'ShopNowSynthetic/1.0 (+aiops)', accept: 'application/json' };
  if (o.token) base['x-synthetic-token'] = o.token;
  let cartId: string | undefined;

  async function call(step: StepName, path: string, init: RequestInit & { expect?: number[] } = {}) {
    const s = now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    try {
      const headers = { ...base, ...(cartId ? { 'x-cart-id': cartId } : {}), ...(init.headers as Record<string, string>) };
      const r = await f(o.baseUrl.replace(/\/$/, '') + path, { ...init, headers, signal: ctrl.signal });
      const body = r.headers.get('content-type')?.includes('json') ? await r.json().catch(() => null) : null;
      if (!(init.expect ?? [200]).includes(r.status)) throw new StepError(`HTTP ${r.status}`, r.status);
      steps.push({ step, service: STEP_SERVICE[step], ok: true, status: r.status, ms: Math.round(now() - s) });
      return { body: body as Record<string, unknown> | null, res: r };
    } catch (e) {
      const status = e instanceof StepError ? e.status : null;
      const msg = (e as Error).name === 'AbortError' ? `quá ${o.timeoutMs} ms` : (e as Error).message;
      steps.push({ step, service: STEP_SERVICE[step], ok: false, status, ms: Math.round(now() - s), error: msg.slice(0, 200) });
      throw new StepError(msg, status);
    } finally {
      clearTimeout(timer);
    }
  }
  const check = (step: StepName, cond: unknown, msg: string) => {
    if (!cond) {
      const last = steps[steps.length - 1];
      if (last?.step === step) Object.assign(last, { ok: false, error: msg });
      throw new StepError(msg, last?.status ?? null);
    }
  };

  try {
    const home = await call('home', '/api/bff/home');
    const first = ((home.body?.newProducts as { slug?: string; id?: string }[] | undefined) ?? [])[0];
    check('home', first, 'trang chủ không có sản phẩm mới');
    const search = await call('search', `/api/search/search?q=${encodeURIComponent(o.query)}&pageSize=5`);
    check('search', Array.isArray(search.body?.items), 'kết quả tìm kiếm sai định dạng');
    const product = await call('product', `/api/bff/products/${encodeURIComponent(first!.slug ?? first!.id ?? '')}`);
    const sku = ((product.body?.product as { variants?: { id: string }[] } | undefined)?.variants ?? [])[0]?.id;
    check('product', sku, 'sản phẩm không có biến thể để thêm vào giỏ');
    const add = await call('cart_add', '/api/cart/cart/items', {
      method: 'POST', body: JSON.stringify({ skuId: sku, qty: 1 }), headers: { 'content-type': 'application/json' },
    });
    cartId = add.res.headers.get('x-cart-id') ?? undefined;
    check('cart_add', cartId, 'không nhận được x-cart-id của giỏ khách');
    const view = await call('cart_view', '/api/cart/cart');
    check('cart_view', JSON.stringify(view.body ?? {}).includes(String(sku)), 'giỏ không chứa món vừa thêm');
    await call('cart_remove', `/api/cart/cart/items/${encodeURIComponent(String(sku))}`, { method: 'DELETE', expect: [200, 204] });
  } catch {
    // bước lỗi đã ghi vào steps; dừng hành trình ở đó
  }
  const failed = steps.find((s) => !s.ok);
  return { journey: 'browse_to_cart', location: o.location, ok: !failed && steps.length === 6, startedAt,
    ms: Math.round(now() - t0), steps, failedStep: failed?.step ?? null };
}
