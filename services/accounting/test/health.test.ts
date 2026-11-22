import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { registry, withTx, type Pool } from '@shopnow/platform';
import { freshTestDb } from '@shopnow/platform/testing';
import { refreshFinanceGauges } from '../src/health';
import { postEntry } from '../src/ledger';

let pool: Pool;
const TODAY = '2026-11-22';
const ago = (d: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - d * 86400_000).toISOString().slice(0, 10);

before(async () => {
  pool = await freshTestDb('accounting_health_test', join(__dirname, '../migrations'));
  const post = (ref: string, date: string, lines: Parameters<typeof postEntry>[1]['lines']) =>
    withTx(pool, (c) => postEntry(c, { date, source: 'manual', sourceRef: ref, description: ref, createdBy: 't', lines }, date));
  // checkout A: khách trả 500k cách đây 20 ngày, chưa quyết toán → treo
  await post('a', ago(20), [{ account: '1121', debit: 500_000 }, { account: '3388', credit: 500_000, partyType: 'checkout', partyId: 'ck-a' }]);
  // checkout B: trả 300k cách đây 2 ngày → chưa tới hạn treo
  await post('b', ago(2), [{ account: '1121', debit: 300_000 }, { account: '3388', credit: 300_000, partyType: 'checkout', partyId: 'ck-b' }]);
  // checkout C: trả 20 ngày trước nhưng đã quyết toán hết → số dư 0
  await post('c1', ago(20), [{ account: '1121', debit: 200_000 }, { account: '3388', credit: 200_000, partyType: 'checkout', partyId: 'ck-c' }]);
  await post('c2', ago(18), [{ account: '3388', debit: 200_000, partyType: 'checkout', partyId: 'ck-c' }, { account: '331', credit: 200_000, partyType: 'shop', partyId: 's' }]);
  // COD: ĐVVC giữ 150k từ 30 ngày trước, chưa đối soát
  await post('cod', ago(30), [{ account: '1388', debit: 150_000, partyType: 'carrier', partyId: 'ghn', orderId: 'o-1' }, { account: '3388', credit: 150_000, partyType: 'checkout', partyId: 'ck-cod' }]);
});
after(async () => { await pool.end(); });

test('KPI tài chính: tiền thu hộ treo > 15 ngày và COD chưa đối soát', async () => {
  const s = await refreshFinanceGauges(pool, TODAY);
  assert.deepEqual(s.escrow, { n: 2, amount: 650_000 });     // ck-a 500k + ck-cod 150k (ck-b mới, ck-c đã quyết toán)
  assert.deepEqual(s.cod, { n: 1, amount: 150_000 });
  const m = await registry.metrics();
  assert.match(m, /accounting_escrow_stale_checkouts(\{[^}]*\})? 2\n/);
  assert.match(m, /accounting_cod_open_vnd(\{[^}]*\})? 150000\n/);
});
