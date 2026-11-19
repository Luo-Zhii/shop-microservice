import { processOnce, type EventBus, type Logger, type Pool } from '@shopnow/platform';
import { Topics, type EventEnvelope, type OrderSnapshot } from '@shopnow/contracts';
import { allocatePick, cancelPick } from './stock';

/** order.confirmed → phiếu lấy hàng FIFO nếu shop có hàng gửi kho; order.cancelled → nhả giữ chỗ. */
export async function handleOrderEvent(pool: Pool, event: EventEnvelope<OrderSnapshot>, log: Logger) {
  const o = event.data;
  if (event.type !== 'order.confirmed' && event.type !== 'order.cancelled') return;
  await processOnce(pool, 'warehouse', event.id, async (c) => {
    if (event.type === 'order.cancelled') {
      await cancelPick(c, o.id);
      return;
    }
    const has = await c.query('SELECT 1 FROM lots WHERE shop_id = $1 LIMIT 1', [o.shopId]);
    if (!has.rowCount) return; // shop tự giao (không dùng kho sàn)
    const r = await allocatePick(c, { id: o.id, shopId: o.shopId, items: o.items.map((i) => ({ skuId: i.skuId, qty: i.qty })) });
    if (r.short) log.warn({ orderId: o.id, reason: r.short }, 'kho thiếu hàng cho đơn');
  });
}

export async function registerConsumers(bus: EventBus, pool: Pool, log: Logger) {
  await bus.subscribe('warehouse', [Topics.order], async (event) => handleOrderEvent(pool, event as EventEnvelope<OrderSnapshot>, log));
}
