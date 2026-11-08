import { randomBytes } from 'node:crypto';
import { conflict, createEvent, enqueue, notFound, type Pool, type PoolClient } from '@shopnow/platform';
import { Topics, type ShipmentEvent } from '@shopnow/contracts';
import { CARRIERS, type Carrier } from './pricing';

export type Status = 'CREATED' | 'PICKED' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
type Db = Pool | PoolClient;

const FLOW: Status[] = ['CREATED', 'PICKED', 'IN_TRANSIT', 'DELIVERED'];
const TERMINAL: Status[] = ['DELIVERED', 'FAILED', 'CANCELLED'];
const EVENT_TYPE: Partial<Record<Status, string>> = {
  PICKED: 'shipment.picked',
  IN_TRANSIT: 'shipment.in_transit',
  DELIVERED: 'shipment.delivered',
  FAILED: 'shipment.failed',
};
export const STATUS_LABEL: Record<Status, string> = {
  CREATED: 'Đã tạo vận đơn, chờ lấy hàng',
  PICKED: 'Đã lấy hàng',
  IN_TRANSIT: 'Đang vận chuyển',
  DELIVERED: 'Giao hàng thành công',
  FAILED: 'Giao hàng thất bại',
  CANCELLED: 'Đã huỷ vận đơn',
};

export interface ShipmentRow {
  id: string;
  order_id: string;
  checkout_id: string | null;
  buyer_id: string;
  shop_id: string;
  carrier: Carrier;
  tracking_code: string;
  fee: number;
  cod_amount: number;
  weight_grams: number;
  eta_days: number;
  from_province: string;
  to_province: string;
  ship_to: unknown;
  status: Status;
  created_at: Date;
  updated_at: Date;
}

/** Mã vận đơn: tiền tố hãng + 10 ký tự ngẫu nhiên (unique index ở DB chặn trùng). */
export function newTrackingCode(carrier: Carrier) {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(10);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${carrier}${s}`;
}

export function shipmentEvent(s: ShipmentRow, status: Status, at: Date): ShipmentEvent {
  return { shipmentId: s.id, orderId: s.order_id, status: status as ShipmentEvent['status'], at: at.toISOString(), carrier: s.carrier, trackingCode: s.tracking_code, fee: s.fee };
}

export async function getShipment(db: Db, id: string, lock = false): Promise<ShipmentRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const { rows } = await db.query<ShipmentRow>(`SELECT * FROM shipments WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0];
}

export async function addTimeline(c: PoolClient, shipmentId: string, status: Status, source: string, note?: string | null, at = new Date()) {
  await c.query('INSERT INTO shipment_events (shipment_id, status, note, source, at) VALUES ($1,$2,$3,$4,$5)', [shipmentId, status, note ?? STATUS_LABEL[status], source, at]);
}

/**
 * Chuyển trạng thái vận đơn (khoá dòng). Cho phép nhảy tiến nhiều bước (webhook hãng có thể bỏ bước) —
 * khi đó vẫn phát đủ sự kiện trung gian để máy trạng thái order không bị hụt bước.
 * Cùng trạng thái → no-op (webhook gửi lặp). Lùi / từ trạng thái kết thúc → 409.
 */
export async function transition(c: PoolClient, id: string, target: Status, source: string, note?: string | null) {
  const s = await getShipment(c, id, true);
  if (!s) throw notFound('Không tìm thấy vận đơn');
  if (s.status === target) return { shipment: s, changed: false };
  if (TERMINAL.includes(s.status)) throw conflict(`Vận đơn đã ở trạng thái kết thúc (${STATUS_LABEL[s.status]})`);
  let steps: Status[];
  if (target === 'FAILED') steps = ['FAILED'];
  else if (target === 'CANCELLED') {
    if (s.status !== 'CREATED') throw conflict('Hàng đã được lấy, không thể huỷ vận đơn');
    steps = ['CANCELLED'];
  } else {
    const from = FLOW.indexOf(s.status);
    const to = FLOW.indexOf(target);
    if (to < 0 || to <= from) throw conflict(`Không thể chuyển từ ${s.status} sang ${target}`);
    steps = FLOW.slice(from + 1, to + 1);
  }
  const now = new Date();
  for (const st of steps) {
    await addTimeline(c, s.id, st, source, st === target ? note : null, now);
    const type = EVENT_TYPE[st];
    if (type) await enqueue(c, Topics.shipping, createEvent(type, 'shipping', s.order_id, shipmentEvent(s, st, now)));
  }
  const { rows } = await c.query<ShipmentRow>('UPDATE shipments SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [s.id, target]);
  return { shipment: rows[0], changed: true };
}

/** Bước kế tiếp trong luồng giả lập (CREATED → PICKED → IN_TRANSIT → DELIVERED). */
export function nextStatus(s: Status): Status | null {
  const i = FLOW.indexOf(s);
  return i >= 0 && i < FLOW.length - 1 ? FLOW[i + 1] : null;
}

export async function loadView(db: Db, s: ShipmentRow) {
  const { rows } = await db.query('SELECT status, note, source, at FROM shipment_events WHERE shipment_id = $1 ORDER BY at, id', [s.id]);
  return {
    id: s.id,
    orderId: s.order_id,
    checkoutId: s.checkout_id,
    buyerId: s.buyer_id,
    shopId: s.shop_id,
    carrier: s.carrier,
    carrierName: CARRIERS[s.carrier]?.name ?? s.carrier,
    trackingCode: s.tracking_code,
    fee: s.fee,
    codAmount: s.cod_amount,
    weightGrams: s.weight_grams,
    etaDays: s.eta_days,
    fromProvince: s.from_province,
    toProvince: s.to_province,
    shipTo: s.ship_to,
    status: s.status,
    statusLabel: STATUS_LABEL[s.status],
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
    timeline: rows.map((r) => ({ status: r.status, note: r.note, source: r.source, at: (r.at as Date).toISOString() })),
  };
}
