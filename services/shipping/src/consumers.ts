import { createEvent, enqueue, newId, processOnce, type EventBus, type Logger, type Pool } from '@shopnow/platform';
import { Topics, type EventEnvelope, type OrderSnapshot } from '@shopnow/contracts';
import type { ShopPort, SkuWeightPort } from './clients';
import { quote, type Quote } from './pricing';
import { addTimeline, newTrackingCode, shipmentEvent, transition, type ShipmentRow } from './repo';

export interface ConsumerDeps {
  pool: Pool;
  shops: ShopPort;
  weights: SkuWeightPort;
  log: Logger;
  defaultPickupProvince: string;
}

const DEFAULT_ITEM_GRAMS = 200;

async function pickupProvince(deps: ConsumerDeps, shopId: string) {
  try {
    return (await deps.shops.getPickupProvince(shopId)) || deps.defaultPickupProvince;
  } catch (err) {
    // seller chết không được chặn luồng giao hàng: dùng kho mặc định, ghi log để đối soát.
    deps.log.warn({ err, shopId }, 'không lấy được pickupProvince — dùng kho mặc định');
    return deps.defaultPickupProvince;
  }
}

async function totalWeight(deps: ConsumerDeps, o: OrderSnapshot) {
  let weights = new Map<string, number>();
  try {
    weights = await deps.weights.getWeights(o.items.map((i) => i.skuId));
  } catch (err) {
    deps.log.warn({ err, orderId: o.id }, 'không lấy được cân nặng SKU — ước lượng mặc định');
  }
  return o.items.reduce((g, i) => g + (weights.get(i.skuId) || DEFAULT_ITEM_GRAMS) * i.qty, 0);
}

function safeQuote(from: string, to: string, grams: number, log: Logger): Quote {
  try {
    return quote(from, to, grams);
  } catch (err) {
    log.warn({ err, from, to }, 'địa chỉ không nhận diện được tỉnh — tính như khác miền');
    const q = quote('Hà Nội', 'Hồ Chí Minh', grams);
    return { ...q, fromProvince: from, toProvince: to };
  }
}

/** order.confirmed → tạo vận đơn (mỗi đơn tối đa một vận đơn) → shipment.created qua outbox. */
export async function createShipmentForOrder(deps: ConsumerDeps, event: EventEnvelope<OrderSnapshot>) {
  const o = event.data;
  const exists = await deps.pool.query('SELECT 1 FROM shipments WHERE order_id = $1', [o.id]);
  if (exists.rowCount) return null;
  // Gọi service khác NGOÀI transaction để không giữ kết nối DB khi chờ mạng.
  const from = await pickupProvince(deps, o.shopId);
  const grams = await totalWeight(deps, o);
  const q = safeQuote(from, o.shippingAddress.province, grams, deps.log);
  for (let attempt = 0; ; attempt++) {
    try {
      let created = null as ShipmentRow | null;
      await processOnce(deps.pool, 'shipping', event.id, async (c) => {
        const { rows } = await c.query<ShipmentRow>(
          `INSERT INTO shipments (id, order_id, checkout_id, buyer_id, shop_id, carrier, tracking_code, fee, cod_amount, weight_grams, eta_days,
                                  from_province, to_province, ship_to, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'CREATED')
           ON CONFLICT (order_id) DO NOTHING RETURNING *`,
          [newId(), o.id, o.checkoutId, o.buyerId, o.shopId, q.carrier, newTrackingCode(q.carrier), q.fee,
            o.paymentMethod === 'COD' ? o.total : 0, grams, q.etaDays, q.fromProvince, q.toProvince, JSON.stringify(o.shippingAddress)],
        );
        if (!rows[0]) return;
        created = rows[0];
        await addTimeline(c, created.id, 'CREATED', 'system', `Đã tạo vận đơn ${created.tracking_code} (${q.carrierName})`);
        const { status: _s, ...payload } = shipmentEvent(created, 'CREATED', created.created_at);
        await enqueue(c, Topics.shipping, createEvent('shipment.created', 'shipping', o.id, { ...payload, status: 'CREATED' }));
      });
      return created;
    } catch (e) {
      // trùng mã vận đơn (cực hiếm) → sinh mã khác
      if ((e as { code?: string; constraint?: string }).constraint === 'shipments_tracking_code_key' && attempt < 3) continue;
      throw e;
    }
  }
}

/** order.cancelled → huỷ vận đơn nếu hàng chưa được lấy. */
export async function cancelShipmentForOrder(deps: ConsumerDeps, event: EventEnvelope<OrderSnapshot>) {
  let result = 'none' as 'cancelled' | 'too_late' | 'none';
  await processOnce(deps.pool, 'shipping', event.id, async (c) => {
    const { rows } = await c.query<ShipmentRow>('SELECT * FROM shipments WHERE order_id = $1 FOR UPDATE', [event.data.id]);
    const s = rows[0];
    if (!s) return;
    if (s.status !== 'CREATED') {
      result = 'too_late';
      deps.log.warn({ orderId: s.order_id, status: s.status }, 'đơn huỷ nhưng hàng đã được lấy — cần xử lý hoàn hàng');
      return;
    }
    await transition(c, s.id, 'CANCELLED', 'system', `Huỷ theo đơn hàng${event.data.reason ? `: ${event.data.reason}` : ''}`);
    result = 'cancelled';
  });
  return result;
}

export async function handleOrderEvent(deps: ConsumerDeps, event: EventEnvelope<OrderSnapshot>) {
  if (event.type === 'order.confirmed') return createShipmentForOrder(deps, event);
  if (event.type === 'order.cancelled') return cancelShipmentForOrder(deps, event);
  return undefined;
}

export async function registerConsumers(bus: EventBus, deps: ConsumerDeps) {
  await bus.subscribe('shipping', [Topics.order], async (event) => {
    await handleOrderEvent(deps, event as EventEnvelope<OrderSnapshot>);
  });
}
