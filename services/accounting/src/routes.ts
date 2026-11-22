import {
  badRequest,
  conflict,
  newId,
  notFound,
  parsePage,
  requireUser,
  withTx,
  z,
  type Auth,
  type FastifyInstance,
  type Pool,
} from '@shopnow/platform';
import { localDate, periodOf, postEntry, reverseEntry, trialBalance, verifyChain, withLines, type EntryRow } from './ledger';
import { staleBalances } from './health';
import { postSlaCredit } from './posting';

export interface RouteDeps {
  pool: Pool;
  auth: Auth;
  tz: string;
  /** thuế suất GTGT dịch vụ hoa hồng (mặc định 10%) — dùng khi hoàn phí SLA */
  vatRate?: number;
}

const period = z.string().regex(/^\d{4}-\d{2}$/, 'kỳ dạng YYYY-MM');
const party = z.enum(['shop', 'buyer', 'carrier', 'checkout', 'gateway']);
const lineIn = z.object({
  account: z.string().min(3).max(10),
  debit: z.number().int().min(0).max(1e13).optional(),
  credit: z.number().int().min(0).max(1e13).optional(),
  partyType: party.optional(),
  partyId: z.string().max(64).optional(),
  orderId: z.string().max(64).optional(),
  memo: z.string().max(300).optional(),
});
const manualIn = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  voucherNo: z.string().min(1).max(40), // số chứng từ gốc — khử trùng
  description: z.string().min(3).max(500),
  lines: z.array(lineIn).min(2).max(50),
});
const payoutIn = z.object({ payoutId: z.string().min(1).max(64), shopId: z.string().min(1).max(64), amount: z.number().int().positive() });
const reconIn = z.object({
  provider: z.string().min(1).max(30),
  period,
  rows: z.array(z.object({ ref: z.string().min(1).max(64), amount: z.number().int() })).max(50_000),
});

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { pool, auth } = deps;
  const acct = { preHandler: auth.requireRole('admin', 'accountant') };
  const today = () => localDate(new Date(), deps.tz);
  const actor = (req: Parameters<typeof requireUser>[0]) => requireUser(req).email || requireUser(req).id;

  app.get('/admin/accounts', acct, async () => {
    const { rows } = await pool.query('SELECT code, name, type, normal, parent FROM accounts ORDER BY code');
    return { items: rows };
  });

  // ---- sổ nhật ký chung ----
  app.get('/admin/journal', acct, async (req) => {
    const q = req.query as { period?: string; account?: string; source?: string; q?: string; page?: string; pageSize?: string };
    const { limit, offset, page, pageSize } = parsePage(q);
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.period) where.push(`e.period = $${args.push(period.parse(q.period))}`);
    if (q.source) where.push(`e.source = $${args.push(q.source)}`);
    if (q.account) where.push(`EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id AND l.account LIKE $${args.push(`${q.account}%`)})`);
    if (q.q) where.push(`(e.description ILIKE $${args.push(`%${q.q}%`)} OR e.entry_no ILIKE $${args.length})`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries e ${w}`, args);
    const { rows } = await pool.query<EntryRow>(
      `SELECT * FROM journal_entries e ${w} ORDER BY seq DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`, args);
    return { items: await withLines(pool, rows), total: total.rows[0].n, page, pageSize };
  });

  app.get<{ Params: { id: string } }>('/admin/journal/:id', acct, async (req) => {
    const { rows } = await pool.query<EntryRow>('SELECT * FROM journal_entries WHERE id = $1 OR entry_no = $1', [req.params.id]);
    if (!rows[0]) throw notFound('không có bút toán');
    return (await withLines(pool, rows))[0];
  });

  app.post('/admin/journal', acct, async (req, reply) => {
    const b = manualIn.parse(req.body);
    const { entry, created } = await withTx(pool, (c) => postEntry(c, {
      date: b.date, source: 'manual', sourceRef: b.voucherNo, description: b.description, createdBy: actor(req), lines: b.lines,
    }, today()));
    if (!created) throw conflict(`chứng từ ${b.voucherNo} đã ghi sổ (${entry.entry_no})`);
    reply.code(201);
    return (await withLines(pool, [entry]))[0];
  });

  app.post<{ Params: { id: string } }>('/admin/journal/:id/reverse', acct, async (req, reply) => {
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    const entry = await withTx(pool, (c) => reverseEntry(c, req.params.id, reason, actor(req), today()));
    if (!entry) throw notFound('không có bút toán');
    reply.code(201);
    return (await withLines(pool, [entry]))[0];
  });

  // ---- báo cáo ----
  app.get('/admin/trial-balance', acct, async (req) => {
    const p = period.parse((req.query as { period?: string }).period ?? periodOf(today()));
    return trialBalance(pool, p);
  });

  /** Sổ cái chi tiết một tài khoản (gồm tài khoản con), có số dư luỹ kế. */
  app.get<{ Params: { account: string } }>('/admin/ledger/:account', acct, async (req) => {
    const p = period.parse((req.query as { period?: string }).period ?? periodOf(today()));
    const acc = await pool.query<{ normal: string; name: string }>('SELECT normal, name FROM accounts WHERE code = $1', [req.params.account]);
    if (!acc.rows[0]) throw notFound('không có tài khoản');
    const sign = acc.rows[0].normal === 'DEBIT' ? 1 : -1;
    const like = `${req.params.account}%`;
    const open = await pool.query<{ b: number }>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0)::bigint AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account LIKE $1 AND e.period < $2`, [like, p]);
    const { rows } = await pool.query(
      `SELECT e.entry_no, e.entry_date, e.description, l.account, l.debit, l.credit, l.party_type, l.party_id, l.order_id
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account LIKE $1 AND e.period = $2 ORDER BY e.seq, l.line_no`, [like, p]);
    let bal = Number(open.rows[0].b) * sign;
    const items = rows.map((r) => ({ ...r, balance: (bal += (Number(r.debit) - Number(r.credit)) * sign) }));
    return { account: req.params.account, name: acc.rows[0].name, period: p, opening: Number(open.rows[0].b) * sign, items, closing: bal };
  });

  /** Công nợ phải trả seller (TK 331 theo đối tượng). */
  app.get('/admin/payables', acct, async () => {
    const { rows } = await pool.query<{ shop_id: string; credit: number; debit: number }>(
      `SELECT party_id AS shop_id, SUM(credit)::bigint AS credit, SUM(debit)::bigint AS debit
         FROM journal_lines WHERE account = '331' AND party_type = 'shop' GROUP BY party_id ORDER BY SUM(credit - debit) DESC`);
    return { items: rows.map((r) => ({ shopId: r.shop_id, accrued: Number(r.credit), paid: Number(r.debit), balance: Number(r.credit) - Number(r.debit) })) };
  });

  /**
   * Tuổi nợ phải trả seller (TK 331) tại ngày asOf: khoản đã chi / bị trừ (Nợ) cấn trừ FIFO vào khoản phải trả cũ nhất (Có),
   * phần còn lại xếp nhóm 0–7 / 8–15 / 16–30 / >30 ngày. Nợ quá hạn đối soát (mặc định > 15 ngày) bị đánh dấu.
   */
  app.get('/admin/payables/aging', acct, async (req) => {
    const q = z.object({ asOf: z.string().date().optional(), overdueDays: z.coerce.number().int().min(1).max(365).default(15) }).parse(req.query);
    const asOf = q.asOf ?? today();
    const { rows } = await pool.query<{ shop_id: string; entry_date: string; debit: number; credit: number }>(
      `SELECT l.party_id AS shop_id, e.entry_date, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account = '331' AND l.party_type = 'shop' AND e.entry_date <= $1 ORDER BY l.party_id, e.entry_date, e.seq`, [asOf]);
    const BUCKETS = ['0-7', '8-15', '16-30', '>30'] as const;
    const byShop = new Map<string, { open: { date: string; amount: number }[]; paid: number }>();
    for (const r of rows) {
      const s = byShop.get(r.shop_id) ?? { open: [], paid: 0 };
      if (Number(r.credit)) s.open.push({ date: String(r.entry_date), amount: Number(r.credit) });
      s.paid += Number(r.debit);
      byShop.set(r.shop_id, s);
    }
    const day = 86_400_000;
    const items = [...byShop.entries()].map(([shopId, s]) => {
      let paid = s.paid;
      const buckets: Record<(typeof BUCKETS)[number], number> = { '0-7': 0, '8-15': 0, '16-30': 0, '>30': 0 };
      let oldest: number | null = null;
      let overdue = 0;
      for (const o of s.open) {
        const used = Math.min(paid, o.amount);
        paid -= used;
        const left = o.amount - used;
        if (left <= 0) continue;
        const age = Math.floor((Date.parse(asOf) - Date.parse(o.date)) / day);
        oldest = oldest == null ? age : Math.max(oldest, age);
        if (age > q.overdueDays) overdue += left;
        buckets[age <= 7 ? '0-7' : age <= 15 ? '8-15' : age <= 30 ? '16-30' : '>30'] += left;
      }
      const balance = Object.values(buckets).reduce((a, b) => a + b, 0);
      return { shopId, balance, buckets, oldestDays: oldest, overdue, prepaid: paid };
    }).filter((i) => i.balance > 0 || i.prepaid > 0).sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);
    const totals = Object.fromEntries(BUCKETS.map((b) => [b, items.reduce((s, i) => s + i.buckets[b], 0)]));
    return { asOf, overdueDays: q.overdueDays, totals, items };
  });

  /** Kết quả kinh doanh rút gọn: doanh thu (5xx) − chi phí (6xx, 8xx). */
  app.get('/admin/pnl', acct, async (req) => {
    const p = period.parse((req.query as { period?: string }).period ?? periodOf(today()));
    const tb = await trialBalance(pool, p);
    const revenue = tb.rows.filter((r) => r.type === 'REVENUE' && r.account.length === 3);
    const expense = tb.rows.filter((r) => r.type === 'EXPENSE' && r.account.length === 3);
    const rev = tb.rows.filter((r) => r.type === 'REVENUE').reduce((s, r) => s + r.credit - r.debit, 0);
    const exp = tb.rows.filter((r) => r.type === 'EXPENSE').reduce((s, r) => s + r.debit - r.credit, 0);
    return { period: p, revenue: rev, expense: exp, profit: rev - exp, detail: [...revenue, ...expense].map((r) => r.account),
      vatOutput: tb.rows.filter((r) => r.account === '33311').reduce((s, r) => s + r.credit - r.debit, 0) };
  });

  /**
   * Tổng hợp thuế GTGT theo kỳ (phương pháp khấu trừ): đầu ra = PS Có − PS Nợ TK 33311, đầu vào = PS Nợ − PS Có TK 1331,
   * doanh thu chịu thuế = PS Có TK 511x. Số liệu để kế toán lập tờ khai — không thay thế phần mềm kê khai của cơ quan thuế.
   */
  app.get('/admin/vat-summary', acct, async (req) => {
    const p = period.parse((req.query as { period?: string }).period ?? periodOf(today()));
    const { rows } = await pool.query<{ account: string; d: number; c: number }>(
      `SELECT CASE WHEN l.account LIKE '511%' THEN '511' ELSE l.account END AS account,
              SUM(l.debit)::bigint AS d, SUM(l.credit)::bigint AS c
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.period = $1 AND (l.account IN ('33311','1331') OR l.account LIKE '511%') GROUP BY 1`, [p]);
    const by = Object.fromEntries(rows.map((r) => [r.account, { d: Number(r.d), c: Number(r.c) }]));
    const outVat = (by['33311']?.c ?? 0) - (by['33311']?.d ?? 0);
    const inVat = (by['1331']?.d ?? 0) - (by['1331']?.c ?? 0);
    const sales = (by['511']?.c ?? 0) - (by['511']?.d ?? 0);
    const inv = await pool.query<{ n: number; total: number }>(
      "SELECT count(*)::int AS n, COALESCE(SUM(vat_amount),0)::bigint AS total FROM vat_invoices WHERE status = 'ISSUED' AND to_char(issue_date, 'YYYY-MM') = $1", [p]);
    const diff = outVat - inVat;
    return {
      period: p, taxableSales: sales, outputVat: outVat, inputVat: inVat,
      payable: Math.max(0, diff), carryForward: Math.max(0, -diff),
      invoices: { count: inv.rows[0].n, vat: Number(inv.rows[0].total) },
      // HĐĐT đã phát hành phải khớp thuế đầu ra từ hoa hồng; lệch = phí lưu kho (không xuất HĐ theo đơn) hoặc sai sót
      invoiceGap: outVat - Number(inv.rows[0].total),
    };
  });

  app.get('/admin/invoices', acct, async (req) => {
    const q = req.query as { shopId?: string; page?: string; pageSize?: string };
    const { limit, offset } = parsePage(q);
    const { rows } = await pool.query(
      `SELECT * FROM vat_invoices WHERE ($1::text IS NULL OR shop_id = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [q.shopId ?? null, limit, offset]);
    return { items: rows };
  });

  // ---- khoá sổ ----
  app.get('/admin/periods', acct, async () => {
    const { rows } = await pool.query('SELECT * FROM periods ORDER BY period DESC');
    return { items: rows };
  });

  /**
   * Checklist sẵn sàng khoá sổ: điều kiện CHẶN (giống hệt điều kiện của /close) + CẢNH BÁO nghiệp vụ nên xử lý trước khi
   * chốt (đối soát còn ngoại lệ, tiền thu hộ treo lâu, COD ĐVVC chưa trả, thuế đầu ra lệch HĐĐT).
   */
  app.get<{ Params: { period: string } }>('/admin/periods/:period/readiness', acct, async (req) => {
    const p = period.parse(req.params.period);
    const staleDays = 15;
    const [y, m] = p.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // ngày cuối kỳ
    const checks: { key: string; label: string; ok: boolean; blocking: boolean; detail?: string }[] = [];
    const add = (key: string, label: string, ok: boolean, blocking: boolean, detail?: string) => checks.push({ key, label, ok, blocking, detail });

    add('period_ended', 'Kỳ đã kết thúc', p < periodOf(today()), true, p < periodOf(today()) ? undefined : 'chỉ khoá kỳ đã qua');
    const st = await pool.query<{ status: string }>('SELECT status FROM periods WHERE period = $1', [p]);
    add('not_closed', 'Kỳ chưa khoá', st.rows[0]?.status !== 'CLOSED', true, st.rows[0]?.status === 'CLOSED' ? 'đã khoá' : undefined);
    const earlier = await pool.query<{ period: string }>("SELECT period FROM periods WHERE period < $1 AND status = 'OPEN' ORDER BY period LIMIT 1", [p]);
    add('previous_closed', 'Các kỳ trước đã khoá', !earlier.rowCount, true, earlier.rowCount ? `còn mở: ${earlier.rows[0].period}` : undefined);
    const tb = await trialBalance(pool, p);
    add('trial_balance', 'Bảng cân đối số phát sinh cân', tb.balanced, true,
      tb.balanced ? undefined : `PS Nợ ${tb.totals.debit} ≠ PS Có ${tb.totals.credit}`);
    const last = await pool.query<{ seq: number }>('SELECT max(seq) AS seq FROM journal_entries WHERE period <= $1', [p]);
    const chain = await verifyChain(pool, last.rows[0].seq ?? 0);
    add('ledger_integrity', 'Chuỗi hash sổ cái nguyên vẹn', chain.ok, true, chain.ok ? undefined : `${chain.problems.length} bút toán có vấn đề`);

    const recon = await pool.query<{ id: string; provider: string; n: number }>(
      `SELECT r.id, r.provider, (SELECT count(*)::int FROM recon_items i WHERE i.run_id = r.id AND i.status <> 'MATCHED') AS n
         FROM recon_runs r WHERE r.period = $1 ORDER BY r.created_at DESC`, [p]);
    const latest = new Map<string, number>();
    for (const r of recon.rows) if (!latest.has(r.provider)) latest.set(r.provider, Number(r.n));
    const reconExc = [...latest.values()].reduce((a, b) => a + b, 0);
    add('gateway_recon', 'Đã đối soát cổng thanh toán, không còn ngoại lệ', latest.size > 0 && reconExc === 0, false,
      latest.size === 0 ? 'chưa đối soát kỳ này' : reconExc ? `${reconExc} dòng ngoại lệ ở lần đối soát gần nhất` : undefined);
    const { escrow, cod } = await staleBalances(pool, end, staleDays);
    add('escrow_stale', `Không có tiền thu hộ (3388) treo quá ${staleDays} ngày`, escrow.n === 0, false,
      escrow.n ? `${escrow.n} checkout, ${escrow.amount} đ — đơn chưa hoàn tất/hoàn tiền` : undefined);
    add('cod_open', `ĐVVC đã trả COD giao quá ${staleDays} ngày`, cod.n === 0, false,
      cod.n ? `${cod.n} đơn, ${cod.amount} đ chưa đối soát COD` : undefined);
    const vat = await pool.query<{ out_vat: number; inv_vat: number }>(
      `SELECT (SELECT COALESCE(SUM(l.credit - l.debit),0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                WHERE l.account = '33311' AND e.period = $1)::bigint AS out_vat,
              (SELECT COALESCE(SUM(vat_amount),0) FROM vat_invoices WHERE status = 'ISSUED' AND to_char(issue_date, 'YYYY-MM') = $1)::bigint AS inv_vat`, [p]);
    const gap = Number(vat.rows[0].out_vat) - Number(vat.rows[0].inv_vat);
    add('vat_invoices', 'Thuế GTGT đầu ra khớp hoá đơn điện tử', gap === 0, false, gap ? `lệch ${gap} đ (vd phí lưu kho chưa xuất HĐ)` : undefined);

    return { period: p, ready: checks.every((c) => c.ok || !c.blocking), warnings: checks.filter((c) => !c.ok && !c.blocking).length, checks };
  });

  /** Khoá sổ kỳ: bảng cân đối phải cân + chuỗi hash nguyên vẹn; kỳ trước phải khoá trước. */
  app.post<{ Params: { period: string } }>('/admin/periods/:period/close', acct, async (req) => {
    const p = period.parse(req.params.period);
    if (p >= periodOf(today())) throw conflict('chỉ khoá sổ kỳ đã kết thúc');
    const earlier = await pool.query("SELECT period FROM periods WHERE period < $1 AND status = 'OPEN' ORDER BY period LIMIT 1", [p]);
    if (earlier.rowCount) throw conflict(`phải khoá kỳ ${earlier.rows[0].period} trước`);
    const tb = await trialBalance(pool, p);
    if (!tb.balanced) throw conflict('bảng cân đối số phát sinh không cân', tb.totals);
    const last = await pool.query<{ seq: number }>('SELECT max(seq) AS seq FROM journal_entries WHERE period <= $1', [p]);
    const chain = await verifyChain(pool, last.rows[0].seq ?? 0);
    if (!chain.ok) throw conflict('sổ cái bị can thiệp — không khoá được', chain.problems);
    const { rows } = await pool.query(
      `INSERT INTO periods (period, status, closed_at, closed_by, closing_hash) VALUES ($1, 'CLOSED', now(), $2, $3)
       ON CONFLICT (period) DO UPDATE SET status = 'CLOSED', closed_at = now(), closed_by = $2, closing_hash = $3
       WHERE periods.status = 'OPEN' RETURNING *`, [p, actor(req), chain.head]);
    if (!rows[0]) throw conflict(`kỳ ${p} đã khoá`);
    return { ...rows[0], totals: tb.totals };
  });

  app.get('/admin/integrity', acct, async () => verifyChain(pool));

  // ---- đối soát cổng thanh toán (sao kê settlement ↔ TK 1121) ----
  app.post('/admin/reconciliation', acct, async (req, reply) => {
    const b = reconIn.parse(req.body);
    const { rows } = await pool.query<{ ref: string; amount: number }>(
      `SELECT l.memo AS ref, SUM(l.debit)::bigint AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account = '1121' AND l.debit > 0 AND e.event_type = 'payment.succeeded' AND e.period = $1 GROUP BY l.memo`, [b.period]);
    const ledger = new Map(rows.map((r) => [r.ref, Number(r.amount)]));
    const gateway = new Map<string, number>();
    for (const r of b.rows) gateway.set(r.ref, (gateway.get(r.ref) ?? 0) + r.amount);
    const items: { ref: string; gateway_amount: number | null; ledger_amount: number | null; status: string }[] = [];
    for (const [ref, amt] of gateway) {
      const l = ledger.get(ref);
      items.push({ ref, gateway_amount: amt, ledger_amount: l ?? null,
        status: l === undefined ? 'MISSING_IN_LEDGER' : l === amt ? 'MATCHED' : 'AMOUNT_MISMATCH' });
    }
    for (const [ref, l] of ledger) if (!gateway.has(ref)) items.push({ ref, gateway_amount: null, ledger_amount: l, status: 'MISSING_AT_GATEWAY' });
    const summary = items.reduce<Record<string, number>>((s, i) => ({ ...s, [i.status]: (s[i.status] ?? 0) + 1 }), {});
    const id = newId();
    await withTx(pool, async (c) => {
      await c.query('INSERT INTO recon_runs (id, provider, period, created_by, summary) VALUES ($1,$2,$3,$4,$5)',
        [id, b.provider, b.period, actor(req), JSON.stringify(summary)]);
      for (const i of items) {
        await c.query('INSERT INTO recon_items (run_id, ref, gateway_amount, ledger_amount, status) VALUES ($1,$2,$3,$4,$5)',
          [id, i.ref, i.gateway_amount, i.ledger_amount, i.status]);
      }
    });
    reply.code(201);
    return { id, provider: b.provider, period: b.period, summary, exceptions: items.filter((i) => i.status !== 'MATCHED') };
  });

  /**
   * Đối soát COD với ĐVVC: bảng kê {orderId, codAmount, fee} ↔ số còn phải thu TK 1388 theo đơn.
   * Dòng khớp → bút toán quyết toán (Nợ 1121 thực nhận + Nợ 6418 phí thu hộ / Có 1388), khử trùng theo (đợt, đơn).
   * Lệch tiền / đơn không có trong sổ / đơn đã đối soát → danh sách ngoại lệ, không ghi sổ.
   */
  app.post('/admin/cod-reconciliation', acct, async (req, reply) => {
    const b = z.object({
      carrier: z.string().min(1).max(30), batchRef: z.string().min(1).max(60), date: z.string().date().optional(),
      rows: z.array(z.object({ orderId: z.string().min(1).max(64), codAmount: z.number().int().positive(), fee: z.number().int().min(0) })).min(1).max(20_000),
    }).parse(req.body);
    const date = b.date ?? today();
    const open = await pool.query<{ order_id: string; balance: number }>(
      `SELECT order_id, SUM(debit - credit)::bigint AS balance FROM journal_lines
        WHERE account = '1388' AND order_id = ANY($1) GROUP BY order_id`, [b.rows.map((r) => r.orderId)]);
    const bal = new Map(open.rows.map((r) => [r.order_id, Number(r.balance)]));
    const settled: { orderId: string; entryNo: string }[] = [];
    const exceptions: { orderId: string; reason: string; ledger: number | null; carrier: number }[] = [];
    for (const r of b.rows) {
      const owed = bal.get(r.orderId);
      if (owed === undefined) { exceptions.push({ orderId: r.orderId, reason: 'MISSING_IN_LEDGER', ledger: null, carrier: r.codAmount }); continue; }
      if (owed === 0) { exceptions.push({ orderId: r.orderId, reason: 'ALREADY_SETTLED', ledger: 0, carrier: r.codAmount }); continue; }
      if (owed !== r.codAmount) { exceptions.push({ orderId: r.orderId, reason: 'AMOUNT_MISMATCH', ledger: owed, carrier: r.codAmount }); continue; }
      if (r.fee > r.codAmount) { exceptions.push({ orderId: r.orderId, reason: 'FEE_EXCEEDS_COD', ledger: owed, carrier: r.codAmount }); continue; }
      const { entry } = await withTx(pool, (c) => postEntry(c, {
        date, source: 'manual', sourceRef: `cod:${b.carrier}:${b.batchRef}:${r.orderId}`, createdBy: actor(req),
        description: `Quyết toán COD ${b.carrier} đợt ${b.batchRef} — đơn ${r.orderId}`,
        lines: [
          { account: '1121', debit: r.codAmount - r.fee, partyType: 'carrier', partyId: b.carrier, orderId: r.orderId },
          { account: '6418', debit: r.fee, partyType: 'carrier', partyId: b.carrier, orderId: r.orderId, memo: 'phí thu hộ COD' },
          { account: '1388', credit: r.codAmount, partyType: 'carrier', partyId: 'default', orderId: r.orderId },
        ],
      }, today()));
      settled.push({ orderId: r.orderId, entryNo: entry.entry_no });
      bal.set(r.orderId, 0);
    }
    reply.code(201);
    return { carrier: b.carrier, batchRef: b.batchRef, settled: settled.length, exceptions,
      received: b.rows.filter((r) => settled.some((s) => s.orderId === r.orderId)).reduce((s, r) => s + r.codAmount - r.fee, 0), entries: settled };
  });

  // ---- seller: sao kê công nợ của shop mình ----
  app.get('/seller/statement', { preHandler: auth.requireRole('seller') }, async (req) => {
    const u = requireUser(req);
    if (!u.shopId) return { items: [], balance: 0 };
    const p = period.parse((req.query as { period?: string }).period ?? periodOf(today()));
    const { rows } = await pool.query(
      `SELECT e.entry_no, e.entry_date, e.description, l.order_id, l.debit, l.credit
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account = '331' AND l.party_type = 'shop' AND l.party_id = $1 AND e.period = $2 ORDER BY e.seq`, [u.shopId, p]);
    const bal = await pool.query<{ b: number }>(
      `SELECT COALESCE(SUM(credit - debit), 0)::bigint AS b FROM journal_lines WHERE account = '331' AND party_type = 'shop' AND party_id = $1`, [u.shopId]);
    const inv = await pool.query('SELECT invoice_no, series, order_id, issue_date, amount_before_tax, vat_amount, total FROM vat_invoices WHERE shop_id = $1 AND to_char(issue_date, \'YYYY-MM\') = $2 ORDER BY invoice_no', [u.shopId, p]);
    return { period: p, items: rows, balance: Number(bal.rows[0].b), invoices: inv.rows };
  });

  // ---- nội bộ ----
  /** payment service gọi khi admin xác nhận đã chuyển tiền cho seller. */
  app.post('/internal/payouts/paid', { preHandler: auth.internalOnly }, async (req, reply) => {
    const b = payoutIn.parse(req.body);
    const { entry, created } = await withTx(pool, (c) => postEntry(c, {
      date: today(), source: 'payout', sourceRef: b.payoutId, description: `Chi trả seller ${b.shopId} (yêu cầu ${b.payoutId})`,
      createdBy: 'service:payment',
      lines: [
        { account: '331', debit: b.amount, partyType: 'shop', partyId: b.shopId },
        { account: '1121', credit: b.amount, partyType: 'shop', partyId: b.shopId, memo: b.payoutId },
      ],
    }, today()));
    reply.code(created ? 201 : 200);
    return entry;
  });

  /** AIOps gọi khi uptime tháng dưới cam kết SLA → hoàn phí hoa hồng cho người bán (idempotent theo kỳ + nhóm chức năng). */
  app.post('/internal/sla-credits', { preHandler: auth.internalOnly }, async (req, reply) => {
    const b = z.object({
      period, component: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), pct: z.number().gt(0).max(1),
      uptime: z.number().min(0).max(1), target: z.number().gt(0).max(1), actor: z.string().min(1).max(200),
    }).parse(req.body);
    if (b.uptime >= b.target) throw badRequest('Uptime đạt cam kết — không có hoàn phí');
    const r = await withTx(pool, (c) => postSlaCredit(c, { ...b, vatRate: deps.vatRate ?? 0.1 }, today()));
    reply.code(r.created ? 201 : 200);
    return { created: r.created, entryNo: r.entry?.entry_no ?? null, total: r.total, shops: r.shops };
  });

  /** Luồng dữ liệu cho bộ kiểm toán AIOps (Benford, bút toán lạ…). */
  app.get('/internal/journal/export', { preHandler: auth.internalOnly }, async (req) => {
    const q = req.query as { sinceSeq?: string; limit?: string };
    const { rows } = await pool.query<EntryRow>('SELECT * FROM journal_entries WHERE seq > $1 ORDER BY seq LIMIT $2',
      [Number(q.sinceSeq ?? 0), Math.min(5000, Number(q.limit ?? 1000))]);
    return { items: await withLines(pool, rows) };
  });
}
