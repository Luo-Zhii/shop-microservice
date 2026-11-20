import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createEvent, createService, newId, withTx, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import type { OrderSnapshot } from '@shopnow/contracts';
import { entryHash, GENESIS, normalizeLines, postEntry } from '../src/ledger';
import { handleEvent, splitCompletion, type Rates } from '../src/posting';
import { registerRoutes } from '../src/routes';

const R: Rates = { commissionRate: 0.05, vatRate: 0.1, invoiceSeries: '1C26TSN', tz: 'Asia/Ho_Chi_Minh' };
let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
let acct: string;
let seller: string;
const svc = createService('accounting-test');
const app = svc.app;
const SHOP = newId();

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('accounting_test', join(__dirname, '../migrations'));
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), tz: R.tz });
  await app.ready();
  acct = await jwks.sign(newId(), ['accountant']);
  seller = await jwks.sign(newId(), ['seller'], { shopId: SHOP });
});
after(async () => {
  await app.close();
  await pool.end();
  await jwks.close();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, tok = acct) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${tok}` } });

function order(o: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: newId(), checkoutId: newId(), buyerId: newId(), shopId: SHOP, status: 'COMPLETED',
    items: [{ skuId: newId(), productId: newId(), title: 'Áo', variantLabel: 'M', unitPrice: 500_000, qty: 2, lineTotal: 1_000_000 }],
    subtotal: 1_000_000, shippingFee: 30_000, discount: 0, total: 1_030_000, paymentMethod: 'VNPAY',
    shippingAddress: { fullName: 'A', phone: '0900000000', line1: '1 Lê Lợi', ward: 'Bến Nghé', district: '1', province: 'Hồ Chí Minh' },
    createdAt: new Date().toISOString(), ...o,
  } as OrderSnapshot;
}

test('chia tiền quyết toán: hoa hồng gồm VAT, seller nhận phần còn lại', () => {
  const s = splitCompletion({ total: 1_030_000, shippingFee: 30_000 }, R);
  assert.deepEqual(s, { shipping: 30_000, commission: 50_000, commissionNet: 45_455, vat: 4_545, seller: 950_000 });
  assert.equal(s.seller + s.commissionNet + s.vat + s.shipping, 1_030_000);
});

test('bút toán phải cân, không âm, không vừa Nợ vừa Có', () => {
  assert.throws(() => normalizeLines([{ account: '111', debit: 10 }, { account: '411', credit: 9 }]), /lệch/);
  assert.throws(() => normalizeLines([{ account: '111', debit: 10, credit: 10 }, { account: '411', credit: 0 }]), /vừa Nợ vừa Có/);
  assert.throws(() => normalizeLines([{ account: '111', debit: 10 }]), /ít nhất 2 dòng/);
});

test('luồng VNPAY: thu tiền → quyết toán → hoá đơn → chi trả seller; sổ cân và idempotent', async () => {
  const o = order();
  const paid = createEvent('payment.succeeded', 'payment', o.checkoutId, { paymentId: newId(), checkoutId: o.checkoutId, amount: o.total });
  assert.equal(await handleEvent(pool, paid, R, svc.log), true);
  assert.equal(await handleEvent(pool, paid, R, svc.log), false); // giao lại cùng sự kiện → bỏ qua
  const done = createEvent('order.completed', 'order', o.id, o);
  assert.equal(await handleEvent(pool, done, R, svc.log), true);
  // sự kiện khác id nhưng cùng đơn (replay từ nguồn) cũng không ghi trùng
  assert.equal(await handleEvent(pool, createEvent('order.completed', 'order', o.id, o), R, svc.log), false);
  // đơn COD chưa giao không phát sinh gì; order.created bị bỏ qua
  assert.equal(await handleEvent(pool, createEvent('order.created', 'order', o.id, o), R, svc.log), false);

  const tb = (await call('GET', '/admin/trial-balance')).json();
  assert.equal(tb.balanced, true);
  const by = Object.fromEntries(tb.rows.map((r: { account: string }) => [r.account, r]));
  assert.equal(by['1121'].closingDebit, 1_030_000);
  assert.equal(by['3388'].closingCredit + by['3388'].closingDebit, 0); // thu hộ đã quyết toán hết
  assert.equal(by['331'].closingCredit, 950_000);
  assert.equal(by['5113'].credit, 45_455);
  assert.equal(by['33311'].credit, 4_545);

  const inv = (await call('GET', `/admin/invoices?shopId=${SHOP}`)).json().items;
  assert.equal(inv.length, 1);
  assert.equal(inv[0].series, '1C26TSN');
  assert.equal(Number(inv[0].total), 50_000);

  const pay = await app.inject({ method: 'POST', url: '/internal/payouts/paid', headers: { 'x-internal-token': 'test-internal' },
    payload: { payoutId: 'PO-1', shopId: SHOP, amount: 900_000 } });
  assert.equal(pay.statusCode, 201);
  const again = await app.inject({ method: 'POST', url: '/internal/payouts/paid', headers: { 'x-internal-token': 'test-internal' },
    payload: { payoutId: 'PO-1', shopId: SHOP, amount: 900_000 } });
  assert.equal(again.statusCode, 200);
  const payables = (await call('GET', '/admin/payables')).json().items;
  assert.deepEqual(payables.find((p: { shopId: string }) => p.shopId === SHOP), { shopId: SHOP, accrued: 950_000, paid: 900_000, balance: 50_000 });

  const st = (await call('GET', '/seller/statement', undefined, seller)).json();
  assert.equal(st.balance, 50_000);
  assert.equal(st.items.length, 2);
  assert.equal(st.invoices.length, 1);
  assert.equal((await call('GET', '/admin/trial-balance', undefined, seller)).statusCode, 403);

  const pnl = (await call('GET', '/admin/pnl')).json();
  assert.equal(pnl.revenue, 45_455);
  assert.equal(pnl.vatOutput, 4_545);
});

test('phí lưu kho từ warehouse trừ công nợ seller, tách VAT', async () => {
  const ev = createEvent('warehouse.storage_fee_charged', 'warehouse', `${SHOP}:2026-11`, { shopId: SHOP, period: '2026-11', unitDays: 2200, amount: 110_000 });
  assert.equal(await handleEvent(pool, ev, R, svc.log), true);
  const e = (await call('GET', '/admin/journal?source=kafka&q=lưu kho')).json().items[0];
  assert.deepEqual(e.lines.map((l: { account: string; debit: number; credit: number }) => [l.account, l.debit, l.credit]),
    [['331', 110_000, 0], ['5113', 0, 100_000], ['33311', 0, 10_000]]);
});

test('tổng hợp GTGT: đầu ra − đầu vào được khấu trừ = phải nộp; khớp HĐĐT', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await call('POST', '/admin/journal', { date: today, voucherNo: 'HD-AWS-11', description: 'Hoá đơn dịch vụ cloud tháng',
    lines: [{ account: '6427', debit: 2_000_000 }, { account: '1331', debit: 200_000 }, { account: '1121', credit: 2_200_000 }] });
  assert.equal(r.statusCode, 201, r.body);
  const v = (await call('GET', '/admin/vat-summary')).json();
  assert.equal(v.outputVat, 4_545 + 10_000); // hoa hồng đơn VNPAY + phí lưu kho
  assert.equal(v.inputVat, 200_000);
  assert.equal(v.payable, 0);
  assert.equal(v.carryForward, 200_000 - 14_545);
  assert.equal(v.invoices.count, 1);
  assert.equal(v.invoiceGap, 10_000); // phí lưu kho chưa xuất HĐ theo đơn
});

test('tuổi nợ phải trả seller: cấn trừ FIFO, xếp nhóm theo ngày, đánh dấu quá hạn', async () => {
  const shop = newId();
  const accrue = (date: string, ref: string, amount: number) => withTx(pool, (c) => postEntry(c, { date, source: 'manual', sourceRef: ref,
    description: 'phải trả', createdBy: 't', lines: [{ account: '3388', debit: amount }, { account: '331', credit: amount, partyType: 'shop', partyId: shop }] }, date));
  await accrue('2026-10-01', `AG-1-${shop}`, 100);
  await accrue('2026-10-20', `AG-2-${shop}`, 200);
  await accrue('2026-11-15', `AG-3-${shop}`, 300);
  await withTx(pool, (c) => postEntry(c, { date: '2026-11-16', source: 'payout', sourceRef: `AG-P-${shop}`, description: 'chi', createdBy: 't',
    lines: [{ account: '331', debit: 150, partyType: 'shop', partyId: shop }, { account: '1121', credit: 150 }] }, '2026-11-16'));
  const r = (await call('GET', '/admin/payables/aging?asOf=2026-11-20')).json();
  const it = r.items.find((i: { shopId: string }) => i.shopId === shop);
  // 150 trả hết khoản 01/10 (100) và 50 của khoản 20/10 → còn 150 (31 ngày) + 300 (5 ngày)
  assert.deepEqual(it.buckets, { '0-7': 300, '8-15': 0, '16-30': 0, '>30': 150 });
  assert.equal(it.balance, 450);
  assert.equal(it.oldestDays, 31);
  assert.equal(it.overdue, 150);
});

test('COD: ĐVVC thu hộ khi giao; hoàn tiền một phần nhiều lần không bị khử trùng nhầm', async () => {
  const o = order({ paymentMethod: 'COD' });
  assert.equal(await handleEvent(pool, createEvent('order.delivered', 'order', o.id, o), R, svc.log), true);
  const r1 = createEvent('payment.refunded', 'payment', o.id, { checkoutId: o.checkoutId, orderId: o.id, amount: 10_000 });
  const r2 = createEvent('payment.refunded', 'payment', o.id, { checkoutId: o.checkoutId, orderId: o.id, amount: 20_000 });
  assert.equal(await handleEvent(pool, r1, R, svc.log), true);
  assert.equal(await handleEvent(pool, r2, R, svc.log), true);
  const led = (await call('GET', '/admin/ledger/1388')).json();
  assert.equal(led.items.at(-1).balance, 1_030_000);
});

test('sổ cái bất biến: DB chặn UPDATE/DELETE; sửa sai bằng bút toán đảo đúng một lần', async () => {
  const r = await call('POST', '/admin/journal', {
    date: new Date().toISOString().slice(0, 10), voucherNo: 'PC-0001', description: 'Chi phí văn phòng phẩm',
    lines: [{ account: '642', debit: 1_200_000 }, { account: '111', credit: 1_200_000 }],
  });
  assert.equal(r.statusCode, 201);
  const e = r.json();
  assert.equal((await call('POST', '/admin/journal', { date: e.entry_date, voucherNo: 'PC-0001', description: 'trùng', lines: [{ account: '642', debit: 1 }, { account: '111', credit: 1 }] })).statusCode, 409);
  await assert.rejects(pool.query('UPDATE journal_lines SET debit = 1 WHERE entry_id = $1', [e.id]), /bất biến/);
  await assert.rejects(pool.query('DELETE FROM journal_entries WHERE id = $1', [e.id]), /bất biến/);
  await assert.rejects(pool.query("UPDATE journal_entries SET description = 'sửa lén' WHERE id = $1", [e.id]), /bất biến/);
  // lệch Nợ/Có bị chặn ở cuối transaction kể cả khi ghi thẳng SQL
  await assert.rejects(withTx(pool, async (c) => {
    const last = await c.query('SELECT hash, seq FROM journal_entries ORDER BY seq DESC LIMIT 1');
    const id = newId();
    await c.query(`INSERT INTO journal_entries (id, seq, entry_no, entry_date, period, source, source_ref, description, created_by, total, prev_hash, hash)
      VALUES ($1, $2, 'X', current_date, to_char(current_date,'YYYY-MM'), 'manual', 'X', 'x', 'x', 5, $3, 'h-x')`, [id, Number(last.rows[0].seq) + 1, last.rows[0].hash]);
    await c.query("INSERT INTO journal_lines (entry_id, line_no, account, debit) VALUES ($1, 1, '111', 5)", [id]);
  }), /lệch/);

  const rev = await call('POST', `/admin/journal/${e.id}/reverse`, { reason: 'ghi nhầm tài khoản' });
  assert.equal(rev.statusCode, 201);
  assert.deepEqual(rev.json().lines.map((l: { account: string; debit: number; credit: number }) => [l.account, l.debit, l.credit]),
    [['642', 0, 1_200_000], ['111', 1_200_000, 0]]);
  assert.equal((await call('POST', `/admin/journal/${e.id}/reverse`, { reason: 'lần hai' })).statusCode, 409);
  const integ = (await call('GET', '/admin/integrity')).json();
  assert.equal(integ.ok, true);
});

test('chuỗi hash phát hiện sửa lén khi tắt trigger (mô phỏng DBA can thiệp)', async () => {
  const before = (await call('GET', '/admin/integrity')).json();
  assert.equal(before.ok, true);
  const c = await pool.connect();
  try {
    await c.query('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_immutable');
    await c.query("UPDATE journal_lines SET memo = memo, debit = debit + 1, credit = credit WHERE line_no = 1 AND debit > 0 AND entry_id = (SELECT id FROM journal_entries ORDER BY seq LIMIT 1)");
    await c.query('ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_immutable');
  } finally {
    c.release();
  }
  const after = (await call('GET', '/admin/integrity')).json();
  assert.equal(after.ok, false);
  assert.ok(after.problems.some((p: { problem: string }) => /hash không khớp/.test(p.problem)));
  assert.notEqual(entryHash(GENESIS, { entryNo: 'a', date: '2026-01-01', total: 1, description: 'x' }, []), GENESIS);
});

test('khoá sổ: kỳ trước phải khoá trước; kỳ đã khoá không nhận bút toán, chứng từ trễ dời sang kỳ hiện tại', async () => {
  const p2 = await freshTestDb('accounting_test_close', join(__dirname, '../migrations'));
  try {
    const today = new Date().toISOString().slice(0, 10);
    const old = '2026-09-15';
    const lines = [{ account: '111', debit: 100_000 }, { account: '411', credit: 100_000 }];
    await withTx(p2, (c) => postEntry(c, { date: '2026-08-10', source: 'manual', sourceRef: 'GV-0', description: 'Góp vốn', createdBy: 't', lines }, today));
    await withTx(p2, (c) => postEntry(c, { date: old, source: 'manual', sourceRef: 'GV-1', description: 'Góp vốn', createdBy: 't', lines }, today));
    const app2 = createService('accounting-test-2').app;
    registerRoutes(app2, { pool: p2, auth: createAuth(jwks.authOptions), tz: R.tz });
    await app2.ready();
    const close = (p: string) => app2.inject({ method: 'POST', url: `/admin/periods/${p}/close`, headers: { authorization: `Bearer ${acct}` } });
    assert.equal((await close('2026-09')).statusCode, 409); // 2026-08 chưa khoá
    assert.equal((await close('2026-08')).statusCode, 200);
    const ok = await close('2026-09');
    assert.equal(ok.statusCode, 200);
    assert.match(ok.json().closing_hash, /^[0-9a-f]{64}$/);
    assert.equal((await close('2026-09')).statusCode, 409);
    // chứng từ ngày cũ đến trễ → ghi vào kỳ hiện tại
    const { entry } = await withTx(p2, (c) => postEntry(c, { date: old, source: 'manual', sourceRef: 'GV-2', description: 'Góp vốn bổ sung', createdBy: 't', lines }, today));
    assert.equal(entry.period, today.slice(0, 7));
    assert.match(entry.description, /ghi sau khoá sổ kỳ 2026-09/);
    await assert.rejects(p2.query(`INSERT INTO journal_entries (id, seq, entry_no, entry_date, period, source, source_ref, description, created_by, total, prev_hash, hash)
      VALUES ($1, 999, 'Y', '2026-09-30', '2026-09', 'manual', 'Y', 'y', 'y', 1, 'p', 'h-y')`, [newId()]), /đã khoá sổ/);
    await app2.close();
  } finally {
    await p2.end();
  }
});

test('đối soát cổng thanh toán: khớp, lệch tiền, thiếu ở sổ, thiếu ở cổng', async () => {
  const period = new Date().toISOString().slice(0, 7);
  const a = order();
  const b = order();
  for (const o of [a, b]) {
    await handleEvent(pool, createEvent('payment.succeeded', 'payment', o.checkoutId, { paymentId: newId(), checkoutId: o.checkoutId, amount: 200_000 }), R, svc.log);
  }
  const r = await call('POST', '/admin/reconciliation', {
    provider: 'vnpay', period, rows: [{ ref: a.checkoutId, amount: 200_000 }, { ref: b.checkoutId, amount: 199_000 }, { ref: 'GHOST', amount: 5 }],
  });
  assert.equal(r.statusCode, 201);
  const s = r.json().summary;
  assert.equal(s.MATCHED, 1);
  assert.equal(s.AMOUNT_MISMATCH, 1);
  assert.equal(s.MISSING_IN_LEDGER, 1);
  assert.ok(s.MISSING_AT_GATEWAY >= 1); // checkout của test VNPAY phía trên không có trong sao kê
});
