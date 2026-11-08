import type { EventBus, Logger } from '@shopnow/platform';
import { Topics, type EventEnvelope, type OrderSnapshot } from '@shopnow/contracts';
import { alreadyProcessed, markProcessed, type Collections } from './store';

const CONSUMER = 'review';

/** order.completed → lưu quyền đánh giá (purchase). Upsert theo orderId nên chạy lặp vẫn đúng; inbox ghi sau khi xong. */
export async function handleOrderEvent(deps: { col: Collections; log: Logger }, event: EventEnvelope<OrderSnapshot>) {
  if (event.type !== 'order.completed') return false;
  if (await alreadyProcessed(deps.col, CONSUMER, event.id)) return false;
  const o = event.data;
  await deps.col.purchases.updateOne(
    { _id: o.id },
    { $set: { buyerId: o.buyerId, shopId: o.shopId, productIds: [...new Set(o.items.map((i) => i.productId))], completedAt: new Date(event.time) } },
    { upsert: true },
  );
  await markProcessed(deps.col, CONSUMER, event.id);
  return true;
}

export async function registerConsumers(bus: EventBus, deps: { col: Collections; log: Logger }) {
  await bus.subscribe('review', [Topics.order], async (event) => {
    await handleOrderEvent(deps, event as EventEnvelope<OrderSnapshot>);
  });
}
