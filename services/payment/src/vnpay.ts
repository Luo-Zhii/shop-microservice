import { createHmac, timingSafeEqual } from 'node:crypto';

/** Mã hoá giá trị đúng như demo chính thức VNPay 2.1.0 (encodeURIComponent, khoảng trắng → '+'). */
const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');

/** Chuỗi dữ liệu ký: các tham số vnp_* (trừ SecureHash/SecureHashType, bỏ giá trị rỗng) sắp theo tên, nối key=value&… */
export function signData(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((k) => k.startsWith('vnp_') && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType')
    .filter((k) => params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
    .sort()
    .map((k) => `${enc(k)}=${enc(String(params[k]))}`)
    .join('&');
}

export function sign(params: Record<string, unknown>, secret: string): string {
  return createHmac('sha512', secret).update(Buffer.from(signData(params), 'utf-8')).digest('hex');
}

export function verify(params: Record<string, unknown>, secret: string): boolean {
  const got = String(params.vnp_SecureHash ?? '').toLowerCase();
  const want = sign(params, secret);
  if (got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** yyyyMMddHHmmss theo giờ Việt Nam (GMT+7) như VNPay yêu cầu. */
export function vnpDate(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

export interface VnpayOptions {
  url: string;
  tmnCode: string;
  hashSecret: string;
  returnUrl: string;
  expireMinutes: number;
}

/** URL chuyển hướng sang cổng VNPay (sandbox mặc định), đã ký HMAC-SHA512. */
export function buildPaymentUrl(
  o: VnpayOptions,
  p: { txnRef: string; amount: number; orderInfo: string; ipAddr?: string; now?: Date; locale?: 'vn' | 'en' },
): string {
  const now = p.now ?? new Date();
  const params: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: o.tmnCode,
    vnp_Amount: String(p.amount * 100),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: p.txnRef,
    vnp_OrderInfo: p.orderInfo,
    vnp_OrderType: 'other',
    vnp_Locale: p.locale ?? 'vn',
    vnp_ReturnUrl: o.returnUrl,
    vnp_IpAddr: p.ipAddr ?? '127.0.0.1',
    vnp_CreateDate: vnpDate(now),
    vnp_ExpireDate: vnpDate(new Date(now.getTime() + o.expireMinutes * 60_000)),
  };
  return `${o.url}?${signData(params)}&vnp_SecureHash=${sign(params, o.hashSecret)}`;
}

/** Giao dịch thành công khi cả ResponseCode và TransactionStatus đều '00'. */
export const isSuccess = (q: Record<string, unknown>) => q.vnp_ResponseCode === '00' && (q.vnp_TransactionStatus ?? '00') === '00';
