import { createHash } from 'node:crypto';
import { counter, createEvent, enqueue, newId, processOnce, type Pool, type PoolClient } from '@shopnow/platform';
import {
  Topics,
  type EventEnvelope,
  type OrderSnapshot,
  type PaymentCreated,
  type PaymentFailed,
  type PaymentRefund,
  type PaymentRefunded,
  type PaymentRequest,
  type PaymentSucceeded,
} from '@shopnow/contracts';
import type { PaymentConfig } from './config';
import { buildPaymentUrl } from './vnpay';

export const CONSUMER = 'payment';
export const paymentsTotal = () => counter('payments_total', 'Số giao dịch thanh toán theo phương thức / kết quả', ['method', 'result']);

export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}
export interface Ctx {
  pool: Pool;
  cfg: PaymentConfig;
  log?: Log;
}

export interface PaymentRow {
  id: string;
  checkout_id: string;
  buyer_id: string;
  amount: number;
  method: 'COD' | 'MOCK' | 'VNPAY';
  status: 'PENDING' | 'PENDING_COD' | 'SUCCEEDED' | 'FAILED';
  order_ids: string[];
  return_url: string | null;
  redirect_url: string | null;
  txn_ref: string | null;
  refunded_amount: number;
  paid_at: Date | null;
  created_at: Date;
}

const base = (cfg: PaymentConfig) => cfg.PUBLIC_BASE_URL.replace(/\/$/, '');

// ---------------- Lệnh payment.request ----------------

async function onRequest(c: PoolClient, ctx: Ctx, d: PaymentRequest) {
  const id = newId();
  const txnRef = id.replace(/-/g, '');
  const status = d.method === 'COD' ? 'PENDING_COD' : 'PENDING';
  const ins = await c.query<PaymentRow>(
    `INSERT INTO payments (id, checkout_id, buyer_id, amount, method, status, order_ids, return_url, txn_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (checkout_id) DO NOTHING RETURNING *`,
    [id, d.checkoutId, d.buyerId, d.amount, d.method, status, JSON.stringify(d.orderIds ?? []), d.returnUrl ?? null, txnRef],
  );
  const p = ins.rows[0];
  if (!p) return ctx.log?.warn({ checkoutId: d.checkoutId }, 'payment.request trùng checkout, bỏ qua');

  let redirectUrl: string | null = null;
  if (d.method === 'MOCK') redirectUrl = `${base(ctx.cfg)}/pay/mock/${id}`;
  if (d.method === 'VNPAY') {
    redirectUrl = buildPaymentUrl(
      { url: ctx.cfg.VNPAY_URL, tmnCode: ctx.cfg.VNPAY_TMN_CODE, hashSecret: ctx.cfg.VNPAY_HASH_SECRET, returnUrl: `${base(ctx.cfg)}/pay/vnpay/return`, expireMinutes: ctx.cfg.VNPAY_EXPIRE_MINUTES },
      { txnRef, amount: Number(d.amount), orderInfo: `Thanh toan don hang ${d.checkoutId}` },
    );
  }
  if (redirectUrl) await c.query('UPDATE payments SET redirect_url = $2 WHERE id = $1', [id, redirectUrl]);
  const created: PaymentCreated = { paymentId: id, checkoutId: d.checkoutId, method: d.method, redirectUrl };
  await enqueue(c, Topics.paymentEvent, createEvent('payment.created', 'payment', d.checkoutId, created));
  paymentsTotal().inc({ method: d.method, result: 'created' });
  // Đơn 0đ (giảm giá hết) → không cần qua cổng
  if (d.method !== 'COD' && Number(d.amount) === 0) await finalize(c, { ...p, redirect_url: redirectUrl }, true, 'ZERO_AMOUNT');
}

/**
 * Chốt kết quả thanh toán (chỉ từ PENDING — gọi lại / callback trùng không đổi gì). Gọi khi đã khoá payment.
 * Trả true nếu trạng thái thực sự thay đổi.
 */
export async function finalize(c: PoolClient, p: PaymentRow, success: boolean, reason: string, providerTxnNo?: string): Promise<boolean> {
  if (p.status !== 'PENDING') return false;
  const status = success ? 'SUCCEEDED' : 'FAILED';
  await c.query(
    `UPDATE payments SET status = $2, failure_reason = $3, provider_txn_no = COALESCE($4, provider_txn_no),
       paid_at = CASE WHEN $2 = 'SUCCEEDED' THEN now() ELSE paid_at END, updated_at = now() WHERE id = $1`,
    [p.id, status, success ? null : reason, providerTxnNo ?? null],
  );
  p.status = status;
  if (success) {
    const e: PaymentSucceeded = { paymentId: p.id, checkoutId: p.checkout_id, amount: Number(p.amount) };
    await enqueue(c, Topics.paymentEvent, createEvent('payment.succeeded', 'payment', p.checkout_id, e));
  } else {
    const e: PaymentFailed = { paymentId: p.id, checkoutId: p.checkout_id, reason };
    await enqueue(c, Topics.paymentEvent, createEvent('payment.failed', 'payment', p.checkout_id, e));
  }
  paymentsTotal().inc({ method: p.method, result: success ? 'succeeded' : 'failed' });
  return true;
}

export async function lockPayment(c: PoolClient, where: 'id' | 'checkout_id' | 'txn_ref', value: string): Promise<PaymentRow | undefined> {
  const { rows } = await c.query<PaymentRow>(`SELECT * FROM payments WHERE ${where} = $1 FOR UPDATE`, [value]);
  return rows[0];
}

/** Lưu callback từ cổng (dedupe theo nội dung). Trả false nếu đã nhận đúng callback này trước đó. */
export async function recordCallback(c: PoolClient, source: string, paymentId: string | null, payload: Record<string, unknown>, verified: boolean, result: string) {
  const canonical = JSON.stringify(Object.keys(payload).sort().map((k) => [k, payload[k]]));
  const key = `${source}:${createHash('sha256').update(canonical).digest('hex')}`;
  const r = await c.query(
    `INSERT INTO payment_events (id, payment_id, source, dedupe_key, payload, verified, result) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [newId(), paymentId, source, key, payload, verified, result],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------------- Hoàn tiền ----------------

/** Hoàn tiền một order đúng 1 lần (bảng refunds UNIQUE order_id). Dùng chung cho lệnh payment.refund và order.cancelled. */
async function refundOrder(c: PoolClient, ctx: Ctx, r: PaymentRefund, opts: { onlyIfPaidOnline?: boolean } = {}): Promise<boolean> {
  const p = await lockPayment(c, 'checkout_id', r.checkoutId);
  if (opts.onlyIfPaidOnline && (!p || p.method === 'COD' || p.status !== 'SUCCEEDED')) return false;
  // Không có payment online → đơn COD (tiền mặt đã thu khi giao) — ghi nhận hoàn thủ công.
  const method = p?.method ?? 'COD';
  if (p && p.method !== 'COD' && p.status !== 'SUCCEEDED') {
    ctx.log?.warn({ checkoutId: r.checkoutId, orderId: r.orderId, status: p.status }, 'hoàn tiền bỏ qua: checkout chưa thanh toán');
    return false;
  }
  let amount = Math.max(0, Math.trunc(Number(r.amount) || 0));
  if (p && p.method !== 'COD') amount = Math.min(amount, Number(p.amount) - Number(p.refunded_amount));
  const ins = await c.query(
    `INSERT INTO refunds (id, order_id, checkout_id, payment_id, amount, reason, method) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (order_id) DO NOTHING RETURNING id`,
    [newId(), r.orderId, r.checkoutId, p?.id ?? null, amount, r.reason ?? 'UNKNOWN', method],
  );
  if (!ins.rowCount) return false;
  if (p) await c.query('UPDATE payments SET refunded_amount = refunded_amount + $2, updated_at = now() WHERE id = $1', [p.id, amount]);
  const e: PaymentRefunded = { checkoutId: r.checkoutId, orderId: r.orderId, amount };
  await enqueue(c, Topics.paymentEvent, createEvent('payment.refunded', 'payment', r.checkoutId, e));
  paymentsTotal().inc({ method, result: 'refunded' });
  return true;
}

// ---------------- Quyết toán ví seller ----------------

export function settlementOf(o: Pick<OrderSnapshot, 'subtotal' | 'discount' | 'shippingFee' | 'total'>, rate: number) {
  const commission = Math.round((Number(o.subtotal) - Number(o.discount)) * rate);
  const net = Math.max(0, Number(o.total) - Number(o.shippingFee) - commission);
  return { commission, net };
}

/** Ghi biến động ví + sổ cái trong cùng transaction. */
export async function moveWallet(c: PoolClient, shopId: string, deltaAvailable: number, deltaPending: number, type: string, refId: string | null, note: string, extra: { earned?: number; paidOut?: number } = {}) {
  await c.query('INSERT INTO wallets (shop_id) VALUES ($1) ON CONFLICT DO NOTHING', [shopId]);
  const { rows } = await c.query(
    `UPDATE wallets SET available = available + $2, pending = pending + $3, total_earned = total_earned + $4,
       total_paid_out = total_paid_out + $5, updated_at = now() WHERE shop_id = $1 RETURNING available, pending`,
    [shopId, deltaAvailable, deltaPending, extra.earned ?? 0, extra.paidOut ?? 0],
  );
  await c.query(
    'INSERT INTO wallet_ledger (shop_id, type, amount, available_after, pending_after, ref_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [shopId, type, deltaAvailable, rows[0].available, rows[0].pending, refId, note],
  );
}

async function onOrderCompleted(c: PoolClient, ctx: Ctx, o: OrderSnapshot) {
  const { commission, net } = settlementOf(o, ctx.cfg.PLATFORM_COMMISSION_RATE);
  const cod = o.paymentMethod === 'COD';
  const ins = await c.query(
    `INSERT INTO settlements (order_id, checkout_id, shop_id, payment_method, subtotal, discount, shipping_fee, total, commission, net_amount, cod_collected)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (order_id) DO NOTHING RETURNING order_id`,
    [o.id, o.checkoutId, o.shopId, o.paymentMethod, o.subtotal, o.discount, o.shippingFee, o.total, commission, net, cod],
  );
  if (!ins.rowCount) return;
  if (cod) await c.query(`UPDATE payments SET status = 'SUCCEEDED', paid_at = COALESCE(paid_at, now()), updated_at = now() WHERE checkout_id = $1 AND status = 'PENDING_COD'`, [o.checkoutId]);
  await moveWallet(c, o.shopId, net, 0, 'ORDER_CREDIT', o.id, `Đơn ${o.id} hoàn tất${cod ? ' (COD đã thu)' : ''} — phí sàn ${commission}`, { earned: net });
}

// ---------------- Điểm vào consumer ----------------

export async function handleEvent(ctx: Ctx, event: EventEnvelope<any>): Promise<boolean> {
  const run = (fn: (c: PoolClient) => Promise<unknown>) => processOnce(ctx.pool, CONSUMER, event.id, async (c) => void (await fn(c)));
  const d = event.data;
  switch (event.type) {
    case 'payment.request':
      return run((c) => onRequest(c, ctx, d));
    case 'payment.refund':
      return run((c) => refundOrder(c, ctx, d));
    case 'order.cancelled': {
      const o = d as OrderSnapshot;
      if (o.paymentMethod === 'COD') return false;
      // Đã trả online mà order bị huỷ → tự hoàn phần của order đó (trùng với lệnh payment.refund thì refunds chặn)
      return run((c) => refundOrder(c, ctx, { checkoutId: o.checkoutId, orderId: o.id, amount: o.total, reason: `ORDER_CANCELLED${o.reason ? `:${o.reason}` : ''}` }, { onlyIfPaidOnline: true }));
    }
    case 'order.completed':
      return run((c) => onOrderCompleted(c, ctx, d));
    default:
      return false;
  }
}
