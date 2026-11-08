import { processOnce, type EventBus, type Pool } from '@shopnow/platform';
import { Topics, type EventEnvelope, type OrderSnapshot } from '@shopnow/contracts';
import type { FlashStore } from './flash';

export const CONSUMER = 'promotion';
/** Voucher sàn chỉ được trả lại khi đơn huỷ không do người mua (hết hàng / thanh toán lỗi / quá hạn). */
export const PLATFORM_RELEASE_REASONS = ['OUT_OF_STOCK', 'PAYMENT_FAILED', 'PAYMENT_TIMEOUT'];

interface Log {
  warn(obj: object, msg?: string): void;
}

/**
 * order.confirmed → redemption + suất flash sale của order đó: USED.
 * order.cancelled → nhả voucher shop + suất flash sale của order; voucher sàn chỉ nhả với lý do hợp lệ.
 * Bộ đếm Redis được trả SAU khi transaction Postgres commit (lỡ crash giữa chừng chỉ làm thiếu suất, không bao giờ bán vượt).
 */
export async function handleOrderEvent(ctx: { pool: Pool; flash: FlashStore; log?: Log }, event: EventEnvelope<any>): Promise<boolean> {
  if (event.type !== 'order.confirmed' && event.type !== 'order.cancelled') return false;
  const o = event.data as OrderSnapshot;
  const skuIds = (o.items ?? []).map((i) => i.skuId);
  const toRelease: { item_id: string; buyer_id: string; qty: number }[] = [];

  const done = await processOnce(ctx.pool, CONSUMER, event.id, async (c) => {
    if (event.type === 'order.confirmed') {
      await c.query(
        `UPDATE redemptions SET status = 'USED', updated_at = now()
          WHERE checkout_id = $1 AND status IN ('LOCKED', 'RELEASED') AND (shop_id = $2 OR shop_id IS NULL)`,
        [o.checkoutId, o.shopId],
      );
      await c.query(
        `UPDATE flash_sale_holds SET status = 'USED', updated_at = now()
          WHERE checkout_id = $1 AND sku_id = ANY($2::text[]) AND status IN ('LOCKED', 'RELEASED')`,
        [o.checkoutId, skuIds],
      );
      return;
    }
    const releasePlatform = PLATFORM_RELEASE_REASONS.includes(o.reason ?? '');
    await c.query(
      `UPDATE redemptions SET status = 'RELEASED', updated_at = now()
        WHERE checkout_id = $1 AND status <> 'RELEASED' AND (shop_id = $2 OR ($3 AND shop_id IS NULL))`,
      [o.checkoutId, o.shopId, releasePlatform],
    );
    const { rows } = await c.query(
      `UPDATE flash_sale_holds SET status = 'RELEASED', updated_at = now()
        WHERE checkout_id = $1 AND sku_id = ANY($2::text[]) AND status <> 'RELEASED'
        RETURNING item_id, buyer_id, qty`,
      [o.checkoutId, skuIds],
    );
    toRelease.push(...rows);
  });
  for (const r of toRelease) {
    await ctx.flash.release(r.item_id, o.checkoutId, r.buyer_id, r.qty).catch((err) => ctx.log?.warn({ err, itemId: r.item_id }, 'không nhả được suất flash sale trên Redis'));
  }
  return done;
}

export async function registerConsumers(bus: EventBus, ctx: { pool: Pool; flash: FlashStore; log?: Log }) {
  await bus.subscribe(CONSUMER, [Topics.order], async (event) => {
    await handleOrderEvent(ctx, event);
  });
}
