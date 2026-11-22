import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { newId, registry, type Pool } from '@shopnow/platform';
import { freshTestDb } from '@shopnow/platform/testing';
import { pickDue, refreshPickSla, slaOf } from '../src/sla';

// giờ VN = UTC+7
const vn = (s: string) => new Date(`${s}+07:00`);

test('hạn xuất theo giờ cắt 14h (giờ VN), kể cả nửa đêm VN = chiều hôm trước theo UTC', () => {
  assert.equal(pickDue(vn('2026-11-22T10:00:00')).toISOString(), vn('2026-11-22T23:59:59').toISOString());
  assert.equal(pickDue(vn('2026-11-22T13:59:59')).toISOString(), vn('2026-11-22T23:59:59').toISOString());
  assert.equal(pickDue(vn('2026-11-22T14:00:00')).toISOString(), vn('2026-11-23T12:00:00').toISOString());
  assert.equal(pickDue(vn('2026-11-30T20:00:00')).toISOString(), vn('2026-12-01T12:00:00').toISOString());   // qua tháng
  assert.equal(pickDue(vn('2026-11-23T00:30:00')).toISOString(), vn('2026-11-23T23:59:59').toISOString());   // 17:30Z ngày 22
  assert.equal(pickDue(vn('2026-11-22T10:00:00'), 9).toISOString(), vn('2026-11-23T12:00:00').toISOString()); // giờ cắt 9h
});

test('trạng thái SLA: còn hạn / sắp hạn (≤ 2h) / quá hạn', () => {
  const created = vn('2026-11-22T10:00:00');
  assert.equal(slaOf(created, vn('2026-11-22T12:00:00')).state, 'ok');
  const soon = slaOf(created, vn('2026-11-22T22:30:00'));
  assert.deepEqual([soon.state, soon.minutesLeft], ['due_soon', 90]);
  const late = slaOf(created, vn('2026-11-23T01:00:00'));
  assert.equal(late.state, 'overdue');
  assert.ok(late.minutesLeft < 0);
});

let pool: Pool;
before(async () => { pool = await freshTestDb('warehouse_sla_test', join(__dirname, '../migrations')); });
after(async () => { await pool.end(); });

test('gauge phiếu quá hạn / sắp hạn chỉ tính phiếu OPEN/SHORT', async () => {
  const ins = (status: string, created: Date) => pool.query(
    "INSERT INTO picks (id, order_id, shop_id, warehouse, status, created_at) VALUES ($1,$2,'shop','HCM1',$3,$4)",
    [newId(), newId(), status, created]);
  await ins('OPEN', vn('2026-11-21T09:00:00'));    // hạn 21/11 23:59 → quá hạn
  await ins('SHORT', vn('2026-11-21T16:00:00'));   // hạn 22/11 12:00 → quá hạn
  await ins('OPEN', vn('2026-11-22T11:00:00'));    // hạn 22/11 23:59 → còn 1h → sắp hạn
  await ins('OPEN', vn('2026-11-22T20:00:00'));    // hạn 23/11 12:00 → ok
  await ins('PICKED', vn('2026-11-20T09:00:00'));  // đã xuất → không tính
  const r = await refreshPickSla(pool, vn('2026-11-22T23:00:00'));
  assert.deepEqual([r.open, r.overdue, r.dueSoon], [4, 2, 1]);
  assert.equal(r.oldestOverdueSeconds, 23 * 3600);                // từ 21/11 23:59:59 tới 22/11 23:00 ≈ 23h (làm tròn phút)
  const m = await registry.metrics();
  assert.match(m, /warehouse_picks_overdue(\{[^}]*\})? 2\n/);
  assert.match(m, /warehouse_picks_due_soon(\{[^}]*\})? 1\n/);
});
