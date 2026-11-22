import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createService, newId, registry, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import { compare, createReconciler, type InvStock } from '../src/reconcile';
import { registerRoutes } from '../src/routes';

const SHOP = newId();
let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const svc = createService('warehouse-recon-test');
const inventory = new Map<string, InvStock>();
let calls: string[][] = [];

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('warehouse_recon_test', join(__dirname, '../migrations'));
  // kho: A có 10 (2 đang giữ cho phiếu lấy) → available 8; B có 5 nhưng 1 trong khu cách ly QRT → available 4; C 3; D 6
  const lot = (sku: string, bin: string, qty: number, reserved = 0) =>
    pool.query('INSERT INTO lots (id, warehouse, bin, shop_id, sku_id, qty, reserved, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [newId(), 'HCM1', bin, SHOP, sku, qty, reserved, 1000]);
  await lot('sku-a', 'A-01-01', 10, 2);
  await lot('sku-b', 'A-01-01', 4);
  await lot('sku-b', 'QRT', 1);
  await lot('sku-c', 'A-01-01', 3);
  await lot('sku-d', 'A-01-01', 6);
});
after(async () => {
  await svc.app.close();
  await pool.end();
  await jwks.close();
});

test('compare: bất biến onHand = max(available kho, reserved inventory)', () => {
  const wh = [{ shopId: 's', skuId: 'a', available: 8 }, { shopId: 's', skuId: 'b', available: 2 }, { shopId: 's', skuId: 'c', available: 3 }, { shopId: 's', skuId: 'z', available: 0 }];
  const inv = new Map<string, InvStock>([
    ['a', { skuId: 'a', onHand: 8, reserved: 1, available: 7 }],          // khớp
    ['b', { skuId: 'b', onHand: 5, reserved: 5, available: 0 }],          // kiểm kê hụt: kẹp ở reserved → khớp
    ['c', { skuId: 'c', onHand: 9, reserved: 0, available: 9 }],          // dư 6 → bán vượt tồn
  ]);
  assert.deepEqual(compare(wh, inv).map((d) => [d.skuId, d.kind, d.delta]), [['c', 'over', 6]]);   // z: available 0 không tính thiếu
});

test('chỉ báo lệch bền vững (2 lần liên tiếp), metric, API + đồng bộ lại qua outbox', async () => {
  inventory.set('sku-a', { skuId: 'sku-a', onHand: 8, reserved: 0, available: 8 });
  inventory.set('sku-b', { skuId: 'sku-b', onHand: 4, reserved: 0, available: 4 });
  inventory.set('sku-c', { skuId: 'sku-c', onHand: 13, reserved: 0, available: 13 });   // over +10 (mất event xuất kho)
  // sku-d: inventory không có → missing
  const rec = createReconciler({ pool, batch: 2, fetchStock: async (ids) => { calls.push(ids); return ids.map((i) => inventory.get(i)).filter(Boolean) as InvStock[]; } });
  const r1 = await rec.runOnce();
  assert.equal(r1.skus, 4);
  assert.deepEqual(calls.map((c) => c.length), [2, 2]);                           // chia lô ≤ batch
  assert.equal(r1.persistent, 0, 'lần đầu: có thể chỉ là event đang trên đường');
  assert.deepEqual(r1.drifts.map((d) => [d.skuId, d.kind]).sort(), [['sku-c', 'over'], ['sku-d', 'missing']]);
  const r2 = await rec.runOnce();
  assert.equal(r2.persistent, 2);
  assert.equal(r2.units, 16);
  const m = await registry.metrics();
  assert.match(m, /warehouse_stock_drift_skus\{kind="over"[^}]*\} 1\n/);
  assert.match(m, /warehouse_stock_drift_units\{[^}]*\} 16\n/);
  // inventory tự hết lệch ở sku-c (event đến muộn) → lần sau không còn bền vững
  inventory.set('sku-c', { skuId: 'sku-c', onHand: 3, reserved: 0, available: 3 });
  const r3 = await rec.runOnce();
  assert.deepEqual(r3.drifts.filter((d) => d.persistent).map((d) => d.skuId), ['sku-d']);

  // API: nhân viên kho xem, chỉ admin đồng bộ lại; đồng bộ = phát lại warehouse.stock_changed qua outbox
  registerRoutes(svc.app, { pool, auth: createAuth(jwks.authOptions), countThreshold: 1, storageRate: 1, reconciler: rec });
  await svc.app.ready();
  const clerk = await jwks.sign('clerk', ['warehouse']);
  const admin = await jwks.sign('boss', ['admin'], { email: 'boss@shopnow.local' });
  const view = await svc.app.inject({ method: 'GET', url: '/reports/stock-drift', headers: { authorization: `Bearer ${clerk}` } });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().persistent, 1);
  assert.equal((await svc.app.inject({ method: 'POST', url: '/reports/stock-drift/resync', headers: { authorization: `Bearer ${clerk}` } })).statusCode, 403);
  await pool.query('DELETE FROM outbox');
  const rs = await svc.app.inject({ method: 'POST', url: '/reports/stock-drift/resync', headers: { authorization: `Bearer ${admin}` } });
  assert.deepEqual(rs.json(), { resent: 1 });
  const ob = await pool.query("SELECT payload FROM outbox WHERE payload->>'type' = 'warehouse.stock_changed'");
  assert.equal(ob.rows.length, 1);
  assert.equal(ob.rows[0].payload.data.skuId, 'sku-d');
  assert.equal(ob.rows[0].payload.data.available, 6);
  assert.match(ob.rows[0].payload.data.reason, /^reconcile:/);
});

test('inventory không trả lời → lần chạy lỗi được ghi nhận, không văng', async () => {
  const rec = createReconciler({ pool, fetchStock: async () => { throw new Error('inventory /stock HTTP 503'); } });
  const r = await rec.runOnce();
  assert.equal(r.ok, false);
  assert.match(r.error!, /503/);
  assert.match(await registry.metrics(), /warehouse_reconcile_runs_total\{result="error"[^}]*\} 1\n/);
});
