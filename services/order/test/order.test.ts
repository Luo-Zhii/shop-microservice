import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import type { EventEnvelope } from '@shopnow/contracts';
import { registerRoutes } from '../src/routes';
import { handleEvent, sweep, type SagaCtx } from '../src/saga';
import type { OrderDeps, PromotionQuote, PromotionQuoteRequest, SkuInfo } from '../src/clients';
import type { SagaConfig } from '../src/config';

const SHOP_A = '0190f0e0-0000-7000-8000-00000000000a';
const SHOP_B = '0190f0e0-0000-7000-8000-00000000000b';
const SKU_A1 = '0190f0e0-0000-7000-8000-0000000000a1';
const SKU_A2 = '0190f0e0-0000-7000-8000-0000000000a2';
const SKU_B1 = '0190f0e0-0000-7000-8000-0000000000b1';
const SKU_OFF = '0190f0e0-0000-7000-8000-0000000000ff';

const cfg: SagaConfig = {
  WEB_URL: 'http://web.test',
  PAYMENT_TIMEOUT_SECONDS: 900,
  AUTO_COMPLETE_SECONDS: 259_200,
  RETURN_WINDOW_DAYS: 7,
  DEFAULT_PICKUP_PROVINCE: 'Hồ Chí Minh',
};

const sku = (skuId: string, shopId: string, price: number, extra: Partial<SkuInfo> = {}): SkuInfo => ({
  skuId, productId: `p-${skuId.slice(-2)}`, shopId, title: `SP ${skuId.slice(-2)}`, variantLabel: 'M / Đen', image: null,
  price, weightGrams: 500, status: 'ACTIVE', productStatus: 'APPROVED', purchasable: true, ...extra,
});
const CATALOG = new Map<string, SkuInfo>([
  [SKU_A1, sku(SKU_A1, SHOP_A, 100_000)],
  [SKU_A2, sku(SKU_A2, SHOP_A, 50_000)],
  [SKU_B1, sku(SKU_B1, SHOP_B, 200_000)],
  [SKU_OFF, sku(SKU_OFF, SHOP_B, 10_000, { purchasable: false, productStatus: 'HIDDEN' })],
]);
const ADDRESS = { fullName: 'Nguyễn Văn A', phone: '0901234567', line1: '1 Lê Lợi', ward: 'Bến Nghé', district: 'Quận 1', province: 'Hồ Chí Minh' };

const calls = { promotion: [] as PromotionQuoteRequest[], shipping: [] as { fromProvince: string; toProvince: string; weightGrams: number }[] };
/** promotion giả: shop A được giảm 10.000 + freeship, SKU_A2 có giá flash sale 40.000. */
let promoImpl: (req: PromotionQuoteRequest) => PromotionQuote = (req) => ({
  shops: req.shops.map((s) =>
    s.shopId === SHOP_A
      ? { shopId: s.shopId, discount: 10_000, shippingDiscount: 30_000, appliedVouchers: [{ code: 'SHOPA10K' }], items: s.items.map((i) => ({ skuId: i.skuId, unitPrice: i.skuId === SKU_A2 ? 40_000 : i.price })) }
      : { shopId: s.shopId, discount: 0, shippingDiscount: 0, appliedVouchers: [], items: s.items.map((i) => ({ skuId: i.skuId, unitPrice: i.price })) },
  ),
  platformDiscount: 0,
  totalDiscount: 40_000,
});
const defaultPromo = promoImpl;

const deps: OrderDeps = {
  catalog: { skus: async (ids) => ids.map((id) => CATALOG.get(id)).filter((x): x is SkuInfo => Boolean(x)) },
  profile: { address: async () => ADDRESS },
  seller: { shop: async (id) => ({ id, pickupProvince: id === SHOP_A ? 'Hà Nội' : null }) },
  shipping: { quote: async (q) => (calls.shipping.push(q), { carrier: 'GHN', fee: 30_000, etaDays: 3 }) },
  promotion: { quote: async (q) => (calls.promotion.push(q), promoImpl(q)) },
};

let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
let ctx: SagaCtx;
const svc = createService('order-test');
const app = svc.app;
let buyer: string;
let sellerA: string;
let adminT: string;

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('order_test', join(__dirname, '../migrations'));
  ctx = { pool, cfg };
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), deps, cfg });
  await app.ready();
  buyer = await jwks.sign('buyer-1');
  sellerA = await jwks.sign('seller-a', ['buyer', 'seller'], { shopId: SHOP_A });
  adminT = await jwks.sign('admin-1', ['admin']);
});
after(async () => {
  await app.close();
  await pool.end();
  await jwks.close();
});
beforeEach(() => {
  promoImpl = defaultPromo;
  calls.promotion.length = 0;
  calls.shipping.length = 0;
});

const ev = <T>(type: string, subject: string, data: T): EventEnvelope<T> => ({ id: newId(), type, source: 'test', time: new Date().toISOString(), subject, data });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function checkout(body: Record<string, unknown>, key?: string, token = buyer) {
  return app.inject({ method: 'POST', url: '/checkout', headers: { ...auth(token), ...(key ? { 'idempotency-key': key } : {}) }, payload: body });
}
async function placeOrder(paymentMethod: 'COD' | 'MOCK' | 'VNPAY', items = [{ skuId: SKU_A1, qty: 1 }, { skuId: SKU_A2, qty: 2 }, { skuId: SKU_B1, qty: 1 }]) {
  const r = await checkout({ items, shippingAddress: ADDRESS, voucherCodes: ['SHOPA10K'], paymentMethod });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { checkoutId: string; status: string; orderIds: string[] };
}
/** Sự kiện trong outbox liên quan tới một checkout (theo subject = checkoutId hoặc orderId). */
async function outbox(checkoutId: string, type?: string) {
  const { rows } = await pool.query(
    `SELECT topic, payload FROM outbox WHERE (payload->>'subject' = $1 OR payload->'data'->>'checkoutId' = $1) ${type ? `AND payload->>'type' = $2` : ''} ORDER BY created_at, id`,
    type ? [checkoutId, type] : [checkoutId],
  );
  return rows.map((r) => ({ topic: r.topic as string, ...(r.payload as EventEnvelope<any>) }));
}
async function statuses(checkoutId: string) {
  const { rows } = await pool.query('SELECT status FROM orders WHERE checkout_id = $1 ORDER BY id', [checkoutId]);
  return rows.map((r) => r.status);
}
const checkoutRow = async (id: string) => (await pool.query('SELECT * FROM checkouts WHERE id = $1', [id])).rows[0];

test('COD happy path: tách đơn theo shop, tính tiền, giữ kho → CONFIRMED → giao → hoàn tất', async () => {
  const co = await placeOrder('COD');
  assert.equal(co.status, 'PENDING');
  assert.equal(co.orderIds.length, 2);

  // Gọi đồng bộ đúng hợp đồng
  assert.equal(calls.promotion.length, 1);
  assert.equal(calls.promotion[0].commit, true);
  assert.equal(calls.promotion[0].checkoutId, co.checkoutId);
  assert.deepEqual(calls.promotion[0].voucherCodes, ['SHOPA10K']);
  const shipA = calls.shipping.find((s) => s.fromProvince === 'Hà Nội')!;
  assert.equal(shipA.weightGrams, 1500); // 3 món × 500g
  assert.equal(calls.shipping.find((s) => s.fromProvince === 'Hồ Chí Minh')!.weightGrams, 500); // shop B chưa khai báo → mặc định

  const view = (await app.inject({ method: 'GET', url: `/checkouts/${co.checkoutId}`, headers: auth(buyer) })).json();
  const a = view.orders.find((o: { shopId: string }) => o.shopId === SHOP_A);
  const b = view.orders.find((o: { shopId: string }) => o.shopId === SHOP_B);
  assert.equal(a.subtotal, 100_000 + 2 * 40_000); // giá flash sale
  assert.equal(a.discount, 10_000);
  assert.equal(a.shippingFee, 0); // freeship
  assert.equal(a.total, 170_000);
  assert.equal(b.total, 200_000 + 30_000);
  assert.equal(view.total, 400_000);

  const created = await outbox(co.checkoutId, 'order.created');
  assert.equal(created.length, 2);
  const [reserve] = await outbox(co.checkoutId, 'inventory.reserve');
  assert.equal(reserve.topic, 'inventory.command.v1');
  assert.equal(reserve.data.reservationId, co.checkoutId);
  assert.equal(reserve.data.ttlSeconds, 900);
  assert.deepEqual(reserve.data.items.map((i: { qty: number }) => i.qty).sort(), [1, 1, 2]);

  assert.equal(await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() })), true);
  assert.deepEqual(await statuses(co.checkoutId), ['CONFIRMED', 'CONFIRMED']);
  assert.equal((await checkoutRow(co.checkoutId)).status, 'CONFIRMED');
  assert.equal((await outbox(co.checkoutId, 'inventory.commit')).length, 1);
  assert.equal((await outbox(co.checkoutId, 'order.confirmed')).length, 2);
  assert.equal((await outbox(co.checkoutId, 'payment.request')).length, 0);

  // Vận chuyển đơn shop A
  const oid = a.id;
  const ship = (type: string, status: string) => handleEvent(ctx, ev(type, 'shp-1', { shipmentId: 'shp-1', orderId: oid, status, at: new Date().toISOString() }));
  await handleEvent(ctx, ev('shipment.created', 'shp-1', { shipmentId: 'shp-1', orderId: oid, carrier: 'GHN', trackingCode: 'GHN123', fee: 30000 }));
  await ship('shipment.picked', 'PICKED');
  await ship('shipment.in_transit', 'IN_TRANSIT');
  assert.equal((await outbox(oid, 'order.shipped')).length, 1, 'order.shipped chỉ phát một lần');
  await ship('shipment.delivered', 'DELIVERED');
  assert.equal((await outbox(oid, 'order.delivered')).length, 1);

  const detail = (await app.inject({ method: 'GET', url: `/orders/${oid}`, headers: auth(buyer) })).json();
  assert.equal(detail.status, 'DELIVERED');
  assert.equal(detail.trackingCode, 'GHN123');
  assert.deepEqual(
    detail.timeline.filter((t: { from: string; status: string }) => t.from !== t.status).map((t: { status: string }) => t.status),
    ['PENDING', 'CONFIRMED', 'SHIPPING', 'DELIVERED'],
  );

  // Người khác không xem được
  const other = await jwks.sign('buyer-2');
  assert.equal((await app.inject({ method: 'GET', url: `/orders/${oid}`, headers: auth(other) })).statusCode, 404);

  const done = await app.inject({ method: 'POST', url: `/orders/${oid}/confirm-received`, headers: auth(buyer) });
  assert.equal(done.statusCode, 200, done.body);
  const [completed] = await outbox(oid, 'order.completed');
  assert.equal(completed.data.status, 'COMPLETED');
  assert.equal(completed.data.paymentMethod, 'COD');

  // Seller thấy đơn & thống kê
  const sl = (await app.inject({ method: 'GET', url: '/seller/orders?status=COMPLETED', headers: auth(sellerA) })).json();
  assert.ok(sl.items.some((o: { id: string }) => o.id === oid));
  const st = (await app.inject({ method: 'GET', url: '/seller/stats?days=7', headers: auth(sellerA) })).json();
  assert.equal(st.revenueByDay.length, 7);
  assert.ok(st.totalRevenue >= 170_000);
  assert.ok(st.topProducts.length >= 1);
  assert.equal((await app.inject({ method: 'GET', url: '/seller/stats', headers: auth(buyer) })).statusCode, 403);
});

test('thanh toán online happy path: AWAITING_PAYMENT → payment.request → redirectUrl → CONFIRMED', async () => {
  const co = await placeOrder('MOCK');
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  assert.deepEqual(await statuses(co.checkoutId), ['AWAITING_PAYMENT', 'AWAITING_PAYMENT']);
  const [req] = await outbox(co.checkoutId, 'payment.request');
  assert.equal(req.topic, 'payment.command.v1');
  assert.equal(req.data.amount, 400_000);
  assert.equal(req.data.method, 'MOCK');
  assert.equal(req.data.returnUrl, `http://web.test/checkout/result?checkoutId=${co.checkoutId}`);
  assert.deepEqual([...req.data.orderIds].sort(), [...co.orderIds].sort());
  assert.equal((await outbox(co.checkoutId, 'inventory.commit')).length, 0);

  await handleEvent(ctx, ev('payment.created', co.checkoutId, { paymentId: 'pay-1', checkoutId: co.checkoutId, method: 'MOCK', redirectUrl: 'http://pay/mock/pay-1' }));
  const v = (await app.inject({ method: 'GET', url: `/checkouts/${co.checkoutId}`, headers: auth(buyer) })).json();
  assert.equal(v.status, 'AWAITING_PAYMENT');
  assert.equal(v.redirectUrl, 'http://pay/mock/pay-1');

  await handleEvent(ctx, ev('payment.succeeded', co.checkoutId, { paymentId: 'pay-1', checkoutId: co.checkoutId, amount: 400_000 }));
  assert.deepEqual(await statuses(co.checkoutId), ['CONFIRMED', 'CONFIRMED']);
  assert.equal((await outbox(co.checkoutId, 'inventory.commit')).length, 1);
  assert.equal((await outbox(co.checkoutId, 'order.confirmed')).length, 2);
});

test('hết hàng: reserve_failed → CANCELLED(OUT_OF_STOCK), không nhả kho', async () => {
  const co = await placeOrder('COD');
  await handleEvent(ctx, ev('inventory.reserve_failed', co.checkoutId, { reservationId: co.checkoutId, reason: 'INSUFFICIENT_STOCK', skuIds: [SKU_B1] }));
  assert.deepEqual(await statuses(co.checkoutId), ['CANCELLED', 'CANCELLED']);
  const cancelled = await outbox(co.checkoutId, 'order.cancelled');
  assert.equal(cancelled.length, 2);
  assert.ok(cancelled.every((e) => e.data.reason === 'OUT_OF_STOCK'));
  assert.equal((await outbox(co.checkoutId, 'inventory.release')).length, 0);
  // reserved đến muộn sau khi đã huỷ → bỏ qua
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  assert.deepEqual(await statuses(co.checkoutId), ['CANCELLED', 'CANCELLED']);
});

test('thanh toán thất bại → CANCELLED(PAYMENT_FAILED) + inventory.release', async () => {
  const co = await placeOrder('VNPAY');
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  await handleEvent(ctx, ev('payment.failed', co.checkoutId, { paymentId: 'p', checkoutId: co.checkoutId, reason: 'Khách huỷ' }));
  assert.deepEqual(await statuses(co.checkoutId), ['CANCELLED', 'CANCELLED']);
  const [rel] = await outbox(co.checkoutId, 'inventory.release');
  assert.equal(rel.data.reservationId, co.checkoutId);
  assert.ok((await outbox(co.checkoutId, 'order.cancelled')).every((e) => e.data.reason === 'PAYMENT_FAILED'));
  assert.equal((await checkoutRow(co.checkoutId)).cancel_reason, 'PAYMENT_FAILED');
});

test('quá hạn thanh toán: sweeper với thời gian giả → CANCELLED(PAYMENT_TIMEOUT) + release; tiền về muộn → hoàn', async () => {
  const co = await placeOrder('MOCK');
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  await sweep(ctx, new Date(Date.now() + 899_000)); // chưa tới hạn
  assert.deepEqual(await statuses(co.checkoutId), ['AWAITING_PAYMENT', 'AWAITING_PAYMENT']);
  const r = await sweep(ctx, new Date(Date.now() + 901_000));
  assert.ok(r.timedOut >= 1);
  assert.deepEqual(await statuses(co.checkoutId), ['CANCELLED', 'CANCELLED']);
  assert.equal((await outbox(co.checkoutId, 'inventory.release')).length, 1);
  assert.ok((await outbox(co.checkoutId, 'order.cancelled')).every((e) => e.data.reason === 'PAYMENT_TIMEOUT'));
  // inventory.expired đến sau → không huỷ lần 2
  await handleEvent(ctx, ev('inventory.expired', co.checkoutId, { reservationId: co.checkoutId }));
  assert.equal((await outbox(co.checkoutId, 'order.cancelled')).length, 2);

  // payment.succeeded đến sau khi đã huỷ → hoàn tiền từng order
  await handleEvent(ctx, ev('payment.succeeded', co.checkoutId, { paymentId: 'late', checkoutId: co.checkoutId, amount: 400_000 }));
  const refunds = await outbox(co.checkoutId, 'payment.refund');
  assert.equal(refunds.length, 2);
  assert.equal(refunds.reduce((s, e) => s + e.data.amount, 0), 400_000);
  assert.deepEqual(await statuses(co.checkoutId), ['CANCELLED', 'CANCELLED']);
});

test('inventory.expired khi đang chờ thanh toán → CANCELLED(PAYMENT_TIMEOUT)', async () => {
  const co = await placeOrder('MOCK');
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  await handleEvent(ctx, ev('inventory.expired', co.checkoutId, { reservationId: co.checkoutId }));
  assert.deepEqual(await statuses(co.checkoutId), ['CANCELLED', 'CANCELLED']);
  assert.equal((await outbox(co.checkoutId, 'inventory.release')).length, 1);
});

test('huỷ sau khi đã trả online → order.cancelled + payment.refund đúng một lần', async () => {
  const co = await placeOrder('MOCK');
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  await handleEvent(ctx, ev('payment.succeeded', co.checkoutId, { paymentId: 'pay-2', checkoutId: co.checkoutId, amount: 400_000 }));
  const { rows } = await pool.query('SELECT id, total FROM orders WHERE checkout_id = $1 AND shop_id = $2', [co.checkoutId, SHOP_B]);
  const target = rows[0];

  const r = await app.inject({ method: 'POST', url: `/orders/${target.id}/cancel`, headers: auth(buyer), payload: { reason: 'Đổi ý' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().refundRequested, true);
  const refunds = await outbox(co.checkoutId, 'payment.refund');
  assert.equal(refunds.length, 1);
  assert.deepEqual(refunds[0].data, { checkoutId: co.checkoutId, orderId: target.id, amount: Number(target.total), reason: 'BUYER_CANCELLED' });
  const [cancelled] = await outbox(target.id, 'order.cancelled');
  assert.equal(cancelled.data.reason, 'BUYER_CANCELLED');
  // Đơn còn lại của checkout không bị ảnh hưởng; kho đã commit → không release mà hoàn kho đúng các món của đơn này
  assert.deepEqual((await statuses(co.checkoutId)).sort(), ['CANCELLED', 'CONFIRMED']);
  assert.equal((await outbox(co.checkoutId, 'inventory.release')).length, 0);
  const restocks = await outbox(co.checkoutId, 'inventory.restock');
  assert.equal(restocks.length, 1);
  assert.equal(restocks[0].topic, 'inventory.command.v1');
  assert.equal(restocks[0].data.orderId, target.id);
  assert.equal(restocks[0].data.reason, 'BUYER_CANCELLED');
  assert.ok(restocks[0].data.items.length >= 1 && restocks[0].data.items.every((i: { qty: number }) => i.qty > 0));
  // Huỷ lần 2 → 409, không hoàn thêm
  const again = await app.inject({ method: 'POST', url: `/orders/${target.id}/cancel`, headers: auth(buyer) });
  assert.equal(again.statusCode, 409);
  assert.equal((await outbox(co.checkoutId, 'payment.refund')).length, 1);
});

test('huỷ khi đang chờ thanh toán → huỷ cả checkout + nhả kho, không hoàn tiền', async () => {
  const co = await placeOrder('MOCK');
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  const r = await app.inject({ method: 'POST', url: `/orders/${co.orderIds[0]}/cancel`, headers: auth(buyer) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().cancelledOrderIds.length, 2);
  assert.deepEqual(await statuses(co.checkoutId), ['CANCELLED', 'CANCELLED']);
  assert.equal((await outbox(co.checkoutId, 'inventory.release')).length, 1);
  assert.equal((await outbox(co.checkoutId, 'payment.refund')).length, 0);
});

async function deliveredOrder(method: 'COD' | 'MOCK' = 'MOCK') {
  const co = await placeOrder(method, [{ skuId: SKU_B1, qty: 1 }]);
  await handleEvent(ctx, ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() }));
  if (method !== 'COD') await handleEvent(ctx, ev('payment.succeeded', co.checkoutId, { paymentId: newId(), checkoutId: co.checkoutId, amount: 230_000 }));
  const oid = co.orderIds[0];
  await handleEvent(ctx, ev('shipment.delivered', 's', { shipmentId: 's', orderId: oid, status: 'DELIVERED', at: new Date().toISOString() }));
  return { co, oid };
}

test('trả hàng: yêu cầu trong 7 ngày → admin duyệt → RETURNED + payment.refund; từ chối → DELIVERED; quá hạn → 409', async () => {
  const { co, oid } = await deliveredOrder();
  // delivered khi đang CONFIRMED → đi qua SHIPPING
  assert.equal((await outbox(oid, 'order.shipped')).length, 1);
  assert.equal((await app.inject({ method: 'POST', url: `/orders/${oid}/return`, headers: auth(buyer), payload: { reason: 'x' } })).statusCode, 400);
  const req = await app.inject({ method: 'POST', url: `/orders/${oid}/return`, headers: auth(buyer), payload: { reason: 'Hàng bị lỗi đường may' } });
  assert.equal(req.statusCode, 200, req.body);
  assert.equal((await outbox(oid, 'order.return_requested')).length, 1);
  // seller shop A không duyệt được đơn shop B
  assert.equal((await app.inject({ method: 'POST', url: `/seller/orders/${oid}/return/approve`, headers: auth(sellerA) })).statusCode, 404);
  const ok = await app.inject({ method: 'POST', url: `/admin/orders/${oid}/return/approve`, headers: auth(adminT) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await outbox(oid, 'order.returned')).length, 1);
  const refunds = await outbox(co.checkoutId, 'payment.refund');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].data.amount, 230_000);
  assert.equal(refunds[0].data.reason, 'RETURNED');
  const restock = await outbox(co.checkoutId, 'inventory.restock');
  assert.equal(restock.length, 1);
  assert.equal(restock[0].data.reason, 'RETURNED');

  // Từ chối
  const second = await deliveredOrder('COD');
  await app.inject({ method: 'POST', url: `/orders/${second.oid}/return`, headers: auth(buyer), payload: { reason: 'Không vừa size' } });
  const rej = await app.inject({ method: 'POST', url: `/admin/orders/${second.oid}/return/reject`, headers: auth(adminT), payload: { note: 'Sản phẩm đã qua sử dụng' } });
  assert.equal(rej.json().status, 'DELIVERED');
  assert.equal((await outbox(second.co.checkoutId, 'payment.refund')).length, 0);
  assert.equal((await outbox(second.co.checkoutId, 'inventory.restock')).length, 0);

  // Quá cửa sổ 7 ngày
  await pool.query(`UPDATE orders SET delivered_at = now() - interval '8 days' WHERE id = $1`, [second.oid]);
  const late = await app.inject({ method: 'POST', url: `/orders/${second.oid}/return`, headers: auth(buyer), payload: { reason: 'Không vừa size' } });
  assert.equal(late.statusCode, 409);
});

test('sweeper tự hoàn tất đơn DELIVERED quá AUTO_COMPLETE_SECONDS', async () => {
  const { oid } = await deliveredOrder('COD');
  await sweep(ctx, new Date(Date.now() + 259_100_000));
  assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [oid])).rows[0].status, 'DELIVERED');
  await sweep(ctx, new Date(Date.now() + 259_201_000));
  assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [oid])).rows[0].status, 'COMPLETED');
  assert.equal((await outbox(oid, 'order.completed')).length, 1);
});

test('idempotency checkout: cùng key + cùng user → kết quả cũ; khác body → 409; user khác dùng được key đó', async () => {
  const key = `idem-${newId()}`;
  const body = { items: [{ skuId: SKU_A1, qty: 1 }], shippingAddress: ADDRESS, paymentMethod: 'COD' };
  const r1 = await checkout(body, key);
  const r2 = await checkout(body, key);
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.headers['idempotent-replayed'], 'true');
  assert.deepEqual(r2.json(), r1.json());
  assert.equal(calls.promotion.length, 1, 'không gọi lại service khác');
  const n = (await pool.query('SELECT count(*)::int n FROM checkouts WHERE id = $1', [r1.json().checkoutId])).rows[0].n;
  assert.equal(n, 1);
  assert.equal((await checkout({ ...body, paymentMethod: 'MOCK' }, key)).statusCode, 409);
  const other = await checkout(body, key, await jwks.sign('buyer-3'));
  assert.equal(other.statusCode, 201);
  assert.notEqual(other.json().checkoutId, r1.json().checkoutId);

  // Lỗi lần đầu (promotion từ chối) → thử lại cùng key, dùng lại đúng checkoutId
  const key2 = `idem-${newId()}`;
  promoImpl = () => {
    throw Object.assign(new Error('Mã giảm giá đã hết lượt'), { statusCode: 400, code: 'VALIDATION_ERROR', passthrough: true });
  };
  const bad = await checkout({ ...body, voucherCodes: ['HET'] }, key2);
  assert.equal(bad.statusCode, 400);
  promoImpl = defaultPromo;
  const retry = await checkout({ ...body, voucherCodes: ['HET'] }, key2);
  assert.equal(retry.statusCode, 201, retry.body);
  assert.equal(calls.promotion[calls.promotion.length - 1].checkoutId, calls.promotion[calls.promotion.length - 2].checkoutId);
});

test('sự kiện trùng (Kafka at-least-once) không xử lý 2 lần', async () => {
  const co = await placeOrder('MOCK');
  const reserved = ev('inventory.reserved', co.checkoutId, { reservationId: co.checkoutId, expiresAt: new Date().toISOString() });
  assert.equal(await handleEvent(ctx, reserved), true);
  assert.equal(await handleEvent(ctx, reserved), false);
  assert.equal((await outbox(co.checkoutId, 'payment.request')).length, 1);
  const paid = ev('payment.succeeded', co.checkoutId, { paymentId: 'p3', checkoutId: co.checkoutId, amount: 400_000 });
  assert.equal(await handleEvent(ctx, paid), true);
  assert.equal(await handleEvent(ctx, paid), false);
  // Cùng nội dung nhưng id khác (payment phát lại) → vẫn không confirm/commit lần 2
  await handleEvent(ctx, ev('payment.succeeded', co.checkoutId, { paymentId: 'p3', checkoutId: co.checkoutId, amount: 400_000 }));
  assert.equal((await outbox(co.checkoutId, 'inventory.commit')).length, 1);
  assert.equal((await outbox(co.checkoutId, 'order.confirmed')).length, 2);
  assert.equal((await outbox(co.checkoutId, 'payment.refund')).length, 0);
});

test('validate: chưa đăng nhập 401, SKU ngừng bán 400, thiếu địa chỉ 400, admin stats', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/checkout', payload: {} })).statusCode, 401);
  const off = await checkout({ items: [{ skuId: SKU_OFF, qty: 1 }], shippingAddress: ADDRESS, paymentMethod: 'COD' });
  assert.equal(off.statusCode, 400);
  assert.equal(off.json().error.code, 'VALIDATION_ERROR');
  assert.match(off.json().error.message, /không còn bán/);
  const missing = await checkout({ items: [{ skuId: newId(), qty: 1 }], shippingAddress: ADDRESS, paymentMethod: 'COD' });
  assert.equal(missing.statusCode, 400);
  assert.equal((await checkout({ items: [{ skuId: SKU_A1, qty: 1 }], paymentMethod: 'COD' })).statusCode, 400);
  const viaId = await checkout({ items: [{ skuId: SKU_A1, qty: 1 }], addressId: 'addr-1', paymentMethod: 'COD' });
  assert.equal(viaId.statusCode, 201, viaId.body);

  const stats = (await app.inject({ method: 'GET', url: '/admin/stats', headers: auth(adminT) })).json();
  assert.ok(stats.gmv > 0);
  assert.ok(stats.cancelRate > 0 && stats.cancelRate < 1);
  const list = (await app.inject({ method: 'GET', url: '/admin/orders?status=CANCELLED&pageSize=5', headers: auth(adminT) })).json();
  assert.equal(list.pageSize, 5);
  assert.ok(list.total >= 2);
  assert.equal((await app.inject({ method: 'GET', url: '/admin/orders?status=FOO', headers: auth(adminT) })).statusCode, 400);
  const mine = (await app.inject({ method: 'GET', url: '/orders?page=1&pageSize=2', headers: auth(buyer) })).json();
  assert.equal(mine.items.length, 2);
});
