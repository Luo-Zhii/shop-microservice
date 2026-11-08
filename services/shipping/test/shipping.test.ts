import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createEvent, createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import type { EventEnvelope, OrderSnapshot } from '@shopnow/contracts';
import { ALL_PROVINCES, resolveProvince } from '../src/provinces';
import { quote, standardFee } from '../src/pricing';
import { advanceDue, registerRoutes, signWebhook } from '../src/routes';
import { createShipmentForOrder, handleOrderEvent, type ConsumerDeps } from '../src/consumers';

const SECRET = 'test-secret';
let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
let deps: ConsumerDeps;
const svc = createService('shipping-test');
const app = svc.app;
const SHOP = newId();
const pickup = new Map<string, string | null>([[SHOP, 'Hà Nội']]);
let sellerDown = false;

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('shipping_test', join(__dirname, '../migrations'));
  deps = {
    pool,
    log: svc.log,
    defaultPickupProvince: 'Hồ Chí Minh',
    shops: {
      async getPickupProvince(id) {
        if (sellerDown) throw new Error('seller down');
        return pickup.get(id) ?? null;
      },
    },
    weights: { getWeights: async (ids) => new Map(ids.map((id) => [id, 700])) },
  };
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), webhookSecret: SECRET, devSimulator: true });
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
  await jwks.close();
});

function orderEvent(type: string, o: Partial<OrderSnapshot> = {}): EventEnvelope<OrderSnapshot> {
  const id = o.id ?? newId();
  return createEvent(type, 'order', id, {
    id, checkoutId: newId(), buyerId: o.buyerId ?? newId(), shopId: o.shopId ?? SHOP, status: 'CONFIRMED',
    items: [{ skuId: newId(), productId: newId(), title: 'Áo', variantLabel: 'M', unitPrice: 100_000, qty: 2, lineTotal: 200_000 }],
    subtotal: 200_000, shippingFee: 30_000, discount: 0, total: 230_000, paymentMethod: 'COD',
    shippingAddress: { fullName: 'Nguyễn Văn A', phone: '0900000000', line1: '1 Lê Lợi', ward: 'Bến Nghé', district: 'Quận 1', province: 'TP. Hồ Chí Minh' },
    createdAt: new Date().toISOString(),
    ...o,
  });
}

test('bảng tỉnh: đủ 63, so khớp không dấu & viết tắt', () => {
  assert.equal(ALL_PROVINCES.length, 63);
  assert.equal(new Set(ALL_PROVINCES).size, 63);
  for (const p of ALL_PROVINCES) assert.ok(resolveProvince(p), p);
  for (const v of ['TP. Hồ Chí Minh', 'Hồ Chí Minh', 'HCM', 'tp hcm', 'Thành phố Hồ Chí Minh', 'ho chi minh']) assert.equal(resolveProvince(v)?.name, 'Hồ Chí Minh', v);
  assert.equal(resolveProvince('thanh hoa')?.region, 'CENTRAL');
  assert.equal(resolveProvince('Tỉnh Hòa Bình')?.name, 'Hoà Bình');
  assert.equal(resolveProvince('Dak Lak')?.name, 'Đắk Lắk');
  assert.equal(resolveProvince('Huế')?.name, 'Thừa Thiên Huế');
  assert.equal(resolveProvince('Atlantis'), null);
});

test('phí chuẩn theo vùng + cân nặng; chọn hãng rẻ nhất', () => {
  assert.equal(standardFee('SAME_PROVINCE', 1000), 20_000);
  assert.equal(standardFee('SAME_REGION', 1001), 35_000);
  assert.equal(standardFee('INTER_REGION', 2000), 50_000);
  const same = quote('Hà Nội', 'hn', 500);
  assert.equal(same.zone, 'SAME_PROVINCE');
  assert.equal(same.fee, Math.min(...same.options.map((o) => o.fee)));
  assert.equal(same.options.length, 3);
  assert.equal(quote('Hà Nội', 'Hải Phòng', 500).zone, 'SAME_REGION');
  const inter = quote('Hà Nội', 'Cần Thơ', 1600);
  assert.equal(inter.zone, 'INTER_REGION');
  assert.ok(inter.options.every((o) => o.fee >= inter.fee && o.etaDays >= 4));
});

test('POST /quote theo hợp đồng + lỗi tỉnh lạ', async () => {
  const r = await app.inject({ method: 'POST', url: '/quote', payload: { fromProvince: 'Hà Nội', toProvince: 'TP. Hồ Chí Minh', weightGrams: 1200 } });
  assert.equal(r.statusCode, 200);
  const q = r.json();
  assert.ok(['GHN', 'GHTK', 'SPX'].includes(q.carrier));
  assert.ok(Number.isInteger(q.fee) && q.fee >= 40_000);
  assert.ok(q.etaDays >= 4);
  const bad = await app.inject({ method: 'POST', url: '/quote', payload: { fromProvince: 'Hà Nội', toProvince: 'Narnia', weightGrams: 100 } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'VALIDATION_ERROR');
});

test('order.confirmed → vận đơn + shipment.created (idempotent); seller pick; webhook HMAC; mô phỏng tới DELIVERED', async () => {
  const buyerId = newId();
  const ev = orderEvent('order.confirmed', { buyerId });
  const s = (await createShipmentForOrder(deps, ev))!;
  assert.ok(s.tracking_code);
  assert.equal(s.from_province, 'Hà Nội');
  assert.equal(s.to_province, 'Hồ Chí Minh');
  assert.equal(s.weight_grams, 1400);
  assert.equal(s.cod_amount, 230_000);
  assert.equal(await handleOrderEvent(deps, ev), null); // bản trùng
  assert.equal((await pool.query('SELECT count(*)::int n FROM shipments WHERE order_id = $1', [ev.data.id])).rows[0].n, 1);
  const out = await pool.query(`SELECT payload FROM outbox WHERE payload->>'type' = 'shipment.created' AND key = $1`, [ev.data.id]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].payload.data.trackingCode, s.tracking_code);

  // quyền xem
  const buyerTok = await jwks.sign(buyerId);
  const other = await jwks.sign(newId());
  const sellerTok = await jwks.sign(newId(), ['seller'], { shopId: SHOP });
  const otherSeller = await jwks.sign(newId(), ['seller'], { shopId: newId() });
  const url = `/shipments/by-order/${ev.data.id}`;
  const view = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${buyerTok}` } });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().timeline.length, 1);
  assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${other}` } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${sellerTok}` } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await jwks.sign('ad', ['admin'])}` } })).statusCode, 200);

  // seller pick
  assert.equal((await app.inject({ method: 'POST', url: `/seller/shipments/${s.id}/pick`, headers: { authorization: `Bearer ${otherSeller}` } })).statusCode, 404);
  const pick = await app.inject({ method: 'POST', url: `/seller/shipments/${s.id}/pick`, headers: { authorization: `Bearer ${sellerTok}` } });
  assert.equal(pick.statusCode, 200, pick.body);
  assert.equal(pick.json().status, 'PICKED');

  // webhook: sai chữ ký → 401; đúng → IN_TRANSIT; gửi lặp → no-op; lùi → 409
  const body = JSON.stringify({ trackingCode: s.tracking_code, status: 'IN_TRANSIT' });
  const hook = (payload: string, sig: string) =>
    app.inject({ method: 'POST', url: '/webhooks/carrier', payload, headers: { 'content-type': 'application/json', 'x-carrier-signature': sig } });
  assert.equal((await hook(body, 'deadbeef')).statusCode, 401);
  assert.equal((await hook(body, signWebhook('wrong', body))).statusCode, 401);
  const ok = await hook(body, signWebhook(SECRET, body));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().changed, true);
  assert.equal((await hook(body, `sha256=${signWebhook(SECRET, body)}`)).json().changed, false);
  const back = JSON.stringify({ trackingCode: s.tracking_code, status: 'PICKED' });
  assert.equal((await hook(back, signWebhook(SECRET, back))).statusCode, 409);

  // giả lập: advance → DELIVERED, rồi không tiến thêm
  const adv = await app.inject({ method: 'POST', url: `/dev/shipments/${s.id}/advance` });
  assert.equal(adv.json().status, 'DELIVERED');
  assert.equal((await app.inject({ method: 'POST', url: `/dev/shipments/${s.id}/advance` })).json().status, 'DELIVERED');

  const types = (await pool.query(`SELECT payload->>'type' t FROM outbox WHERE key = $1 ORDER BY created_at, id`, [ev.data.id])).rows.map((r) => r.t);
  assert.deepEqual(types, ['shipment.created', 'shipment.picked', 'shipment.in_transit', 'shipment.delivered']);
  const tl = (await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${buyerTok}` } })).json().timeline;
  assert.deepEqual(tl.map((t: { status: string }) => t.status), ['CREATED', 'PICKED', 'IN_TRANSIT', 'DELIVERED']);
});

test('webhook nhảy cóc CREATED → DELIVERED vẫn phát đủ sự kiện trung gian', async () => {
  const ev = orderEvent('order.confirmed');
  const s = (await handleOrderEvent(deps, ev)) as { id: string; tracking_code: string };
  const body = JSON.stringify({ trackingCode: s.tracking_code, status: 'DELIVERED' });
  const r = await app.inject({ method: 'POST', url: '/webhooks/carrier', payload: body, headers: { 'content-type': 'application/json', 'x-carrier-signature': signWebhook(SECRET, body) } });
  assert.equal(r.statusCode, 200);
  const types = (await pool.query(`SELECT payload->>'type' t FROM outbox WHERE key = $1 ORDER BY created_at, id`, [ev.data.id])).rows.map((x) => x.t);
  assert.deepEqual(types, ['shipment.created', 'shipment.picked', 'shipment.in_transit', 'shipment.delivered']);
});

test('order.cancelled: huỷ khi chưa lấy hàng, không huỷ khi đã PICKED; seller chết → kho mặc định', async () => {
  sellerDown = true;
  const ev = orderEvent('order.confirmed');
  const s = (await handleOrderEvent(deps, ev)) as { id: string; from_province: string };
  sellerDown = false;
  assert.equal(s.from_province, 'Hồ Chí Minh');
  assert.equal(await handleOrderEvent(deps, orderEvent('order.cancelled', { id: ev.data.id, reason: 'BUYER_CANCELLED' })), 'cancelled');
  assert.equal((await pool.query('SELECT status FROM shipments WHERE id = $1', [s.id])).rows[0].status, 'CANCELLED');

  const ev2 = orderEvent('order.confirmed');
  const s2 = (await handleOrderEvent(deps, ev2)) as { id: string };
  const sellerTok = await jwks.sign(newId(), ['seller'], { shopId: SHOP });
  await app.inject({ method: 'POST', url: `/seller/shipments/${s2.id}/pick`, headers: { authorization: `Bearer ${sellerTok}` } });
  assert.equal(await handleOrderEvent(deps, orderEvent('order.cancelled', { id: ev2.data.id })), 'too_late');
  assert.equal((await pool.query('SELECT status FROM shipments WHERE id = $1', [s2.id])).rows[0].status, 'PICKED');

  // auto-advance: PICKED cũ hơn N giây → IN_TRANSIT
  await pool.query(`UPDATE shipments SET updated_at = now() - interval '1 hour' WHERE id = $1`, [s2.id]);
  assert.ok((await advanceDue(pool, 60)) >= 1);
  assert.equal((await pool.query('SELECT status FROM shipments WHERE id = $1', [s2.id])).rows[0].status, 'IN_TRANSIT');

  const list = await app.inject({ method: 'GET', url: '/seller/shipments?status=IN_TRANSIT', headers: { authorization: `Bearer ${sellerTok}` } });
  assert.ok(list.json().total >= 1);
});
