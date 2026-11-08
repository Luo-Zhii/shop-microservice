import { createEvent, enqueue, processOnce, withTx, type Pool, type PoolClient } from '@shopnow/platform';
import {
  Topics,
  type EventEnvelope,
  type InventoryReserved,
  type InventoryReserveFailed,
  type InventoryRef,
  type PaymentCreated,
  type PaymentFailed,
  type PaymentRequest,
  type PaymentSucceeded,
  type ShipmentEvent,
  type InventoryRestock,
} from '@shopnow/contracts';
import type { SagaConfig } from './config';
import {
  addHistoryNote,
  emitOrderEvent,
  lockCheckout,
  lockOrder,
  lockOrdersOfCheckout,
  ordersCancelled,
  sagaDuration,
  transition,
  type CheckoutRow,
  type OrderRow,
} from './repo';
import type { Log } from './repo';

export const CONSUMER = 'order';

/** Lý do huỷ — promotion chỉ nhả voucher sàn với OUT_OF_STOCK / PAYMENT_FAILED / PAYMENT_TIMEOUT. */
export type CancelReason = 'OUT_OF_STOCK' | 'PAYMENT_FAILED' | 'PAYMENT_TIMEOUT' | 'BUYER_CANCELLED';

export interface SagaCtx {
  pool: Pool;
  cfg: SagaConfig;
  log?: Log;
}

const isOnline = (m: string) => m !== 'COD';

function observeSaga(co: CheckoutRow, result: 'CONFIRMED' | 'CANCELLED') {
  sagaDuration().observe({ result }, Math.max(0, (Date.now() - new Date(co.created_at).getTime()) / 1000));
}

async function setCheckoutStatus(c: PoolClient, co: CheckoutRow, status: CheckoutRow['status'], extra: { cancelReason?: string } = {}) {
  const finished = status === 'CONFIRMED' || status === 'CANCELLED';
  await c.query(
    `UPDATE checkouts SET status = $2, updated_at = now(), cancel_reason = COALESCE($3, cancel_reason),
       finished_at = CASE WHEN $4 THEN now() ELSE finished_at END WHERE id = $1`,
    [co.id, status, extra.cancelReason ?? null, finished],
  );
  co.status = status;
  if (finished) observeSaga(co, status);
}

/** Xác nhận cả checkout: order → CONFIRMED, commit kho, phát order.confirmed. */
async function confirmCheckout(c: PoolClient, ctx: SagaCtx, co: CheckoutRow, orders: OrderRow[], note: string) {
  for (const o of orders) {
    if (await transition(c, o, 'CONFIRMED', ctx.log, { note })) await emitOrderEvent(c, 'order.confirmed', o.id);
  }
  await setCheckoutStatus(c, co, 'CONFIRMED');
  await c.query('UPDATE checkouts SET inventory_committed = true WHERE id = $1', [co.id]);
  await enqueue(c, Topics.inventoryCommand, createEvent('inventory.commit', 'order', co.id, { reservationId: co.id } satisfies InventoryRef));
}

/**
 * Huỷ cả checkout đang chờ (PENDING / AWAITING_PAYMENT): mọi order còn ở trạng thái chờ → CANCELLED,
 * phát order.cancelled, nhả kho (trừ khi kho chưa từng giữ — reserve_failed).
 */
export async function cancelCheckout(
  c: PoolClient,
  ctx: SagaCtx,
  co: CheckoutRow,
  reason: CancelReason,
  opts: { release: boolean; note?: string },
): Promise<string[]> {
  const orders = await lockOrdersOfCheckout(c, co.id);
  const cancelled: string[] = [];
  for (const o of orders) {
    if (o.status !== 'PENDING' && o.status !== 'AWAITING_PAYMENT') continue;
    if (await transition(c, o, 'CANCELLED', ctx.log, { note: opts.note ?? reason, cancelReason: reason })) {
      await emitOrderEvent(c, 'order.cancelled', o.id);
      ordersCancelled().inc({ reason });
      cancelled.push(o.id);
    }
  }
  await setCheckoutStatus(c, co, 'CANCELLED', { cancelReason: reason });
  if (opts.release) {
    await enqueue(c, Topics.inventoryCommand, createEvent('inventory.release', 'order', co.id, { reservationId: co.id, reason } satisfies InventoryRef));
  }
  return cancelled;
}

/** Hoàn tiền một order đã thanh toán online (đúng một lần nhờ cờ refunded). */
export async function requestRefund(c: PoolClient, o: OrderRow, reason: string) {
  if (o.refunded) return false;
  await c.query('UPDATE orders SET refunded = true WHERE id = $1', [o.id]);
  o.refunded = true;
  await enqueue(
    c,
    Topics.paymentCommand,
    createEvent('payment.refund', 'order', o.checkout_id, { checkoutId: o.checkout_id, orderId: o.id, amount: Number(o.total), reason }),
  );
  return true;
}

/** Hoàn kho cho đơn đã trừ kho (huỷ sau CONFIRMED / trả hàng được duyệt) — inventory idempotent theo (reservationId, orderId). */
export async function requestRestock(c: PoolClient, o: OrderRow, reason: 'BUYER_CANCELLED' | 'RETURNED') {
  const { rows } = await c.query('SELECT sku_id, qty FROM order_items WHERE order_id = $1', [o.id]);
  const data: InventoryRestock = { reservationId: o.checkout_id, orderId: o.id, items: rows.map((r) => ({ skuId: r.sku_id, qty: r.qty })), reason };
  await enqueue(c, Topics.inventoryCommand, createEvent('inventory.restock', 'order', o.checkout_id, data));
}

// ---------------- Handlers theo từng loại sự kiện ----------------

async function onReserved(c: PoolClient, ctx: SagaCtx, d: InventoryReserved) {
  const co = await lockCheckout(c, d.reservationId);
  if (!co) return ctx.log?.warn({ checkoutId: d.reservationId }, 'inventory.reserved: không có checkout');
  if (co.status !== 'PENDING') return ctx.log?.warn({ checkoutId: co.id, status: co.status }, 'inventory.reserved đến muộn, bỏ qua');
  const orders = (await lockOrdersOfCheckout(c, co.id)).filter((o) => o.status === 'PENDING');
  if (!isOnline(co.payment_method)) return confirmCheckout(c, ctx, co, orders, 'Đã giữ hàng — thanh toán khi nhận hàng');

  for (const o of orders) await transition(c, o, 'AWAITING_PAYMENT', ctx.log, { note: 'Đã giữ hàng, chờ thanh toán' });
  await setCheckoutStatus(c, co, 'AWAITING_PAYMENT');
  const req: PaymentRequest = {
    checkoutId: co.id,
    buyerId: co.buyer_id,
    amount: Number(co.total),
    method: co.payment_method,
    orderIds: orders.map((o) => o.id),
    returnUrl: `${ctx.cfg.WEB_URL.replace(/\/$/, '')}/checkout/result?checkoutId=${co.id}`,
  };
  await enqueue(c, Topics.paymentCommand, createEvent('payment.request', 'order', co.id, req));
}

async function onReserveFailed(c: PoolClient, ctx: SagaCtx, d: InventoryReserveFailed) {
  const co = await lockCheckout(c, d.reservationId);
  if (!co || co.status !== 'PENDING') return ctx.log?.warn({ checkoutId: d.reservationId, status: co?.status }, 'inventory.reserve_failed bỏ qua');
  const skus = d.skuIds?.length ? ` (SKU: ${d.skuIds.join(', ')})` : '';
  await cancelCheckout(c, ctx, co, 'OUT_OF_STOCK', { release: false, note: `Hết hàng${skus}` });
}

async function onPaymentCreated(c: PoolClient, ctx: SagaCtx, d: PaymentCreated) {
  const r = await c.query('UPDATE checkouts SET payment_id = $2, redirect_url = $3, updated_at = now() WHERE id = $1', [
    d.checkoutId, d.paymentId, d.redirectUrl ?? null,
  ]);
  if (!r.rowCount) ctx.log?.warn({ checkoutId: d.checkoutId }, 'payment.created: không có checkout');
}

async function onPaymentSucceeded(c: PoolClient, ctx: SagaCtx, d: PaymentSucceeded) {
  const co = await lockCheckout(c, d.checkoutId);
  if (!co) return ctx.log?.warn({ checkoutId: d.checkoutId }, 'payment.succeeded: không có checkout');
  if (co.paid_at) return ctx.log?.warn({ checkoutId: co.id }, 'payment.succeeded trùng, bỏ qua');
  await c.query('UPDATE checkouts SET paid_at = now(), payment_id = COALESCE(payment_id, $2) WHERE id = $1', [co.id, d.paymentId]);
  co.paid_at = new Date();
  if (Number(d.amount) !== Number(co.total)) ctx.log?.warn({ checkoutId: co.id, paid: d.amount, total: co.total }, 'số tiền thanh toán lệch tổng đơn');

  if (co.status === 'AWAITING_PAYMENT') {
    const orders = (await lockOrdersOfCheckout(c, co.id)).filter((o) => o.status === 'AWAITING_PAYMENT');
    return confirmCheckout(c, ctx, co, orders, 'Đã thanh toán');
  }
  if (co.status === 'CANCELLED') {
    // Tiền về sau khi checkout đã huỷ (quá hạn / người mua huỷ) → hoàn lại toàn bộ.
    for (const o of await lockOrdersOfCheckout(c, co.id)) {
      if (o.status === 'CANCELLED' && (await requestRefund(c, o, 'LATE_PAYMENT'))) {
        await addHistoryNote(c, o.id, o.status, 'Thanh toán đến sau khi đơn đã huỷ — đã yêu cầu hoàn tiền');
      }
    }
    return;
  }
  ctx.log?.warn({ checkoutId: co.id, status: co.status }, 'payment.succeeded ở trạng thái không mong đợi');
}

async function onPaymentFailed(c: PoolClient, ctx: SagaCtx, d: PaymentFailed) {
  const co = await lockCheckout(c, d.checkoutId);
  if (!co || co.status !== 'AWAITING_PAYMENT') return ctx.log?.warn({ checkoutId: d.checkoutId, status: co?.status }, 'payment.failed bỏ qua');
  await cancelCheckout(c, ctx, co, 'PAYMENT_FAILED', { release: true, note: `Thanh toán thất bại: ${d.reason ?? ''}`.trim() });
}

async function onInventoryExpired(c: PoolClient, ctx: SagaCtx, d: InventoryRef) {
  const co = await lockCheckout(c, d.reservationId);
  if (!co || (co.status !== 'PENDING' && co.status !== 'AWAITING_PAYMENT')) {
    return ctx.log?.warn({ checkoutId: d.reservationId, status: co?.status }, 'inventory.expired bỏ qua');
  }
  await cancelCheckout(c, ctx, co, 'PAYMENT_TIMEOUT', { release: true, note: 'Hết thời gian giữ hàng' });
}

async function onShipment(c: PoolClient, ctx: SagaCtx, type: string, d: ShipmentEvent) {
  const o = await lockOrder(c, d.orderId);
  if (!o) return ctx.log?.warn({ orderId: d.orderId }, `${type}: không có order`);
  switch (type) {
    case 'shipment.created':
      await c.query(
        'UPDATE orders SET shipment_id = $2, carrier = COALESCE($3, carrier), tracking_code = COALESCE($4, tracking_code), updated_at = now() WHERE id = $1',
        [o.id, d.shipmentId, d.carrier ?? null, d.trackingCode ?? null],
      );
      await addHistoryNote(c, o.id, o.status, `Đã tạo vận đơn${d.trackingCode ? ` ${d.trackingCode}` : ''}`);
      return;
    case 'shipment.picked':
    case 'shipment.in_transit':
      if (o.status === 'CONFIRMED') {
        const note = type === 'shipment.picked' ? 'Đơn vị vận chuyển đã lấy hàng' : 'Đang vận chuyển';
        if (await transition(c, o, 'SHIPPING', ctx.log, { note })) await emitOrderEvent(c, 'order.shipped', o.id);
      } else if (o.status === 'SHIPPING' && type === 'shipment.in_transit') {
        await addHistoryNote(c, o.id, o.status, 'Đang vận chuyển');
      } else {
        ctx.log?.warn({ orderId: o.id, status: o.status, type }, 'sự kiện vận chuyển bỏ qua');
      }
      return;
    case 'shipment.delivered':
      // Lỡ mất picked (hiếm) → đi qua SHIPPING trước để không phá máy trạng thái.
      if (o.status === 'CONFIRMED' && (await transition(c, o, 'SHIPPING', ctx.log, { note: 'Đang vận chuyển' }))) {
        await emitOrderEvent(c, 'order.shipped', o.id);
      }
      if (await transition(c, o, 'DELIVERED', ctx.log, { note: 'Giao hàng thành công' })) await emitOrderEvent(c, 'order.delivered', o.id);
      return;
    case 'shipment.failed':
      await addHistoryNote(c, o.id, o.status, 'Giao hàng thất bại');
      return;
    default:
  }
}

/** Điểm vào duy nhất cho mọi sự kiện order tiêu thụ (Kafka gọi; test gọi thẳng). Trả false nếu bỏ qua / trùng. */
export async function handleEvent(ctx: SagaCtx, event: EventEnvelope<any>): Promise<boolean> {
  const run = (fn: (c: PoolClient) => Promise<unknown>) => processOnce(ctx.pool, CONSUMER, event.id, async (c) => void (await fn(c)));
  const d = event.data;
  switch (event.type) {
    case 'inventory.reserved':
      return run((c) => onReserved(c, ctx, d));
    case 'inventory.reserve_failed':
      return run((c) => onReserveFailed(c, ctx, d));
    case 'inventory.expired':
      return run((c) => onInventoryExpired(c, ctx, d));
    case 'payment.created':
      return run((c) => onPaymentCreated(c, ctx, d));
    case 'payment.succeeded':
      return run((c) => onPaymentSucceeded(c, ctx, d));
    case 'payment.failed':
      return run((c) => onPaymentFailed(c, ctx, d));
    case 'shipment.created':
    case 'shipment.picked':
    case 'shipment.in_transit':
    case 'shipment.delivered':
    case 'shipment.failed':
      return run((c) => onShipment(c, ctx, event.type, d));
    default:
      return false; // inventory.committed / released / stock.changed / payment.refunded: không cần xử lý
  }
}

// ---------------- Sweeper ----------------

/**
 * Quét định kỳ (an toàn nhiều replica nhờ FOR UPDATE SKIP LOCKED):
 * - checkout PENDING / AWAITING_PAYMENT quá PAYMENT_TIMEOUT_SECONDS → CANCELLED(PAYMENT_TIMEOUT) + nhả kho;
 * - order DELIVERED quá AUTO_COMPLETE_SECONDS → COMPLETED + order.completed.
 * `now` cho phép test giả lập thời gian.
 */
export async function sweep(ctx: SagaCtx, now: Date = new Date(), batch = 100) {
  let timedOut = 0;
  let completed = 0;
  const timeoutBefore = new Date(now.getTime() - ctx.cfg.PAYMENT_TIMEOUT_SECONDS * 1000);
  for (;;) {
    const n = await withTx(ctx.pool, async (c) => {
      const { rows } = await c.query<CheckoutRow>(
        `SELECT * FROM checkouts WHERE status IN ('PENDING','AWAITING_PAYMENT') AND created_at < $1
          ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [timeoutBefore, batch],
      );
      for (const co of rows) await cancelCheckout(c, ctx, co, 'PAYMENT_TIMEOUT', { release: true, note: 'Quá hạn thanh toán' });
      return rows.length;
    });
    timedOut += n;
    if (n < batch) break;
  }
  const completeBefore = new Date(now.getTime() - ctx.cfg.AUTO_COMPLETE_SECONDS * 1000);
  for (;;) {
    const n = await withTx(ctx.pool, async (c) => {
      const { rows } = await c.query<OrderRow>(
        `SELECT * FROM orders WHERE status = 'DELIVERED' AND delivered_at < $1
          ORDER BY delivered_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [completeBefore, batch],
      );
      for (const o of rows) {
        if (await transition(c, o, 'COMPLETED', ctx.log, { note: 'Tự động hoàn tất' })) await emitOrderEvent(c, 'order.completed', o.id);
      }
      return rows.length;
    });
    completed += n;
    if (n < batch) break;
  }
  return { timedOut, completed };
}

export function startSweeper(ctx: SagaCtx, intervalMs: number) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await sweep(ctx);
      if (r.timedOut || r.completed) ctx.log?.info(r, 'sweeper: đã xử lý đơn quá hạn');
    } catch (err) {
      ctx.log?.warn({ err }, 'sweeper lỗi, sẽ thử lại');
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, Math.min(intervalMs, 5_000));
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
