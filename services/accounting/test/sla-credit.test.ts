import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createService, withTx, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import { postEntry, trialBalance, verifyChain } from '../src/ledger';
import { registerRoutes } from '../src/routes';

let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const svc = createService('accounting-sla-test');
const H = { 'x-internal-token': 'test-internal' };
const D = '2026-10-15';

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('accounting_sla_test', join(__dirname, '../migrations'));
  registerRoutes(svc.app, { pool, auth: createAuth(jwks.authOptions), tz: 'Asia/Ho_Chi_Minh', vatRate: 0.1 });
  await svc.app.ready();
  // kỳ 2026-10: shop A hoa hồng chưa thuế 1.000.000 (+ phí lưu kho 50.000 không tính); shop B 400.000 rồi bị đảo 100.000
  const post = (ref: string, lines: Parameters<typeof postEntry>[1]['lines']) =>
    withTx(pool, (c) => postEntry(c, { date: D, source: 'manual', sourceRef: ref, description: ref, createdBy: 't', lines }, D));
  await post('a-don', [{ account: '3388', debit: 1_100_000 }, { account: '5113', credit: 1_000_000, partyType: 'shop', partyId: 'shop-a' }, { account: '33311', credit: 100_000 }]);
  await post('a-kho', [{ account: '331', debit: 55_000, partyType: 'shop', partyId: 'shop-a' }, { account: '5113', credit: 50_000, partyType: 'shop', partyId: 'shop-a', memo: 'storage:2026-10' }, { account: '33311', credit: 5_000 }]);
  await post('b-don', [{ account: '3388', debit: 440_000 }, { account: '5113', credit: 400_000, partyType: 'shop', partyId: 'shop-b' }, { account: '33311', credit: 40_000 }]);
  await post('b-dao', [{ account: '5113', debit: 100_000, partyType: 'shop', partyId: 'shop-b' }, { account: '33311', debit: 10_000 }, { account: '3388', credit: 110_000 }]);
});
after(async () => {
  await svc.app.close();
  await pool.end();
  await jwks.close();
});

const call = (body: object, headers: Record<string, string> = H) =>
  svc.app.inject({ method: 'POST', url: '/internal/sla-credits', payload: body, headers });
const BODY = { period: '2026-10', component: 'checkout', pct: 0.1, uptime: 0.9912, target: 0.995, actor: 'aiops:sre@shopnow.local' };

test('hoàn phí SLA: 10% hoa hồng chưa thuế (bỏ phí lưu kho, trừ bút toán đảo) + giảm VAT, khử trùng theo kỳ', async () => {
  assert.equal((await call(BODY, {})).statusCode, 403);
  assert.equal((await call({ ...BODY, uptime: 0.996 })).statusCode, 400);           // đạt cam kết → không hoàn
  const r = await call(BODY);
  assert.equal(r.statusCode, 201, r.body);
  const b = r.json();
  assert.deepEqual(b.shops.map((s: { shopId: string; creditNet: number; vat: number; total: number }) => [s.shopId, s.creditNet, s.vat, s.total]),
    [['shop-a', 100_000, 10_000, 110_000], ['shop-b', 30_000, 3_000, 33_000]]);
  assert.equal(b.total, 143_000);
  const again = await call(BODY);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().entryNo, b.entryNo, 'gọi lại không ghi đôi');

  // P&L tự trừ: doanh thu 5113 − 5213; VAT đầu ra giảm; sổ vẫn cân và chuỗi hash nguyên vẹn
  const per = (await pool.query("SELECT period FROM journal_entries WHERE entry_no = $1", [b.entryNo])).rows[0].period;
  const tb = await trialBalance(pool, per);
  const row = (a: string) => tb.rows.find((x) => x.account === a)!;
  assert.equal(row('5213').debit, 130_000);
  assert.ok(tb.balanced);
  const payable = await pool.query("SELECT SUM(credit) - SUM(debit) AS b FROM journal_lines WHERE account = '331' AND party_id = 'shop-a' AND memo = 'sla:2026-10:checkout'");
  assert.equal(Number(payable.rows[0].b), 110_000);
  assert.equal((await verifyChain(pool)).ok, true);
});

test('kỳ không có hoa hồng → không ghi gì', async () => {
  const r = await call({ ...BODY, period: '2026-09' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { created: false, entryNo: null, total: 0, shops: [] });
});
