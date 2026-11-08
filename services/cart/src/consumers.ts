import type { EventBus, Logger } from '@shopnow/platform';
import { Topics, type EventEnvelope, type OrderSnapshot } from '@shopnow/contracts';
import type { CartStore } from './store';

/** order.created → xoá các SKU đã đặt khỏi giỏ của buyer. Idempotent qua Redis SET NX theo event id. */
export async function handleOrderEvent(deps: { store: CartStore; log: Logger }, event: EventEnvelope<OrderSnapshot>) {
  if (event.type !== 'order.created') return false;
  const o = event.data;
  if (!(await deps.store.markEvent(event.id))) return false; // bản trùng
  try {
    const skuIds = [...new Set(o.items.map((i) => i.skuId))];
    const removed = await deps.store.remove({ kind: 'user', id: o.buyerId }, skuIds);
    deps.log.info({ orderId: o.id, buyerId: o.buyerId, removed }, 'đã xoá món đã đặt khỏi giỏ');
    return true;
  } catch (e) {
    await deps.store.unmarkEvent(event.id).catch(() => undefined); // để lần thử lại xử lý tiếp
    throw e;
  }
}

export async function registerConsumers(bus: EventBus, deps: { store: CartStore; log: Logger }) {
  await bus.subscribe('cart', [Topics.order], async (event) => {
    await handleOrderEvent(deps, event as EventEnvelope<OrderSnapshot>);
  });
}
