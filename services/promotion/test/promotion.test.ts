import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Redis from 'ioredis';
import { createAuth, createPool, createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import type { EventEnvelope, OrderSnapshot } from '@shopnow/contracts';
import { registerRoutes } from '../src/routes';
import { sweepStaleLocks } from '../src/sweeper';
import { createFlashStore, type FlashStore } from '../src/flash';
import { handleOrderEvent } from '../src/consumers';
import { allocate } from '../src/engine';

const SHOP_A = 'shop-a';
const SHOP_B = 'shop-b';
const PREFIX = `test:promo:${Date.now()}:`;

let pool: Pool;
let redis: Redis;
let flash: FlashStore;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const svc = createService('promotion-test');
const app = svc.app;
let adminT: string;
let sellerA: string;
const INTERNAL = { 'x-internal-token': 'test-internal' };

before(async () => {
  jwks = await startTestJwks();
  const fresh = await freshTestDb('promotion_test', join(__dirname, '../migrations'));
  await fresh.end();
  // Pool cỡ như service thật (freshTestDb chỉ mở 5 kết nối) để chịu được 200 request đồng thời.
  const u = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://shopnow:shopnow@localhost:55432/postgres');
  u.pathname = '/promotion_test';
  pool = createPool(u.toString(), 20, 60_000) // máy CI/dev chậm: chờ kết nối tới 60s thay vì trả 500;
  redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379', { maxRetriesPerRequest: 2 });
  flash = createFlashStore(redis, PREFIX);
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), flash });
  await app.ready();
  adminT = await jwks.sign('admin-1', ['admin']);
  sellerA = await jwks.sign('seller-a', ['buyer', 'seller'], { shopId: SHOP_A });
});
after(async () => {
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  await app.close();
  await pool.end();
  await jwks.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const hour = 3_600_000;
const window = () => ({ startsAt: new Date(Date.now() - hour).toISOString(), endsAt: new Date(Date.now() + hour).toISOString() });

async function createVoucher(token: string, scope: 'seller' | 'admin', body: Record<string, unknown>) {
  const r = await app.inject({ method: 'POST', url: `/${scope}/vouchers`, headers: auth(token), payload: { title: 'Ưu đãi', ...window(), ...body } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function createFlashSale(items: Record<string, unknown>[]) {
  const r = await app.inject({ method: 'POST', url: '/admin/flash-sales', headers: auth(adminT), payload: { name: 'Flash 12h', ...window(), items } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
function quoteReq(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/quote', headers: INTERNAL, payload: body });
}
const shopsAB = [
  { shopId: SHOP_A, items: [{ skuId: 'sku-a1', productId: 'p-a1', price: 300_000, qty: 1 }], shippingFee: 30_000 },
  { shopId: SHOP_B, items: [{ skuId: 'sku-b1', productId: 'p-b1', price: 100_000, qty: 1 }], shippingFee: 20_000 },
];
const orderEvent = (type: string, checkoutId: string, shopId: string, skuIds: string[], reason?: string): EventEnvelope<OrderSnapshot> => ({
  id: newId(), type, source: 'order', time: new Date().toISOString(), subject: newId(),
  data: {
    id: newId(), checkoutId, buyerId: 'b', shopId, status: type === 'order.cancelled' ? 'CANCELLED' : 'CONFIRMED',
    items: skuIds.map((skuId) => ({ skuId, productId: 'p', title: 't', variantLabel: '', unitPrice: 1, qty: 1, lineTotal: 1 })),
    subtotal: 0, shippingFee: 0, discount: 0, total: 0, paymentMethod: 'COD',
    shippingAddress: { fullName: 'A', phone: '0900000000', line1: 'x', ward: 'x', district: 'x', province: 'x' },
    createdAt: new Date().toISOString(), ...(reason ? { reason } : {}),
  },
});
const redemptionStatus = async (checkoutId: string) =>
  (await pool.query(`SELECT v.code, r.status FROM redemptions r JOIN vouchers v ON v.id = r.voucher_id WHERE checkout_id = $1 ORDER BY v.code`, [checkoutId])).rows;

test('chia tỉ lệ số nguyên: tổng luôn đúng', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(50_000, [300_000, 100_000]), [37_500, 12_500]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  const parts = allocate(99_999, [7, 13, 29]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 99_999);
});

test('200 lệnh giữ suất flash sale đồng thời, quota 10 → đúng 10 thành công (qua /quote commit=true)', async () => {
  const sale = await createFlashSale([{ skuId: 'sku-flash', productId: 'p-flash', salePrice: 99_000, quota: 10, perUserLimit: 1 }]);
  const itemId = sale.items[0].id;
  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      quoteReq({
        checkoutId: newId(), buyerId: `buyer-${i}`, commit: true,
        shops: [{ shopId: SHOP_A, items: [{ skuId: 'sku-flash', productId: 'p-flash', price: 199_000, qty: 1 }], shippingFee: 0 }],
      }),
    ),
  );
  assert.ok(results.every((r) => r.statusCode === 200), results.find((r) => r.statusCode !== 200)?.body);
  const won = results.filter((r) => r.json().shops[0].items[0].unitPrice === 99_000);
  assert.equal(won.length, 10);
  assert.equal(results.filter((r) => r.json().shops[0].items[0].unitPrice === 199_000).length, 190, 'hết suất → giá thường');
  assert.equal(Number(await redis.get(flash.keys.sold(itemId))), 10);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM flash_sale_holds WHERE item_id = $1`, [itemId])).rows[0].n, 10);
  const active = (await app.inject({ method: 'GET', url: '/flash-sales/active' })).json();
  const it = active.items.find((s: { id: string }) => s.id === sale.id).items[0];
  assert.equal(it.remaining, 0);
  assert.equal(it.sold, 10);
});

test('Lua giữ suất trực tiếp: 200 lệnh đồng thời, quota 10, perUserLimit 2', async () => {
  const sale = await createFlashSale([{ skuId: 'sku-lua', productId: 'p-lua', salePrice: 1_000, quota: 10, perUserLimit: 2 }]);
  const item = { id: sale.items[0].id, sku_id: 'sku-lua', sale_price: 1_000, quota: 10, per_user_limit: 2 };
  const res = await Promise.all(Array.from({ length: 200 }, (_, i) => flash.reserve(item, newId(), `u-${i % 3}`, 1)));
  // 3 người × tối đa 2 suất = 6 < quota 10
  assert.equal(res.filter((r) => r.ok).length, 6);
  assert.ok(res.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'USER_LIMIT'));
  const res2 = await Promise.all(Array.from({ length: 200 }, (_, i) => flash.reserve(item, newId(), `v-${i}`, 1)));
  assert.equal(res2.filter((r) => r.ok).length, 4);
  assert.equal(Number(await redis.get(flash.keys.sold(item.id))), 10);
});

test('perUserLimit flash sale + quote idempotent theo checkoutId + nhả suất khi order.cancelled', async () => {
  const sale = await createFlashSale([{ skuId: 'sku-x', productId: 'p-x', salePrice: 50_000, quota: 5, perUserLimit: 1 }]);
  const itemId = sale.items[0].id;
  const body = (checkoutId: string) => ({
    checkoutId, buyerId: 'buyer-x', commit: true,
    shops: [{ shopId: SHOP_A, items: [{ skuId: 'sku-x', productId: 'p-x', price: 80_000, qty: 1 }], shippingFee: 10_000 }],
  });
  const co1 = newId();
  const q1 = (await quoteReq(body(co1))).json();
  assert.equal(q1.shops[0].items[0].unitPrice, 50_000);
  assert.equal(q1.flashSaleSavings, 30_000);
  // gọi lại cùng checkoutId → cùng kết quả, không giữ thêm
  assert.deepEqual((await quoteReq(body(co1))).json(), q1);
  assert.equal(Number(await redis.get(flash.keys.sold(itemId))), 1);
  // checkout khác cùng người mua → vượt perUserLimit → giá thường
  const co2 = newId();
  assert.equal((await quoteReq(body(co2))).json().shops[0].items[0].unitPrice, 80_000);
  // checkoutId của người khác → 409
  assert.equal((await quoteReq({ ...body(co1), buyerId: 'buyer-y' })).statusCode, 409);

  // order.cancelled → nhả suất (đúng 1 lần dù sự kiện lặp)
  const cancel = orderEvent('order.cancelled', co1, SHOP_A, ['sku-x'], 'BUYER_CANCELLED');
  assert.equal(await handleOrderEvent({ pool, flash }, cancel), true);
  assert.equal(await handleOrderEvent({ pool, flash }, cancel), false);
  await handleOrderEvent({ pool, flash }, { ...cancel, id: newId() });
  assert.equal(Number(await redis.get(flash.keys.sold(itemId))), 0);
  assert.equal((await pool.query(`SELECT status FROM flash_sale_holds WHERE checkout_id = $1`, [co1])).rows[0].status, 'RELEASED');
  // đã được nhả → người mua lại được giá flash sale
  assert.equal((await quoteReq(body(newId()))).json().shops[0].items[0].unitPrice, 50_000);
});

test('voucher: shop PERCENT có trần, sàn FIXED chia tỉ lệ, FREESHIP; commit=false không khoá', async () => {
  await createVoucher(sellerA, 'seller', { code: 'shopa20', type: 'PERCENT', value: 20, maxDiscount: 50_000, minOrder: 100_000 });
  await createVoucher(adminT, 'admin', { code: 'SAN40K', type: 'FIXED', value: 40_000, minOrder: 200_000, perUserLimit: 1 });
  await createVoucher(adminT, 'admin', { code: 'FREESHIP', type: 'FREESHIP', maxDiscount: 40_000 });

  const req = { buyerId: 'buyer-v', shops: shopsAB, voucherCodes: ['SHOPA20', 'san40k', 'FREESHIP'] };
  const preview = await quoteReq({ ...req, commit: false });
  assert.equal(preview.statusCode, 200, preview.body);
  const q = preview.json();
  const a = q.shops.find((s: { shopId: string }) => s.shopId === SHOP_A);
  const b = q.shops.find((s: { shopId: string }) => s.shopId === SHOP_B);
  assert.equal(a.shopDiscount, 50_000); // 20% của 300k = 60k, trần 50k
  // sàn 40k chia theo (300k-50k) : 100k = 250:100
  assert.equal(a.platformDiscount + b.platformDiscount, 40_000);
  assert.equal(a.platformDiscount, 28_571);
  assert.equal(b.platformDiscount, 11_429);
  assert.equal(a.discount, 50_000 + 28_571);
  // freeship sàn tối đa 40k trên tổng phí 50k, chia theo phí 30k:20k
  assert.equal(a.shippingDiscount + b.shippingDiscount, 40_000);
  assert.equal(a.shippingDiscount, 24_000);
  assert.equal(q.platformDiscount, 40_000);
  assert.equal(q.totalDiscount, 50_000 + 40_000 + 40_000);
  assert.ok(a.appliedVouchers.some((v: { code: string }) => v.code === 'SHOPA20'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM redemptions')).rows[0].n, 0, 'commit=false không ghi redemption');

  // commit=true → LOCKED; perUserLimit=1 của voucher sàn chặn lần thứ hai
  const co = newId();
  const committed = await quoteReq({ ...req, checkoutId: co, commit: true });
  assert.equal(committed.statusCode, 200, committed.body);
  assert.deepEqual((await redemptionStatus(co)).map((r) => r.status), ['LOCKED', 'LOCKED', 'LOCKED']);
  const again = await quoteReq({ ...req, checkoutId: newId(), commit: true });
  assert.equal(again.statusCode, 400);
  assert.match(again.json().error.message, /hết lượt của mã/);

  // order.confirmed shop A → voucher shop A + voucher sàn USED
  await handleOrderEvent({ pool, flash }, orderEvent('order.confirmed', co, SHOP_A, ['sku-a1']));
  assert.deepEqual(await redemptionStatus(co), [
    { code: 'FREESHIP', status: 'USED' }, { code: 'SAN40K', status: 'USED' }, { code: 'SHOPA20', status: 'USED' },
  ]);
  // người mua huỷ đơn shop A → nhả voucher shop A, KHÔNG nhả voucher sàn / freeship sàn
  await handleOrderEvent({ pool, flash }, orderEvent('order.cancelled', co, SHOP_A, ['sku-a1'], 'BUYER_CANCELLED'));
  assert.deepEqual(await redemptionStatus(co), [
    { code: 'FREESHIP', status: 'USED' }, { code: 'SAN40K', status: 'USED' }, { code: 'SHOPA20', status: 'RELEASED' },
  ]);
});

test('voucher sàn chỉ được nhả khi huỷ vì OUT_OF_STOCK / PAYMENT_FAILED / PAYMENT_TIMEOUT', async () => {
  await createVoucher(adminT, 'admin', { code: 'SAN10', type: 'PERCENT', value: 10, perUserLimit: 1 });
  const co = newId();
  const r = await quoteReq({ checkoutId: co, buyerId: 'buyer-t', shops: shopsAB, voucherCodes: ['SAN10'], commit: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().platformDiscount, 40_000);
  await handleOrderEvent({ pool, flash }, orderEvent('order.cancelled', co, SHOP_A, ['sku-a1'], 'PAYMENT_TIMEOUT'));
  assert.deepEqual(await redemptionStatus(co), [{ code: 'SAN10', status: 'RELEASED' }]);
  // đã nhả → người mua dùng lại được
  const r2 = await quoteReq({ checkoutId: newId(), buyerId: 'buyer-t', shops: shopsAB, voucherCodes: ['SAN10'], commit: true });
  assert.equal(r2.statusCode, 200, r2.body);
});

test('voucher không hợp lệ → VALIDATION_ERROR rõ ràng; usageLimit không vượt khi đồng thời', async () => {
  const bad = async (codes: string[], shops = shopsAB) => {
    const r = await quoteReq({ buyerId: 'buyer-e', shops, voucherCodes: codes, commit: false });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error.code, 'VALIDATION_ERROR');
    return r.json().error.message as string;
  };
  assert.match(await bad(['KHONGCO']), /không tồn tại/);
  await createVoucher(sellerA, 'seller', { code: 'SHOPA5K', type: 'FIXED', value: 5_000 });
  assert.match(await bad(['SHOPA20', 'SHOPA5K']), /1 mã giảm giá của shop/);
  assert.match(await bad(['SHOPA5K'], [shopsAB[1]]), /không áp dụng/);
  assert.match(await bad(['SHOPA20'], [{ ...shopsAB[0], items: [{ skuId: 's', productId: 'p', price: 50_000, qty: 1 }] }]), /tối thiểu 100\.000đ/);
  await createVoucher(adminT, 'admin', {
    code: 'HETHAN', type: 'FIXED', value: 1_000,
    startsAt: new Date(Date.now() - 2 * hour).toISOString(), endsAt: new Date(Date.now() - hour).toISOString(),
  });
  assert.match(await bad(['HETHAN']), /hết hạn/);
  // seller không tạo được trùng mã
  const dup = await app.inject({ method: 'POST', url: '/seller/vouchers', headers: auth(sellerA), payload: { code: 'SHOPA5K', title: 'Ưu đãi', type: 'FIXED', value: 1, ...window() } });
  assert.equal(dup.statusCode, 409);
  // percent > 100
  const pct = await app.inject({ method: 'POST', url: '/admin/vouchers', headers: auth(adminT), payload: { code: 'P200', title: 'Ưu đãi', type: 'PERCENT', value: 200, ...window() } });
  assert.equal(pct.statusCode, 400);

  // usageLimit 3, 20 checkout đồng thời của 20 người → đúng 3 thành công
  await createVoucher(adminT, 'admin', { code: 'GIOIHAN3', type: 'FIXED', value: 1_000, usageLimit: 3, perUserLimit: null });
  const res = await Promise.all(
    Array.from({ length: 20 }, (_, i) => quoteReq({ checkoutId: newId(), buyerId: `u${i}`, shops: shopsAB, voucherCodes: ['GIOIHAN3'], commit: true })),
  );
  assert.equal(res.filter((r) => r.statusCode === 200).length, 3);
  assert.ok(res.filter((r) => r.statusCode !== 200).every((r) => /hết lượt sử dụng/.test(r.json().error.message)));
  // hết lượt → không còn trong danh sách công khai
  const pub = (await app.inject({ method: 'GET', url: '/vouchers' })).json();
  assert.ok(!pub.items.some((v: { code: string }) => v.code === 'GIOIHAN3'));
  assert.ok(pub.items.some((v: { code: string }) => v.code === 'SAN40K' || v.code === 'FREESHIP'));
});

test('CRUD voucher: phân quyền seller/admin, GET /vouchers?shopId, xoá voucher đã dùng → tắt', async () => {
  const buyer = await jwks.sign('buyer-1');
  assert.equal((await app.inject({ method: 'POST', url: '/admin/vouchers', headers: auth(sellerA), payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/seller/vouchers', headers: auth(buyer) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/quote', payload: {} })).statusCode, 403);

  const v = await createVoucher(sellerA, 'seller', { code: 'SHOPAFS', type: 'FREESHIP', minOrder: 0 });
  assert.equal(v.scope, 'SHOP');
  assert.equal(v.shopId, SHOP_A);
  const list = (await app.inject({ method: 'GET', url: '/seller/vouchers', headers: auth(sellerA) })).json();
  assert.ok(list.items.every((x: { shopId: string }) => x.shopId === SHOP_A));
  const pub = (await app.inject({ method: 'GET', url: `/vouchers?shopId=${SHOP_A}` })).json();
  assert.ok(pub.items.some((x: { code: string }) => x.code === 'SHOPAFS'));

  const upd = await app.inject({ method: 'PUT', url: `/seller/vouchers/${v.id}`, headers: auth(sellerA), payload: { title: 'Freeship shop A', type: 'FREESHIP', ...window(), active: false } });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().active, false);
  // seller khác không sửa được
  const sellerB = await jwks.sign('seller-b', ['seller'], { shopId: SHOP_B });
  assert.equal((await app.inject({ method: 'PUT', url: `/seller/vouchers/${v.id}`, headers: auth(sellerB), payload: { title: 'Ưu đãi', type: 'FREESHIP', ...window() } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/seller/vouchers/${v.id}`, headers: auth(sellerA) })).json().deleted, true);

  const used = (await pool.query(`SELECT id FROM vouchers WHERE code = 'SHOPA20'`)).rows[0].id;
  assert.equal((await app.inject({ method: 'DELETE', url: `/seller/vouchers/${used}`, headers: auth(sellerA) })).json().deactivated, true);

  const fs = (await app.inject({ method: 'GET', url: '/admin/flash-sales', headers: auth(adminT) })).json();
  assert.ok(fs.items.length >= 3);
});

test('sweeper nhả voucher LOCKED bị bỏ quên sau TTL; order.confirmed tới muộn vẫn chuyển USED', async () => {
  await createVoucher(adminT, 'admin', { code: 'BOQUEN', type: 'FIXED', value: 5_000, perUserLimit: 1 });
  const co = newId();
  const r = await quoteReq({ checkoutId: co, buyerId: 'buyer-sweep', shops: shopsAB, voucherCodes: ['BOQUEN'], commit: true });
  assert.equal(r.statusCode, 200, r.body);
  // chưa quá TTL → không nhả
  assert.deepEqual(await sweepStaleLocks({ pool, flash }, 1800), { vouchers: 0, flashHolds: 0 });
  // giả lập thời điểm 31 phút sau
  const later = new Date(Date.now() + 31 * 60_000);
  const swept = await sweepStaleLocks({ pool, flash }, 1800, later);
  assert.ok(swept.vouchers >= 1);
  assert.deepEqual(await redemptionStatus(co), [{ code: 'BOQUEN', status: 'RELEASED' }]);
  // nếu đơn thật ra đã xác nhận (Kafka trễ) → vẫn ghi nhận USED, không mất dấu
  await handleOrderEvent({ pool, flash }, orderEvent('order.confirmed', co, SHOP_A, ['sku-a1']));
  assert.deepEqual(await redemptionStatus(co), [{ code: 'BOQUEN', status: 'USED' }]);
});
