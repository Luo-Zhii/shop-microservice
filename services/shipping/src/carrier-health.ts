// SLO cho đối tác vận chuyển (giám sát phụ thuộc bên thứ ba) — hãng giao chậm/mất tín hiệu là sự cố KHÔNG nằm trong code của
// mình: mọi API vẫn trả 200, trace sạch, nhưng khách nhận hàng trễ và CSKH ngập khiếu nại. Đo từ chính dữ liệu vận đơn:
//   giao đúng hạn   DELIVERED trước created_at + eta_days + 12 giờ ân hạn (7 ngày gần nhất)
//   giao thất bại   FAILED / (DELIVERED + FAILED) trong 7 ngày
//   lấy hàng p90    CREATED → PICKED (7 ngày) — hãng không tới lấy là dấu hiệu sớm nhất
//   vận đơn kẹt     chưa kết thúc mà không đổi trạng thái > 48 giờ
//   webhook im lặng hãng còn vận đơn đang chạy mà > 6 giờ không gửi webhook nào → tích hợp hỏng, mình "mù" trạng thái
// Hãng xuống cấp (đủ mẫu mà dưới ngưỡng, webhook im lặng, hoặc flag `carrier-<mã>` tắt — kill switch GitOps) bị TRÁNH khi
// chọn hãng cho đơn MỚI (pricing.routing). Không bao giờ tránh hết: còn mỗi hãng xuống cấp thì vẫn chọn rẻ nhất như cũ.
import { gauge, isEnabled, type Pool } from '@shopnow/platform';
import { CARRIERS, routing, type Carrier } from './pricing';

export const POLICY = { minOnTime: 0.85, maxFailed: 0.1, minSample: 20, stuckHours: 48, webhookStaleHours: 6, graceHours: 12 };

export interface CarrierHealth {
  carrier: Carrier;
  name: string;
  enabled: boolean;
  delivered: number;
  onTime: number;
  onTimeRatio: number | null;
  finished: number;
  failed: number;
  failedRatio: number | null;
  pickupP90Hours: number | null;
  active: number;
  stuck: number;
  webhookAgeHours: number | null;
  degraded: boolean;
  avoided: boolean;
  reasons: string[];
}

type Row = { carrier: Carrier } & Record<string, unknown>;
const byCarrier = (rows: Row[]) => new Map(rows.map((r) => [r.carrier, r]));
const num = (v: unknown) => (v == null ? null : Number(v));

export async function carrierHealth(pool: Pool, policy = POLICY): Promise<CarrierHealth[]> {
  const [delivered, finished, pickup, active, hooks] = await Promise.all([
    pool.query<Row>(
      `SELECT s.carrier, count(*)::int AS delivered,
              count(*) FILTER (WHERE d.at <= s.created_at + make_interval(days => s.eta_days, hours => $1))::int AS on_time
         FROM shipments s
         JOIN LATERAL (SELECT min(at) AS at FROM shipment_events WHERE shipment_id = s.id AND status = 'DELIVERED') d ON d.at IS NOT NULL
        WHERE s.status = 'DELIVERED' AND s.updated_at > now() - interval '7 days'
        GROUP BY s.carrier`, [policy.graceHours]),
    pool.query<Row>(
      `SELECT carrier, count(*)::int AS finished, count(*) FILTER (WHERE status = 'FAILED')::int AS failed
         FROM shipments WHERE status IN ('DELIVERED','FAILED') AND updated_at > now() - interval '7 days' GROUP BY carrier`),
    pool.query<Row>(
      `SELECT s.carrier, percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM p.at - s.created_at)) / 3600 AS p90
         FROM shipments s JOIN shipment_events p ON p.shipment_id = s.id AND p.status = 'PICKED'
        WHERE p.at > now() - interval '7 days' GROUP BY s.carrier`),
    pool.query<Row>(
      `SELECT carrier, count(*)::int AS active,
              count(*) FILTER (WHERE updated_at < now() - make_interval(hours => $1))::int AS stuck
         FROM shipments WHERE status IN ('CREATED','PICKED','IN_TRANSIT') GROUP BY carrier`, [policy.stuckHours]),
    pool.query<Row>(
      `SELECT s.carrier, extract(epoch FROM now() - max(e.at)) / 3600 AS age
         FROM shipment_events e JOIN shipments s ON s.id = e.shipment_id
        WHERE e.source = 'carrier' AND e.at > now() - interval '7 days' GROUP BY s.carrier`),
  ]);
  const d = byCarrier(delivered.rows), f = byCarrier(finished.rows), p = byCarrier(pickup.rows), a = byCarrier(active.rows), h = byCarrier(hooks.rows);
  return (Object.keys(CARRIERS) as Carrier[]).map((carrier) => {
    const dv = Number(d.get(carrier)?.delivered ?? 0), ot = Number(d.get(carrier)?.on_time ?? 0);
    const fin = Number(f.get(carrier)?.finished ?? 0), fl = Number(f.get(carrier)?.failed ?? 0);
    const act = Number(a.get(carrier)?.active ?? 0), stuck = Number(a.get(carrier)?.stuck ?? 0);
    const p90 = num(p.get(carrier)?.p90), age = num(h.get(carrier)?.age);
    const enabled = isEnabled(`carrier-${carrier.toLowerCase()}`, true);
    const onTimeRatio = dv ? ot / dv : null, failedRatio = fin ? fl / fin : null;
    const reasons: string[] = [];
    if (!enabled) reasons.push('tắt bằng feature flag');
    if (dv >= policy.minSample && onTimeRatio! < policy.minOnTime) reasons.push(`đúng hạn ${Math.round(onTimeRatio! * 100)}% < ${policy.minOnTime * 100}%`);
    if (fin >= policy.minSample && failedRatio! > policy.maxFailed) reasons.push(`giao thất bại ${Math.round(failedRatio! * 100)}% > ${policy.maxFailed * 100}%`);
    // còn vận đơn đang chạy mà hãng im lặng (age null = cả 7 ngày không có webhook nào)
    if (act > 0 && (age == null || age > policy.webhookStaleHours)) reasons.push(age == null ? 'không nhận webhook nào trong 7 ngày' : `webhook im lặng ${Math.round(age)} giờ`);
    return {
      carrier, name: CARRIERS[carrier].name, enabled, delivered: dv, onTime: ot, onTimeRatio, finished: fin, failed: fl, failedRatio,
      pickupP90Hours: p90 == null ? null : Math.round(p90 * 10) / 10, active: act, stuck,
      webhookAgeHours: age == null ? null : Math.round(age * 10) / 10, degraded: reasons.length > 0, avoided: false, reasons,
    };
  });
}

const G = {
  onTime: () => gauge('shipping_carrier_on_time_ratio', 'Tỉ lệ giao đúng hạn 7 ngày theo hãng', ['carrier']),
  failed: () => gauge('shipping_carrier_failed_ratio', 'Tỉ lệ giao thất bại 7 ngày theo hãng', ['carrier']),
  pickup: () => gauge('shipping_carrier_pickup_p90_seconds', 'p90 thời gian tạo vận đơn → lấy hàng (7 ngày)', ['carrier']),
  stuck: () => gauge('shipping_carrier_stuck_shipments', 'Vận đơn chưa kết thúc, không đổi trạng thái > 48 giờ', ['carrier']),
  active: () => gauge('shipping_carrier_active_shipments', 'Vận đơn đang chạy theo hãng', ['carrier']),
  webhook: () => gauge('shipping_carrier_webhook_age_seconds', 'Thời gian từ webhook gần nhất của hãng', ['carrier']),
  degraded: () => gauge('shipping_carrier_degraded', '1 = hãng xuống cấp, bị tránh khi chọn hãng cho đơn mới', ['carrier']),
};

/** Tính sức khoẻ + cập nhật gauge + bảng tránh hãng dùng khi báo giá. Không bao giờ tránh hết mọi hãng. */
export async function refreshCarrierHealth(pool: Pool): Promise<CarrierHealth[]> {
  const items = await carrierHealth(pool);
  const healthy = items.filter((i) => !i.degraded);
  routing.avoid.clear();
  if (healthy.length > 0) for (const i of items) if (i.degraded) routing.avoid.set(i.carrier, i.reasons.join('; '));
  for (const i of items) {
    i.avoided = routing.avoid.has(i.carrier);
    const l = { carrier: i.carrier };
    if (i.onTimeRatio != null) G.onTime().set(l, i.onTimeRatio);
    if (i.failedRatio != null) G.failed().set(l, i.failedRatio);
    if (i.pickupP90Hours != null) G.pickup().set(l, i.pickupP90Hours * 3600);
    if (i.webhookAgeHours != null) G.webhook().set(l, i.webhookAgeHours * 3600);
    G.stuck().set(l, i.stuck);
    G.active().set(l, i.active);
    G.degraded().set(l, i.degraded ? 1 : 0);
  }
  routing.updatedAt = Date.now();
  return items;
}

export function startCarrierHealth(pool: Pool, log: { warn: (o: object, m: string) => void }, everyMs = 300_000) {
  const tick = () => refreshCarrierHealth(pool).catch((err) => log.warn({ err }, 'tính sức khoẻ hãng vận chuyển lỗi'));
  void tick();
  const t = setInterval(tick, everyMs);
  return () => clearInterval(t);
}
