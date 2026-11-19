import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createEvent, createService, newId, withTx, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import type { OrderSnapshot } from '@shopnow/contracts';
import { handleOrderEvent } from '../src/consumers';
import { registerRoutes } from '../src/routes';
import { chargeStorage } from '../src/stock';

let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
let seller: string;
let clerk: string;
let manager: string;
const svc = createService('warehouse-test');
const app = svc.app;
const SHOP = newId();
const SKU_A = 'sku-ao-thun';
const SKU_B = 'sku-quan-jean';

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('warehouse_test', join(__dirname, '../migrations'));
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), countThreshold: 500_000, storageRate: 50 });
  await app.ready();
  seller = await jwks.sign(newId(), ['seller'], { shopId: SHOP });
  clerk = await jwks.sign('clerk', ['warehouse']);
  manager = await jwks.sign('manager', ['warehouse']);
});
after(async () => {
  await app.close();
  await pool.end();
  await jwks.close();
});

const call = (method: 'GET' | 'POST', url: string, tok: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${tok}` } });

async function inbound(lines: { skuId: string; qty: number; unitCost: number }[], recv: { skuId: string; received: number; damaged?: number; bin: string }[]) {
  const r = await call('POST', '/seller/receipts', seller, { warehouse: 'HCM1', lines });
  assert.equal(r.statusCode, 201, r.body);
  const rc = await call('POST', `/receipts/${r.json().id}/receive`, clerk, { lines: recv });
  assert.equal(rc.statusCode, 200, rc.body);
  return rc.json();
}

function order(items: { skuId: string; qty: number }[]): OrderSnapshot {
  return { id: newId(), checkoutId: newId(), buyerId: newId(), shopId: SHOP, status: 'CONFIRMED',
    items: items.map((i) => ({ skuId: i.skuId, productId: 'p', title: 't', variantLabel: '', unitPrice: 1, qty: i.qty, lineTotal: i.qty })),
    subtotal: 0, shippingFee: 0, discount: 0, total: 0, paymentMethod: 'COD',
    shippingAddress: { fullName: 'A', phone: '0', line1: '', ward: '', district: '', province: '' }, createdAt: new Date().toISOString() } as OrderSnapshot;
}

test('nhập kho theo ASN: ghi chênh lệch, hàng hỏng vào khu cách ly, SKU ngoài ASN bị chặn', async () => {
  const r1 = await inbound([{ skuId: SKU_A, qty: 10, unitCost: 80_000 }], [{ skuId: SKU_A, received: 10, bin: 'A-01-01' }]);
  assert.deepEqual(r1.discrepancies, []);
  const r2 = await inbound([{ skuId: SKU_A, qty: 10, unitCost: 90_000 }, { skuId: SKU_B, qty: 5, unitCost: 200_000 }],
    [{ skuId: SKU_A, received: 9, damaged: 1, bin: 'A-01-02' }, { skuId: SKU_B, received: 5, bin: 'A-01-02' }]);
  assert.deepEqual(r2.discrepancies, [{ skuId: SKU_A, expected: 10, received: 9, damaged: 1 }]);
  const stock = (await call('GET', '/seller/stock', seller)).json().items;
  const a = stock.find((s: { sku_id: string }) => s.sku_id === SKU_A);
  assert.deepEqual([a.on_hand, a.available, a.quarantined], [19, 18, 1]);
  const bad = await call('POST', '/seller/receipts', seller, { warehouse: 'HCM1', lines: [{ skuId: SKU_B, qty: 1, unitCost: 1 }] });
  const rec = await call('POST', `/receipts/${bad.json().id}/receive`, clerk, { lines: [{ skuId: 'sku-la', received: 1, bin: 'A-01-01' }] });
  assert.equal(rec.statusCode, 400);
  assert.equal((await call('GET', '/receipts', seller)).statusCode, 403);
});

test('xuất kho FIFO: lô nhập trước xuất trước, không lấy từ khu cách ly; giá vốn theo lô', async () => {
  const o = order([{ skuId: SKU_A, qty: 12 }]);
  await handleOrderEvent(pool, createEvent('order.confirmed', 'order', o.id, o), svc.log);
  await handleOrderEvent(pool, createEvent('order.confirmed', 'order', o.id, o), svc.log); // sự kiện lặp → một phiếu
  const picks = (await call('GET', '/picks', clerk)).json().items.filter((p: { order_id: string }) => p.order_id === o.id);
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0].lines.map((l: { bin: string; qty: number }) => [l.bin, l.qty]), [['A-01-01', 10], ['A-01-02', 2]]);
  const conf = await call('POST', `/picks/${picks[0].id}/confirm`, clerk);
  assert.equal(conf.json().cogs, 10 * 80_000 + 2 * 90_000);
  assert.equal((await call('POST', `/picks/${picks[0].id}/confirm`, clerk)).statusCode, 409);
  const a = (await call('GET', '/seller/stock', seller)).json().items.find((s: { sku_id: string }) => s.sku_id === SKU_A);
  assert.deepEqual([a.on_hand, a.available], [7, 6]);
});

test('thiếu hàng → phiếu SHORT không giữ chỗ; huỷ đơn nhả giữ chỗ', async () => {
  const big = order([{ skuId: SKU_B, qty: 99 }]);
  await handleOrderEvent(pool, createEvent('order.confirmed', 'order', big.id, big), svc.log);
  const short = (await call('GET', '/picks?status=SHORT', clerk)).json().items.find((p: { order_id: string }) => p.order_id === big.id);
  assert.match(short.short_reason, /thiếu 94/);
  const o = order([{ skuId: SKU_B, qty: 3 }]);
  await handleOrderEvent(pool, createEvent('order.confirmed', 'order', o.id, o), svc.log);
  let b = (await call('GET', '/seller/stock', seller)).json().items.find((s: { sku_id: string }) => s.sku_id === SKU_B);
  assert.equal(b.available, 2);
  await handleOrderEvent(pool, createEvent('order.cancelled', 'order', o.id, o), svc.log);
  b = (await call('GET', '/seller/stock', seller)).json().items.find((s: { sku_id: string }) => s.sku_id === SKU_B);
  assert.equal(b.available, 5);
});

test('kiểm kê mù + four-eyes: người đếm không thấy số hệ thống; chênh lệch lớn phải người khác duyệt', async () => {
  const st = await call('POST', '/counts', clerk, { warehouse: 'HCM1', binPrefix: 'A-01' });
  assert.equal(st.statusCode, 201);
  const sheet = (await call('GET', `/counts/${st.json().id}/sheet`, clerk)).json().items;
  assert.ok(sheet.length >= 2 && sheet.every((l: Record<string, unknown>) => !('system_qty' in l)));
  // đếm: lô áo còn 6 ở A-01-02 → đếm 5 (mất 1 cái 90k); quần 5 → đếm 1 (mất 4 × 200k = 800k > ngưỡng 500k)
  const lines = sheet.map((l: { lot_id: string; sku_id: string; bin: string }) => ({ lotId: l.lot_id, qty: l.sku_id === SKU_B ? 1 : l.bin === 'A-01-02' ? 5 : 0 }));
  const sub = await call('POST', `/counts/${st.json().id}/submit`, clerk, { lines });
  assert.equal(sub.statusCode, 200, sub.body);
  assert.equal(sub.json().needsApproval, true);
  assert.equal(sub.json().varianceValue, -(90_000 + 800_000));
  assert.equal((await call('POST', `/counts/${st.json().id}/approve`, clerk)).statusCode, 403);
  const ok = await call('POST', `/counts/${st.json().id}/approve`, manager);
  assert.equal(ok.statusCode, 200, ok.body);
  const card = (await call('GET', `/reports/stock-card/${SKU_B}`, clerk)).json().items;
  assert.deepEqual(card.map((m: { type: string; qty: number }) => [m.type, m.qty]), [['RECEIPT', 5], ['ADJUST_OUT', 4]]);
  await assert.rejects(pool.query('DELETE FROM stock_moves'), /bất biến/);
});

test('báo cáo nhập – xuất – tồn khớp thẻ kho; phí lưu kho tính một lần mỗi kỳ', async () => {
  const today = new Date();
  const from = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
  const r = (await call('GET', `/reports/stock-ledger?from=${from}&to=${to}&shopId=${SHOP}`, clerk)).json().items;
  const a = r.find((x: { sku_id: string }) => x.sku_id === SKU_A);
  assert.deepEqual([a.opening_qty, a.in_qty, a.out_qty, a.closing_qty], [0, 19, 13, 6]);
  assert.equal(a.in_value, 10 * 80_000 + 9 * 90_000);
  const period = today.toISOString().slice(0, 7);
  const fees = await withTx(pool, (c) => chargeStorage(c, period, 50));
  assert.equal(fees.length, 1);
  assert.ok(fees[0].amount > 0 && fees[0].shopId === SHOP);
  assert.deepEqual(await withTx(pool, (c) => chargeStorage(c, period, 50)), []);
});

test('đề xuất nhập hàng: SES + tồn an toàn 95% + ROP + ABC từ thẻ kho', async () => {
  const { abc, ses, std } = await import('../src/replenishment');
  assert.equal(ses([10, 10, 10], 0.3), 10);
  assert.ok(ses([0, 0, 0, 20, 20, 20], 0.3) > 10); // phản ứng với xu hướng tăng gần đây
  assert.equal(std([5, 5, 5]), 0);
  const cls = abc([{ key: 'a', value: 900 }, { key: 'b', value: 80 }, { key: 'c', value: 20 }]);
  assert.deepEqual([cls.get('a'), cls.get('b'), cls.get('c')], ['A', 'B', 'C']);

  const shop = newId();
  const mk = async (sku: string, qty: number, cost: number) => {
    const lot = newId();
    await pool.query("INSERT INTO lots (id, warehouse, bin, shop_id, sku_id, qty, unit_cost) VALUES ($1,'HCM1','A-01-01',$2,$3,$4,$5)", [lot, shop, sku, qty, cost]);
    return lot;
  };
  const hot = await mk('sku-ban-chay', 15, 100_000);
  const cold = await mk('sku-ban-cham', 500, 10_000);
  for (let d = 1; d <= 14; d++) {
    await pool.query(`INSERT INTO stock_moves (at, type, lot_id, warehouse, bin, shop_id, sku_id, qty, unit_cost, ref_type, ref_id, actor)
      VALUES (now() - make_interval(days => $1), 'ISSUE', $2, 'HCM1', 'A-01-01', $3, 'sku-ban-chay', $4, 100000, 'pick', 'seed', 'test')`, [d, hot, shop, 8 + (d % 3) * 2]);
    if (d % 7 === 0) await pool.query(`INSERT INTO stock_moves (at, type, lot_id, warehouse, bin, shop_id, sku_id, qty, unit_cost, ref_type, ref_id, actor)
      VALUES (now() - make_interval(days => $1), 'ISSUE', $2, 'HCM1', 'A-01-01', $3, 'sku-ban-cham', 1, 10000, 'pick', 'seed', 'test')`, [d, cold, shop]);
  }
  const r = (await call('GET', `/reports/replenishment?shopId=${shop}&leadTimeDays=7`, clerk)).json();
  const h = r.items.find((i: { skuId: string }) => i.skuId === 'sku-ban-chay');
  const c = r.items.find((i: { skuId: string }) => i.skuId === 'sku-ban-cham');
  assert.equal(h.abc, 'A');
  assert.equal(h.status, 'critical');
  assert.ok(h.forecastPerDay > 3 && h.safetyStock > 0 && h.reorderPoint > h.available && h.suggestQty > 0);
  assert.equal(c.status, 'ok');
  assert.equal(c.suggestQty, 0);
  assert.equal(r.items[0].skuId, 'sku-ban-chay'); // xếp mức khẩn trước
  assert.equal((await call('GET', '/reports/replenishment', seller)).statusCode, 403);
});
