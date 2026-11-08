import { upstream } from './errors';
import { counter } from './metrics';

export interface ClientOptions {
  name: string;
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  internalToken?: string;
  /** số lỗi liên tiếp để mở mạch, thời gian mở (ms) */
  breaker?: { failureThreshold: number; openMs: number };
}

type BreakerState = { failures: number; openUntil: number };

/**
 * HTTP client giữa các service: timeout, retry có backoff cho request idempotent (GET/PUT/DELETE),
 * circuit breaker đơn giản để không dồn tải vào service đang chết.
 */
export function serviceClient(opts: ClientOptions) {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const retries = opts.retries ?? 2;
  const breaker = opts.breaker ?? { failureThreshold: 5, openMs: 10_000 };
  const state: BreakerState = { failures: 0, openUntil: 0 };
  const calls = counter('http_client_requests_total', 'Gọi HTTP giữa service', ['target', 'result']);

  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    if (Date.now() < state.openUntil) {
      calls.inc({ target: opts.name, result: 'circuit_open' });
      throw upstream(`${opts.name} tạm thời không khả dụng (circuit open)`);
    }
    const idempotent = method !== 'POST' && method !== 'PATCH';
    let lastErr: unknown;
    for (let attempt = 0; attempt <= (idempotent ? retries : 0); attempt++) {
      try {
        const res = await fetch(`${opts.baseUrl}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            ...(opts.internalToken ? { 'x-internal-token': opts.internalToken } : {}),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : undefined;
        if (res.status >= 500) throw Object.assign(new Error(`${opts.name} ${res.status}`), { json, status: res.status });
        state.failures = 0;
        if (!res.ok) {
          calls.inc({ target: opts.name, result: 'client_error' });
          const err = json?.error ?? {};
          const e = upstream(err.message ?? `${opts.name} trả ${res.status}`, err);
          (e as { statusCode: number }).statusCode = res.status;
          (e as { code: string }).code = err.code ?? 'UPSTREAM_ERROR';
          throw Object.assign(e, { passthrough: true });
        }
        calls.inc({ target: opts.name, result: 'ok' });
        return json as T;
      } catch (e) {
        if ((e as { passthrough?: boolean }).passthrough) throw e;
        lastErr = e;
        if (attempt < (idempotent ? retries : 0)) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
    state.failures += 1;
    if (state.failures >= breaker.failureThreshold) state.openUntil = Date.now() + breaker.openMs;
    calls.inc({ target: opts.name, result: 'error' });
    throw upstream(`Không gọi được ${opts.name}: ${(lastErr as Error)?.message ?? 'unknown'}`);
  }

  return {
    get: <T>(p: string, h?: Record<string, string>) => request<T>('GET', p, undefined, h),
    post: <T>(p: string, b?: unknown, h?: Record<string, string>) => request<T>('POST', p, b, h),
    put: <T>(p: string, b?: unknown, h?: Record<string, string>) => request<T>('PUT', p, b, h),
    del: <T>(p: string, h?: Record<string, string>) => request<T>('DELETE', p, undefined, h),
  };
}
export type ServiceClient = ReturnType<typeof serviceClient>;
