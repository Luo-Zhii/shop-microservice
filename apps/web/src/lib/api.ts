// Lớp gọi API qua gateway (/api/<svc>/...).
//
// Lưu phiên — trade-off:
//  * access token (15') chỉ giữ trong bộ nhớ → XSS không đọc được từ storage, mất khi tải lại trang.
//  * refresh token lưu localStorage để giữ đăng nhập qua lần tải lại. Rủi ro: script XSS đọc được.
//    Giảm thiểu: identity xoay vòng refresh token + phát hiện dùng lại thì thu hồi cả họ token;
//    CSP chặt ở gateway. Phương án an toàn hơn (cookie httpOnly SameSite=Strict do gateway đặt)
//    cần gateway hỗ trợ — chưa có trong hợp đồng hiện tại.
//  * giỏ khách: header x-cart-id (UUID sinh ở trình duyệt), gộp vào giỏ người dùng khi đăng nhập.
import { toast } from './toast';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api').replace(/\/$/, '');

const RT_KEY = 'shopnow.rt';
const CART_KEY = 'shopnow.cartId';

let accessToken: string | null = null;
const tokenListeners = new Set<(t: string | null) => void>();

export function getAccessToken() {
  return accessToken;
}
export function onTokenChange(l: (t: string | null) => void) {
  tokenListeners.add(l);
  return () => { tokenListeners.delete(l); };
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  return safeStorage()?.getItem(RT_KEY) ?? null;
}

export function setSession(at: string | null, rt?: string | null) {
  accessToken = at;
  const s = safeStorage();
  if (rt !== undefined) {
    if (rt) s?.setItem(RT_KEY, rt);
    else s?.removeItem(RT_KEY);
  }
  for (const l of tokenListeners) l(at);
}

export function getGuestCartId(): string {
  const s = safeStorage();
  let id = s?.getItem(CART_KEY);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    s?.setItem(CART_KEY, id);
  }
  return id;
}
export function peekGuestCartId(): string | null {
  return safeStorage()?.getItem(CART_KEY) ?? null;
}
export function setGuestCartId(id: string | null) {
  const s = safeStorage();
  if (id) s?.setItem(CART_KEY, id);
  else s?.removeItem(CART_KEY);
}

const MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Dữ liệu chưa hợp lệ',
  UNAUTHORIZED: 'Vui lòng đăng nhập',
  FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này',
  NOT_FOUND: 'Không tìm thấy dữ liệu',
  CONFLICT: 'Dữ liệu bị xung đột, vui lòng thử lại',
  INSUFFICIENT_STOCK: 'Sản phẩm không đủ tồn kho',
  RATE_LIMITED: 'Bạn thao tác quá nhanh, vui lòng thử lại sau',
  UPSTREAM_ERROR: 'Dịch vụ đang bận, vui lòng thử lại',
  INTERNAL: 'Lỗi hệ thống, vui lòng thử lại',
  NETWORK: 'Không kết nối được máy chủ',
};

export class ApiError extends Error {
  /** Mã chi tiết server gửi trong details.reason (EMAIL_NOT_VERIFIED, TOTP_REQUIRED, TOKEN_REUSED…) */
  reason?: string;
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
    const r = (details as { reason?: unknown } | undefined)?.reason;
    if (typeof r === 'string') this.reason = r;
  }
}

/** zod flatten() → câu lỗi đầu tiên của trường đầu tiên */
function firstFieldError(details: unknown): string | undefined {
  const d = details as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | undefined;
  const fe = d?.fieldErrors && Object.values(d.fieldErrors).find((v) => v?.length)?.[0];
  return fe ?? d?.formErrors?.[0];
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Đã có lỗi xảy ra';
}

function looksVietnamese(s: string) {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s);
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* không phải JSON */
  }
  const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  const code = err?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' : res.status === 404 ? 'NOT_FOUND'
    : res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'INTERNAL' : 'VALIDATION_ERROR');
  // Ưu tiên message tiếng Việt của server; nếu server trả tiếng Anh thì dùng câu chuẩn theo mã lỗi
  const field = code === 'VALIDATION_ERROR' ? firstFieldError(err?.details) : undefined;
  const base = err?.message && looksVietnamese(err.message) ? err.message : MESSAGES[code] ?? err?.message ?? `Lỗi ${res.status}`;
  const msg = field && looksVietnamese(field) ? field : base;
  return new ApiError(res.status, code, msg, err?.details);
}

let refreshing: Promise<boolean> | null = null;

/** Gọi POST /identity/auth/refresh; nhiều request 401 cùng lúc chỉ refresh một lần. */
export function refreshSession(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return Promise.resolve(false);
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_URL}/identity/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
        if (!res.ok) {
          // Chỉ xoá phiên khi server từ chối token (không xoá khi mạng lỗi / 5xx)
          if (res.status === 400 || res.status === 401 || res.status === 403) {
            const e = await toApiError(res);
            setSession(null, null);
            if (e.reason === 'TOKEN_REUSED') toast.error('Phiên đăng nhập đã bị thu hồi vì phát hiện đăng nhập bất thường. Vui lòng đăng nhập lại.');
            else if (e.status === 403) toast.error(e.message);
          }
          return false;
        }
        const data = (await res.json()) as { accessToken: string; refreshToken?: string };
        setSession(data.accessToken, data.refreshToken ?? rt);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** Không hiện toast khi lỗi. Mặc định: GET im lặng (hiển thị lỗi tại chỗ), thao tác ghi thì toast. */
  silent?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Gửi x-cart-id (giỏ khách) */
  cart?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = `${API_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const silent = opts.silent ?? method === 'GET';
  const doFetch = () => {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.cart && !accessToken) headers['x-cart-id'] = getGuestCartId();
    return fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  };

  try {
    let res = await doFetch();
    if (res.status === 401 && getRefreshToken() && !path.startsWith('/identity/auth/refresh')) {
      if (await refreshSession()) res = await doFetch();
    }
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (e) {
    const err = e instanceof ApiError ? e
      : (e as Error)?.name === 'AbortError' ? new ApiError(0, 'ABORTED', 'Đã huỷ')
      : new ApiError(0, 'NETWORK', MESSAGES.NETWORK);
    if (!silent && err.code !== 'ABORTED') toast.error(err.message);
    throw err;
  }
}

api.get = <T>(path: string, query?: RequestOptions['query'], o?: RequestOptions) => api<T>(path, { ...o, method: 'GET', query });
api.post = <T>(path: string, body?: unknown, o?: RequestOptions) => api<T>(path, { ...o, method: 'POST', body: body ?? {} });
api.put = <T>(path: string, body?: unknown, o?: RequestOptions) => api<T>(path, { ...o, method: 'PUT', body: body ?? {} });
api.del = <T>(path: string, o?: RequestOptions) => api<T>(path, { ...o, method: 'DELETE' });

/** Giải mã payload JWT (không xác minh chữ ký — chỉ để hiển thị role/shopId). */
export function decodeJwt<T = Record<string, unknown>>(token: string | null): T | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as T;
  } catch {
    return null;
  }
}

export function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** Upload ảnh: xin presigned URL rồi PUT thẳng lên MinIO/S3. */
export async function uploadImage(file: File): Promise<string> {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) throw new ApiError(400, 'VALIDATION_ERROR', 'Chỉ hỗ trợ ảnh JPG, PNG, WEBP, GIF');
  if (file.size > 5 * 1024 * 1024) throw new ApiError(400, 'VALIDATION_ERROR', 'Ảnh tối đa 5MB');
  const { uploadUrl, publicUrl } = await api.post<{ uploadUrl: string; publicUrl: string }>('/catalog/seller/uploads', { contentType: file.type });
  let res: Response;
  try {
    res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Không tải được ảnh lên kho lưu trữ');
  }
  if (!res.ok) throw new ApiError(res.status, 'UPSTREAM_ERROR', 'Tải ảnh lên thất bại');
  return publicUrl;
}
