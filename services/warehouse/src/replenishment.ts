import type { Pool, PoolClient } from '@shopnow/platform';

/**
 * Đề xuất nhập hàng (replenishment) từ thẻ kho — không cần dữ liệu ngoài:
 *  - nhu cầu ngày = số lượng ISSUE theo ngày (giờ VN) trong `days` ngày gần nhất, ngày không bán = 0
 *  - dự báo: làm mượt hàm mũ đơn (SES, α) — phản ứng nhanh hơn trung bình trượt khi nhu cầu đổi xu hướng
 *  - tồn an toàn SS = z · σ_ngày · √L (z = 1.65 ↔ mức phục vụ 95%), điểm đặt hàng lại ROP = d̂ · L + SS
 *  - đề xuất = max(0, ROP + d̂ · R − tồn khả dụng), R = chu kỳ xem xét; ABC theo giá trị xuất (80% / 95%)
 */
export interface ReplenishOptions { days?: number; leadTimeDays?: number; reviewDays?: number; alpha?: number; z?: number; shopId?: string }

export function ses(xs: number[], alpha: number) {
  if (!xs.length) return 0;
  return xs.reduce((f, x, i) => (i === 0 ? x : alpha * x + (1 - alpha) * f), 0);
}

export function std(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function abc(items: { key: string; value: number }[]) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  let cum = 0;
  const out = new Map<string, 'A' | 'B' | 'C'>();
  for (const i of [...items].sort((a, b) => b.value - a.value)) {
    const before = cum / total;
    cum += i.value;
    out.set(i.key, before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C');
  }
  return out;
}

export async function replenishment(db: Pool | PoolClient, o: ReplenishOptions = {}) {
  const days = o.days ?? 28;
  const L = o.leadTimeDays ?? 7;
  const R = o.reviewDays ?? 7;
  const alpha = o.alpha ?? 0.3;
  const z = o.z ?? 1.65;
  const demand = await db.query<{ shop_id: string; sku_id: string; d: number; qty: number; value: number }>(
    `SELECT shop_id, sku_id, ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - (at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS d,
            SUM(qty)::int AS qty, SUM(qty * unit_cost)::bigint AS value
       FROM stock_moves WHERE type = 'ISSUE' AND at >= now() - make_interval(days => $1) AND ($2::text IS NULL OR shop_id = $2)
      GROUP BY 1, 2, 3`, [days, o.shopId ?? null]);
  const stock = await db.query<{ shop_id: string; sku_id: string; available: number }>(
    `SELECT shop_id, sku_id, (SUM(qty - reserved) FILTER (WHERE bin <> 'QRT'))::int AS available FROM lots
      WHERE ($1::text IS NULL OR shop_id = $1) GROUP BY 1, 2`, [o.shopId ?? null]);
  const series = new Map<string, { shop: string; sku: string; daily: number[]; value: number }>();
  const key = (s: string, k: string) => `${s}|${k}`;
  for (const r of stock.rows) series.set(key(r.shop_id, r.sku_id), { shop: r.shop_id, sku: r.sku_id, daily: Array(days).fill(0), value: 0 });
  for (const r of demand.rows) {
    const k = key(r.shop_id, r.sku_id);
    if (!series.has(k)) series.set(k, { shop: r.shop_id, sku: r.sku_id, daily: Array(days).fill(0), value: 0 });
    const s = series.get(k)!;
    const idx = days - 1 - Number(r.d); // cũ → mới
    if (idx >= 0 && idx < days) s.daily[idx] += Number(r.qty);
    s.value += Number(r.value);
  }
  const avail = new Map(stock.rows.map((r) => [key(r.shop_id, r.sku_id), Number(r.available ?? 0)]));
  const cls = abc([...series.entries()].map(([k, s]) => ({ key: k, value: s.value })));
  const items = [...series.entries()].map(([k, s]) => {
    const forecast = ses(s.daily, alpha);
    const sigma = std(s.daily);
    const safety = Math.ceil(z * sigma * Math.sqrt(L));
    const rop = Math.ceil(forecast * L + safety);
    const available = avail.get(k) ?? 0;
    const suggest = Math.max(0, Math.ceil(rop + forecast * R - available));
    const cover = forecast > 0 ? +(available / forecast).toFixed(1) : null;
    return { shopId: s.shop, skuId: s.sku, abc: cls.get(k) ?? 'C', demand: s.daily.reduce((a, b) => a + b, 0),
      forecastPerDay: +forecast.toFixed(2), sigma: +sigma.toFixed(2), safetyStock: safety, reorderPoint: rop, available,
      daysOfCover: cover, suggestQty: suggest, status: available <= safety ? 'critical' : available <= rop ? 'reorder' : 'ok' };
  });
  const rank = { critical: 0, reorder: 1, ok: 2 } as const;
  items.sort((a, b) => rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank] || a.abc.localeCompare(b.abc) || b.suggestQty - a.suggestQty);
  return { params: { days, leadTimeDays: L, reviewDays: R, alpha, serviceLevelZ: z }, items };
}
