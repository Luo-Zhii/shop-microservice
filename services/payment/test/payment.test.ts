import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import type { EventEnvelope, OrderSnapshot } from '@shopnow/contracts';
import { registerRoutes } from '../src/routes';
import { handleEvent, settlementOf, type Ctx } from '../src/payments';
import { sign, signData, verify } from '../src/vnpay';
import type { PaymentConfig } from '../src/config';

const cfg: PaymentConfig = {
  PUBLIC_BASE_URL: 'http://gw.test/api/payment',
  VNPAY_TMN_CODE: 'TESTTMN1',
  VNPAY_HASH_SECRET: 'SECRETSECRETSECRETSECRETSECRET12',
  VNPAY_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_EXPIRE_MINUTES: 15,
  PLATFORM_COMMISSION_RATE: 0.05,
  MIN_PAYOUT: 50_000,
};

let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
let ctx: Ctx;
const svc = createService('payment-test');
const app = svc.app;
let buyer: string;

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('payment_test', join(__dirname, '../migrations'));
  ctx = { pool, cfg };
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), cfg });
  await app.ready();
  buyer = await jwks.sign('buyer-1');
});
after(async () => {
  await app.close();
  await pool.end();
  await jwks.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const ev = <T>(type: string, subject: string, data: T): EventEnvelope<T> => ({ id: newId(), type, source: 'order', time: new Date().toISOString(), subject, data });
const outbox = async (checkoutId: string, type: string) =>
  (await pool.query(`SELECT payload FROM outbox WHERE payload->>'subject' = $1 AND payload->>'type' = $2 ORDER BY created_at`, [checkoutId, type])).rows.map((r) => r.payload);
const payment = async (checkoutId: string) => (await pool.query('SELECT * FROM payments WHERE checkout_id = $1', [checkoutId])).rows[0];

async function request(method: 'MOCK' | 'VNPAY' | 'COD', amount = 400_000) {
  const checkoutId = newId();
  const orderIds = [newId(), newId()];
  const r = await handleEvent(ctx, ev('payment.request', checkoutId, { checkoutId, buyerId: 'buyer-1', amount, method, orderIds, returnUrl: `http://web.test/checkout/result?checkoutId=${checkoutId}` }));
  assert.equal(r, true);
  return { checkoutId, orderIds };
}

function snapshot(over: Partial<OrderSnapshot>): OrderSnapshot {
  return {
    id: newId(), checkoutId: newId(), buyerId: 'buyer-1', shopId: 'shop-a', status: 'COMPLETED', items: [],
    subtotal: 210_000, shippingFee: 30_000, discount: 10_000, total: 230_000, paymentMethod: 'MOCK',
    shippingAddress: { fullName: 'A', phone: '0900000000', line1: 'x', ward: 'x', district: 'x', province: 'x' },
    createdAt: new Date().toISOString(), ...over,
  };
}

test('MOCK: payment.request idempotent → trang mock → thành công → payment.succeeded + redirect returnUrl', async () => {
  const { checkoutId } = await request('MOCK');
  // lệnh trùng (id sự kiện khác) không tạo payment thứ hai
  await handleEvent(ctx, ev('payment.request', checkoutId, { checkoutId, buyerId: 'buyer-1', amount: 400_000, method: 'MOCK', orderIds: [] }));
  assert.equal((await pool.query('SELECT count(*)::int n FROM payments WHERE checkout_id = $1', [checkoutId])).rows[0].n, 1);
  const p = await payment(checkoutId);
  const [created] = await outbox(checkoutId, 'payment.created');
  assert.equal(created.data.redirectUrl, `http://gw.test/api/payment/pay/mock/${p.id}`);
  assert.equal((await outbox(checkoutId, 'payment.created')).length, 1);

  const page = await app.inject({ method: 'GET', url: `/pay/mock/${p.id}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.match(page.body, /400\.000/);
  assert.match(page.body, /name="viewport"/);
  assert.match(page.body, new RegExp(`action="${p.id}/complete"`));
  assert.equal((await app.inject({ method: 'GET', url: `/pay/mock/${newId()}` })).statusCode, 404);

  const done = await app.inject({
    method: 'POST', url: `/pay/mock/${p.id}/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'result=success',
  });
  assert.equal(done.statusCode, 303);
  assert.equal(done.headers.location, `http://web.test/checkout/result?checkoutId=${checkoutId}`);
  const [ok] = await outbox(checkoutId, 'payment.succeeded');
  assert.deepEqual(ok.data, { paymentId: p.id, checkoutId, amount: 400_000 });
  // bấm lại "thất bại" sau khi đã thành công → không đổi
  const again = await app.inject({ method: 'POST', url: `/pay/mock/${p.id}/complete`, payload: { result: 'fail' } });
  assert.equal(again.json().status, 'SUCCEEDED');
  assert.equal((await outbox(checkoutId, 'payment.failed')).length, 0);
  assert.ok((await pool.query('SELECT count(*)::int n FROM payment_events WHERE payment_id = $1', [p.id])).rows[0].n >= 2);

  const mine = await app.inject({ method: 'GET', url: `/payments/${checkoutId}`, headers: auth(buyer) });
  assert.equal(mine.json().status, 'SUCCEEDED');
  assert.equal((await app.inject({ method: 'GET', url: `/payments/${checkoutId}`, headers: auth(await jwks.sign('other')) })).statusCode, 404);
});

test('MOCK thất bại → payment.failed', async () => {
  const { checkoutId } = await request('MOCK');
  const p = await payment(checkoutId);
  const r = await app.inject({ method: 'POST', url: `/pay/mock/${p.id}/complete`, payload: { result: 'fail' } });
  assert.equal(r.json().status, 'FAILED');
  assert.equal((await outbox(checkoutId, 'payment.failed')).length, 1);
});

test('VNPay: URL ký HMAC-SHA512 đúng chuẩn 2.1.0; IPN verify chữ ký, idempotent, đúng RspCode', async () => {
  const { checkoutId } = await request('VNPAY', 150_000);
  const p = await payment(checkoutId);
  const url = new URL(p.redirect_url);
  assert.equal(`${url.origin}${url.pathname}`, cfg.VNPAY_URL);
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.vnp_Version, '2.1.0');
  assert.equal(q.vnp_Command, 'pay');
  assert.equal(q.vnp_Amount, '15000000');
  assert.equal(q.vnp_TmnCode, 'TESTTMN1');
  assert.equal(q.vnp_ReturnUrl, 'http://gw.test/api/payment/pay/vnpay/return');
  assert.match(q.vnp_CreateDate, /^\d{14}$/);
  assert.equal(q.vnp_SecureHash.length, 128);
  assert.ok(verify(q, cfg.VNPAY_HASH_SECRET), 'chữ ký trên URL hợp lệ');
  // Chuỗi ký: sắp xếp theo tên, khoảng trắng → '+'
  assert.match(signData(q), /^vnp_Amount=15000000&vnp_Command=pay&vnp_CreateDate=/);
  assert.match(signData(q), /vnp_OrderInfo=Thanh\+toan\+don\+hang\+/);

  const cb = (over: Record<string, string>) => {
    const params: Record<string, string> = {
      vnp_Amount: '15000000', vnp_BankCode: 'NCB', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TmnCode: 'TESTTMN1',
      vnp_TransactionNo: '14000001', vnp_TxnRef: p.txn_ref, vnp_OrderInfo: 'Thanh toan don hang', vnp_PayDate: '20261108120000', ...over,
    };
    return { ...params, vnp_SecureHashType: 'HmacSHA512', vnp_SecureHash: sign(params, cfg.VNPAY_HASH_SECRET) };
  };
  const ipn = async (params: Record<string, string>) => (await app.inject({ method: 'GET', url: `/pay/vnpay/ipn?${new URLSearchParams(params)}` })).json();

  assert.deepEqual(await ipn({ ...cb({}), vnp_Amount: '1' }), { RspCode: '97', Message: 'Invalid Checksum' });
  assert.equal((await ipn(cb({ vnp_TxnRef: 'khongco' }))).RspCode, '01');
  assert.equal((await ipn(cb({ vnp_Amount: '100' }))).RspCode, '04');
  assert.deepEqual(await ipn(cb({})), { RspCode: '00', Message: 'Confirm Success' });
  assert.equal((await ipn(cb({}))).RspCode, '02');
  assert.equal((await outbox(checkoutId, 'payment.succeeded')).length, 1);
  assert.equal((await payment(checkoutId)).provider_txn_no, '14000001');

  // Return URL sau IPN → không đổi gì, chuyển về FE
  const ret = await app.inject({ method: 'GET', url: `/pay/vnpay/return?${new URLSearchParams(cb({}))}` });
  assert.equal(ret.statusCode, 303);
  assert.equal(ret.headers.location, `http://web.test/checkout/result?checkoutId=${checkoutId}`);
  const bad = await app.inject({ method: 'GET', url: `/pay/vnpay/return?${new URLSearchParams({ ...cb({}), vnp_ResponseCode: '24' })}` });
  assert.equal(bad.statusCode, 400);

  // Giao dịch khác bị khách huỷ (ResponseCode 24) → payment.failed
  const second = await request('VNPAY', 50_000);
  const p2 = await payment(second.checkoutId);
  const params: Record<string, string> = { vnp_Amount: '5000000', vnp_ResponseCode: '24', vnp_TransactionStatus: '02', vnp_TxnRef: p2.txn_ref, vnp_TmnCode: 'TESTTMN1' };
  const r = await app.inject({ method: 'GET', url: `/pay/vnpay/return?${new URLSearchParams({ ...params, vnp_SecureHash: sign(params, cfg.VNPAY_HASH_SECRET) })}` });
  assert.equal(r.statusCode, 303);
  assert.equal((await payment(second.checkoutId)).status, 'FAILED');
  assert.equal((await outbox(second.checkoutId, 'payment.failed')).length, 1);
});

test('COD → PENDING_COD không redirect; đơn 0đ online → thành công ngay', async () => {
  const cod = await request('COD', 99_000);
  assert.equal((await payment(cod.checkoutId)).status, 'PENDING_COD');
  assert.equal((await outbox(cod.checkoutId, 'payment.created'))[0].data.redirectUrl, null);
  const zero = await request('MOCK', 0);
  assert.equal((await payment(zero.checkoutId)).status, 'SUCCEEDED');
  assert.equal((await outbox(zero.checkoutId, 'payment.succeeded')).length, 1);
});

test('hoàn tiền đúng 1 lần theo orderId (payment.refund lặp + order.cancelled); chưa trả thì không hoàn', async () => {
  const { checkoutId, orderIds } = await request('MOCK');
  const p = await payment(checkoutId);
  // chưa thanh toán → order.cancelled / payment.refund không hoàn
  await handleEvent(ctx, ev('order.cancelled', orderIds[0], snapshot({ id: orderIds[0], checkoutId, status: 'CANCELLED', reason: 'PAYMENT_TIMEOUT' })));
  await handleEvent(ctx, ev('payment.refund', checkoutId, { checkoutId, orderId: orderIds[0], amount: 100, reason: 'X' }));
  assert.equal((await outbox(checkoutId, 'payment.refunded')).length, 0);

  await app.inject({ method: 'POST', url: `/pay/mock/${p.id}/complete`, payload: { result: 'success' } });
  const refund = { checkoutId, orderId: orderIds[1], amount: 230_000, reason: 'BUYER_CANCELLED' };
  assert.equal(await handleEvent(ctx, ev('payment.refund', checkoutId, refund)), true);
  await handleEvent(ctx, ev('payment.refund', checkoutId, refund));
  await handleEvent(ctx, ev('order.cancelled', orderIds[1], snapshot({ id: orderIds[1], checkoutId, status: 'CANCELLED', total: 230_000, reason: 'BUYER_CANCELLED' })));
  const refunded = await outbox(checkoutId, 'payment.refunded');
  assert.equal(refunded.length, 1);
  assert.deepEqual(refunded[0].data, { checkoutId, orderId: orderIds[1], amount: 230_000 });

  // order.cancelled của order còn lại (đã trả) → tự hoàn phần còn lại, không vượt số đã trả
  await handleEvent(ctx, ev('order.cancelled', orderIds[0], snapshot({ id: orderIds[0], checkoutId, status: 'CANCELLED', total: 999_999 })));
  const after = await outbox(checkoutId, 'payment.refunded');
  assert.equal(after.length, 2);
  assert.equal(after[1].data.amount, 400_000 - 230_000);
  assert.equal(Number((await payment(checkoutId)).refunded_amount), 400_000);
  const view = (await app.inject({ method: 'GET', url: `/payments/${checkoutId}`, headers: auth(buyer) })).json();
  assert.equal(view.refunds.length, 2);
});

test('order.completed → ghi có ví seller (trừ ship + 5% phí sàn), đúng 1 lần; rút tiền + admin chi trả', async () => {
  assert.deepEqual(settlementOf({ subtotal: 210_000, discount: 10_000, shippingFee: 30_000, total: 230_000 }, 0.05), { commission: 10_000, net: 190_000 });
  assert.deepEqual(settlementOf({ subtotal: 99_999, discount: 0, shippingFee: 0, total: 99_999 }, 0.05), { commission: 5_000, net: 94_999 });

  const shop = 'shop-wallet';
  const o1 = snapshot({ shopId: shop });
  const e1 = ev('order.completed', o1.id, o1);
  assert.equal(await handleEvent(ctx, e1), true);
  assert.equal(await handleEvent(ctx, e1), false);
  await handleEvent(ctx, ev('order.completed', o1.id, o1)); // phát lại với id khác
  const cod = await request('COD', 120_000);
  const o2 = snapshot({ shopId: shop, checkoutId: cod.checkoutId, paymentMethod: 'COD', subtotal: 100_000, discount: 0, shippingFee: 20_000, total: 120_000 });
  await handleEvent(ctx, ev('order.completed', o2.id, o2));
  assert.equal((await pool.query('SELECT cod_collected FROM settlements WHERE order_id = $1', [o2.id])).rows[0].cod_collected, true);
  assert.equal((await payment(cod.checkoutId)).status, 'SUCCEEDED');

  const sellerT = await jwks.sign('seller-w', ['seller'], { shopId: shop });
  const w = (await app.inject({ method: 'GET', url: '/seller/wallet', headers: auth(sellerT) })).json();
  assert.equal(w.available, 190_000 + 95_000);
  assert.equal(w.totalEarned, 285_000);
  assert.equal(w.history.total, 2);

  const tooMuch = await app.inject({ method: 'POST', url: '/seller/payouts', headers: auth(sellerT), payload: { amount: 300_000 } });
  assert.equal(tooMuch.statusCode, 400);
  assert.match(tooMuch.json().error.message, /không đủ/);
  assert.equal((await app.inject({ method: 'POST', url: '/seller/payouts', headers: auth(sellerT), payload: { amount: 10_000 } })).statusCode, 400);
  const req = await app.inject({ method: 'POST', url: '/seller/payouts', headers: auth(sellerT), payload: { amount: 200_000 } });
  assert.equal(req.statusCode, 201, req.body);
  const w2 = (await app.inject({ method: 'GET', url: '/seller/wallet', headers: auth(sellerT) })).json();
  assert.equal(w2.available, 85_000);
  assert.equal(w2.pending, 200_000);

  const adminT = await jwks.sign('admin', ['admin']);
  assert.equal((await app.inject({ method: 'GET', url: '/admin/payouts', headers: auth(sellerT) })).statusCode, 403);
  const list = (await app.inject({ method: 'GET', url: '/admin/payouts?status=REQUESTED', headers: auth(adminT) })).json();
  assert.ok(list.items.some((x: { id: string }) => x.id === req.json().id));
  const paid = await app.inject({ method: 'POST', url: `/admin/payouts/${req.json().id}/paid`, headers: auth(adminT) });
  assert.equal(paid.json().status, 'PAID');
  assert.equal((await app.inject({ method: 'POST', url: `/admin/payouts/${req.json().id}/paid`, headers: auth(adminT) })).statusCode, 409);
  const w3 = (await app.inject({ method: 'GET', url: '/seller/wallet', headers: auth(sellerT) })).json();
  assert.equal(w3.pending, 0);
  assert.equal(w3.totalPaidOut, 200_000);
  assert.equal(w3.available, 85_000);
});
