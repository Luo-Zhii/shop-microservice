import type { EventBus } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import { CONSUMER, handleEvent, type SagaCtx } from './saga';

export async function registerConsumers(bus: EventBus, ctx: SagaCtx) {
  await bus.subscribe(CONSUMER, [Topics.inventoryEvent, Topics.paymentEvent, Topics.shipping], async (event) => {
    await handleEvent(ctx, event);
  });
}
