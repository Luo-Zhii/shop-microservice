import type { EventBus } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import { CONSUMER, handleEvent, type Ctx } from './payments';

export async function registerConsumers(bus: EventBus, ctx: Ctx) {
  await bus.subscribe(CONSUMER, [Topics.paymentCommand, Topics.order], async (event) => {
    await handleEvent(ctx, event);
  });
}
