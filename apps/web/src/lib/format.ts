import type { OrderStatus, ProductLike, ProductStatus, Shipment, ShopStatus } from './types';

const vnd = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('vi-VN');

/** 159000 → "159.000 ₫" */
export function formatVND(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return vnd.format(Math.round(v)).replace(/ /g, ' ');
}

export function formatNumber(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '0';
  return num.format(v);
}

/** 1250 → "1,2k" */
export function formatCompact(v: number | null | undefined): string {
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}tr`;
  if (v >= 1000) return `${(v / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}k`;
  return String(v);
}

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('vi-VN', withTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} ngày trước`;
  return formatDate(iso, false);
}

export function toDateTimeLocal(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Chờ xử lý', tone: 'neutral' },
  AWAITING_PAYMENT: { label: 'Chờ thanh toán', tone: 'warning' },
  CONFIRMED: { label: 'Chờ lấy hàng', tone: 'info' },
  SHIPPING: { label: 'Đang giao', tone: 'info' },
  DELIVERED: { label: 'Đã giao', tone: 'success' },
  COMPLETED: { label: 'Hoàn thành', tone: 'success' },
  CANCELLED: { label: 'Đã huỷ', tone: 'danger' },
  RETURN_REQUESTED: { label: 'Yêu cầu trả hàng', tone: 'warning' },
  RETURNED: { label: 'Đã trả hàng', tone: 'neutral' },
};

export const PRODUCT_STATUS: Record<ProductStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Nháp', tone: 'neutral' },
  PENDING: { label: 'Chờ duyệt', tone: 'warning' },
  APPROVED: { label: 'Đang bán', tone: 'success' },
  REJECTED: { label: 'Bị từ chối', tone: 'danger' },
  HIDDEN: { label: 'Đã ẩn', tone: 'neutral' },
};

export const SHOP_STATUS: Record<ShopStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Chờ duyệt', tone: 'warning' },
  APPROVED: { label: 'Đang hoạt động', tone: 'success' },
  REJECTED: { label: 'Bị từ chối', tone: 'danger' },
  SUSPENDED: { label: 'Tạm khoá', tone: 'neutral' },
};

export const SHIPMENT_STATUS: Record<Shipment['status'], string> = {
  CREATED: 'Đã tạo vận đơn',
  PICKED: 'Đã lấy hàng',
  IN_TRANSIT: 'Đang vận chuyển',
  DELIVERED: 'Giao thành công',
  FAILED: 'Giao thất bại',
};

export const PAYMENT_METHOD: Record<string, string> = {
  COD: 'Thanh toán khi nhận hàng',
  MOCK: 'Cổng thử nghiệm (Mock)',
  VNPAY: 'VNPay',
};

export function statusOf<T extends string>(map: Record<T, { label: string; tone: Tone }>, s: string | undefined) {
  return (s && (map as Record<string, { label: string; tone: Tone }>)[s]) || { label: s ?? '—', tone: 'neutral' as Tone };
}

// ---------- Chuẩn hoá dữ liệu lỏng ----------

/** Nhận mảng hoặc {items}/{data}/{results} — tránh crash khi hợp đồng lệch nhẹ. */
export function asArray<T>(v: unknown, ...keys: string[]): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of [...keys, 'items', 'data', 'results']) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

export function pick<T>(o: unknown, ...keys: string[]): T | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k] as T;
  return undefined;
}

export function productImage(p: Partial<ProductLike> | undefined | null): string | undefined {
  if (!p) return undefined;
  return p.image ?? p.images?.[0] ?? undefined;
}

export function productHref(p: Partial<ProductLike> & { productId?: string }): string {
  return `/product/${encodeURIComponent(p.slug || p.productId || p.id || '')}`;
}

export function variantLabel(options: Record<string, string> | undefined): string {
  if (!options) return '';
  return Object.entries(options).map(([k, v]) => `${k}: ${v}`).join(', ');
}

export function totalPages(total: number | undefined, pageSize: number): number {
  return Math.max(1, Math.ceil((total ?? 0) / pageSize));
}
