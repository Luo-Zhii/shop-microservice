import type { Pool } from '@shopnow/platform';
import type { FlashStore } from './flash';

/**
 * Nhả voucher / suất flash sale LOCKED bị bỏ quên — trường hợp promotion đã commit nhưng order lỗi trước khi lưu đơn
 * (không bao giờ có order.cancelled). TTL phải lớn hơn PAYMENT_TIMEOUT của order để không nhả nhầm checkout đang chờ trả tiền.
 * Nếu order.confirmed tới muộn sau khi đã nhả, consumer vẫn chuyển sang USED (xem handleOrderEvent).
 */
export async function sweepStaleLocks(ctx: { pool: Pool; flash: FlashStore }, ttlSeconds: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - ttlSeconds * 1000);
  const c = await ctx.pool.connect();
  let holds: { item_id: string; checkout_id: string; buyer_id: string; qty: number }[] = [];
  let vouchers = 0;
  try {
    await c.query('BEGIN');
    const r1 = await c.query(
      `UPDATE redemptions SET status = 'RELEASED', updated_at = now()
        WHERE id IN (SELECT id FROM redemptions WHERE status = 'LOCKED' AND created_at < $1 FOR UPDATE SKIP LOCKED)`,
      [cutoff],
    );
    vouchers = r1.rowCount ?? 0;
    const r2 = await c.query(
      `UPDATE flash_sale_holds SET status = 'RELEASED', updated_at = now()
        WHERE id IN (SELECT id FROM flash_sale_holds WHERE status = 'LOCKED' AND created_at < $1 FOR UPDATE SKIP LOCKED)
        RETURNING item_id, checkout_id, buyer_id, qty`,
      [cutoff],
    );
    holds = r2.rows;
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  for (const h of holds) await ctx.flash.release(h.item_id, h.checkout_id, h.buyer_id, h.qty).catch(() => undefined);
  return { vouchers, flashHolds: holds.length };
}
