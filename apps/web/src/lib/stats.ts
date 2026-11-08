import { asArray, pick } from './format';
import type { BarDatum } from '@/components/bar-chart';

export interface StatsView {
  series: BarDatum[];
  revenue: number;
  orders: number;
  byStatus: Record<string, number>;
  top: { productId?: string; title: string; qty: number; revenue: number; image?: string }[];
  raw: Record<string, unknown>;
}

/** Chuẩn hoá response thống kê (seller/admin) — tên trường chưa chốt trong hợp đồng nên đọc nhiều khả năng. */
export function normalizeStats(r: unknown): StatsView {
  const o = (r ?? {}) as Record<string, unknown>;
  const daily = asArray<Record<string, unknown>>(pick(o, 'revenueByDay', 'daily', 'byDay', 'series', 'days'));
  const series: BarDatum[] = daily.map((d) => {
    const date = String(d.date ?? d.day ?? d.label ?? '');
    const dt = new Date(date);
    const ok = !Number.isNaN(dt.getTime());
    return {
      label: ok ? `${dt.getDate()}/${dt.getMonth() + 1}` : date,
      sub: ok ? dt.toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' }) : date,
      value: Number(d.revenue ?? d.gmv ?? d.amount ?? d.total ?? 0),
    };
  });
  const rawStatus = pick<unknown>(o, 'ordersByStatus', 'byStatus', 'statusCounts', 'orderStatus');
  const byStatus: Record<string, number> = {};
  if (Array.isArray(rawStatus)) for (const s of rawStatus as { status: string; count?: number; n?: number }[]) byStatus[s.status] = Number(s.count ?? s.n ?? 0);
  else if (rawStatus && typeof rawStatus === 'object') Object.assign(byStatus, rawStatus);
  const top = asArray<Record<string, unknown>>(pick(o, 'topProducts', 'top', 'bestSellers')).map((t) => ({
    productId: t.productId as string | undefined,
    title: String(t.title ?? t.name ?? t.productId ?? 'Sản phẩm'),
    qty: Number(t.qty ?? t.sold ?? t.quantity ?? 0),
    revenue: Number(t.revenue ?? t.amount ?? 0),
    image: t.image as string | undefined,
  }));
  const revenue = Number(pick(o, 'revenue', 'totalRevenue', 'gmv') ?? series.reduce((n, s) => n + s.value, 0));
  const orders = Number(pick(o, 'orders', 'totalOrders', 'orderCount') ?? Object.values(byStatus).reduce((n, v) => n + Number(v), 0));
  return { series, revenue, orders, byStatus, top, raw: o };
}
