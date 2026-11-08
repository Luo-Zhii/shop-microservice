import { counter, createEvent, enqueue, histogram, type Pool, type PoolClient } from '@shopnow/platform';
import { Topics, type OrderSnapshot, type OrderStatus } from '@shopnow/contracts';

export type Db = Pool | PoolClient;

/** Logger tối thiểu (pino của service hoặc app.log của Fastify đều khớp). */
export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

// ---------------- Metrics nghiệp vụ ----------------
export const ordersCreated = () => counter('orders_created_total', 'Số order đã tạo');
export const ordersCancelled = () => counter('orders_cancelled_total', 'Số order bị huỷ', ['reason']);
export const sagaDuration = () =>
  histogram('checkout_saga_duration_seconds', 'Thời gian saga checkout từ lúc tạo tới CONFIRMED/CANCELLED', ['result'], [
    0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1800,
  ]);

// ---------------- Máy trạng thái ----------------
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED'],
  AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPING', 'CANCELLED'],
  SHIPPING: ['DELIVERED'],
  DELIVERED: ['COMPLETED', 'RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'],
  COMPLETED: [],
  CANCELLED: [],
  RETURNED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => TRANSITIONS[from]?.includes(to) ?? false;

const TIMESTAMP_COL: Partial<Record<OrderStatus, string>> = {
  CONFIRMED: 'confirmed_at',
  SHIPPING: 'shipped_at',
  DELIVERED: 'delivered_at',
  COMPLETED: 'completed_at',
  CANCELLED: 'cancelled_at',
};

export interface OrderRow {
  id: string;
  checkout_id: string;
  buyer_id: string;
  shop_id: string;
  status: OrderStatus;
  subtotal: number;
  shipping_fee: number;
  discount: number;
  total: number;
  payment_method: OrderSnapshot['paymentMethod'];
  shipping_address: OrderSnapshot['shippingAddress'];
  refunded: boolean;
  delivered_at: Date | null;
  created_at: Date;
}

export interface CheckoutRow {
  id: string;
  buyer_id: string;
  status: 'PENDING' | 'AWAITING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';
  payment_method: OrderSnapshot['paymentMethod'];
  total: number;
  paid_at: Date | null;
  inventory_committed: boolean;
  created_at: Date;
}

/**
 * Chuyển trạng thái order theo máy trạng thái. Không hợp lệ → log + trả false (không throw:
 * sự kiện đến muộn / trùng là chuyện bình thường với Kafka, không nên đẩy vào DLQ).
 * Gọi khi đã giữ khoá FOR UPDATE trên order.
 */
export async function transition(
  c: PoolClient,
  order: Pick<OrderRow, 'id' | 'status'>,
  to: OrderStatus,
  log: Log | undefined,
  opts: { note?: string; cancelReason?: string; returnReason?: string } = {},
): Promise<boolean> {
  if (!canTransition(order.status, to)) {
    log?.warn({ orderId: order.id, from: order.status, to }, 'bỏ qua chuyển trạng thái không hợp lệ');
    return false;
  }
  const sets = ['status = $2', 'updated_at = now()'];
  const args: unknown[] = [order.id, to];
  const col = TIMESTAMP_COL[to];
  // Bị từ chối trả hàng → về DELIVERED nhưng giữ nguyên delivered_at gốc (cửa sổ tự hoàn tất tính từ lúc giao).
  if (col && !(to === 'DELIVERED' && order.status === 'RETURN_REQUESTED')) sets.push(`${col} = now()`);
  if (opts.cancelReason) {
    args.push(opts.cancelReason);
    sets.push(`cancel_reason = $${args.length}`);
  }
  if (opts.returnReason) {
    args.push(opts.returnReason);
    sets.push(`return_reason = $${args.length}`);
  }
  await c.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, args);
  await c.query('INSERT INTO order_status_history (order_id, from_status, to_status, note) VALUES ($1,$2,$3,$4)', [
    order.id, order.status, to, opts.note ?? null,
  ]);
  order.status = to;
  return true;
}

export async function addHistoryNote(c: PoolClient, orderId: string, status: OrderStatus, note: string) {
  await c.query('INSERT INTO order_status_history (order_id, from_status, to_status, note) VALUES ($1,$2,$2,$3)', [orderId, status, note]);
}

// ---------------- Snapshot ----------------
function itemOut(r: Record<string, any>) {
  return {
    skuId: r.sku_id,
    productId: r.product_id,
    title: r.title,
    variantLabel: r.variant_label,
    image: r.image,
    unitPrice: Number(r.unit_price),
    qty: r.qty,
    lineTotal: Number(r.line_total),
  };
}

export function snapshotOf(r: Record<string, any>, items: ReturnType<typeof itemOut>[]): OrderSnapshot {
  const s: OrderSnapshot = {
    id: r.id,
    checkoutId: r.checkout_id,
    buyerId: r.buyer_id,
    shopId: r.shop_id,
    status: r.status,
    items,
    subtotal: Number(r.subtotal),
    shippingFee: Number(r.shipping_fee),
    discount: Number(r.discount),
    total: Number(r.total),
    paymentMethod: r.payment_method,
    shippingAddress: r.shipping_address,
    createdAt: new Date(r.created_at).toISOString(),
  };
  if (r.cancel_reason) s.reason = r.cancel_reason;
  return s;
}

/** Snapshot đầy đủ + vài trường hiển thị thêm (không có trong hợp đồng sự kiện). */
export async function loadOrders(db: Db, ids: string[]) {
  if (ids.length === 0) return [];
  const { rows } = await db.query('SELECT * FROM orders WHERE id = ANY($1::uuid[])', [ids]);
  const { rows: items } = await db.query('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY title, sku_id', [ids]);
  const byId = new Map(
    rows.map((r) => [
      r.id,
      {
        ...snapshotOf(r, items.filter((i) => i.order_id === r.id).map(itemOut)),
        shippingFeeOriginal: Number(r.shipping_fee_original),
        appliedVouchers: r.applied_vouchers,
        carrier: r.carrier,
        trackingCode: r.tracking_code,
        shipmentId: r.shipment_id,
        cancelReason: r.cancel_reason,
        returnReason: r.return_reason,
        refunded: r.refunded,
        confirmedAt: r.confirmed_at,
        shippedAt: r.shipped_at,
        deliveredAt: r.delivered_at,
        completedAt: r.completed_at,
        cancelledAt: r.cancelled_at,
        updatedAt: r.updated_at,
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => Boolean(o));
}

/** Snapshot đúng hợp đồng (bỏ trường phụ) để đưa vào sự kiện order.v1. */
export async function loadSnapshot(db: Db, id: string): Promise<OrderSnapshot> {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  const { rows: items } = await db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY title, sku_id', [id]);
  return snapshotOf(rows[0], items.map(itemOut));
}

export async function emitOrderEvent(c: PoolClient, type: string, orderId: string) {
  const snap = await loadSnapshot(c, orderId);
  await enqueue(c, Topics.order, createEvent(type, 'order', orderId, snap));
}

export async function lockCheckout(c: PoolClient, id: string): Promise<CheckoutRow | undefined> {
  const { rows } = await c.query('SELECT * FROM checkouts WHERE id = $1 FOR UPDATE', [id]);
  return rows[0];
}

export async function lockOrdersOfCheckout(c: PoolClient, checkoutId: string): Promise<OrderRow[]> {
  const { rows } = await c.query('SELECT * FROM orders WHERE checkout_id = $1 ORDER BY id FOR UPDATE', [checkoutId]);
  return rows;
}

export async function lockOrder(c: PoolClient, id: string): Promise<OrderRow | undefined> {
  const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
  return rows[0];
}
