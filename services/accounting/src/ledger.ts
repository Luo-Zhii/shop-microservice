import { createHash } from 'node:crypto';
import { badRequest, conflict, newId, type Pool, type PoolClient } from '@shopnow/platform';

export type PartyType = 'shop' | 'buyer' | 'carrier' | 'checkout' | 'gateway';

export interface LineInput {
  account: string;
  debit?: number;
  credit?: number;
  partyType?: PartyType;
  partyId?: string;
  orderId?: string;
  memo?: string;
}

export interface EntryInput {
  date: string; // YYYY-MM-DD
  source: 'kafka' | 'manual' | 'payout' | 'reversal';
  sourceRef: string;
  eventType?: string;
  description: string;
  createdBy: string;
  reversalOf?: string;
  lines: LineInput[];
}

export interface EntryRow {
  id: string;
  seq: string;
  entry_no: string;
  entry_date: string;
  period: string;
  source: string;
  source_ref: string;
  event_type: string | null;
  description: string;
  created_by: string;
  reversal_of: string | null;
  reversed_by: string | null;
  total: string;
  prev_hash: string;
  hash: string;
  created_at: string;
  lines?: LineRow[];
}

export interface LineRow {
  line_no: number;
  account: string;
  debit: string;
  credit: string;
  party_type: PartyType | null;
  party_id: string | null;
  order_id: string | null;
  memo: string | null;
}

export const GENESIS = '0'.repeat(64);
const LOCK_KEY = 8115_0001;

/** Ngày theo múi giờ kế toán (mặc định Asia/Ho_Chi_Minh) — không dùng UTC để tránh lệch kỳ lúc 0h–7h. */
export function localDate(at: Date | string, tz = 'Asia/Ho_Chi_Minh') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
export const periodOf = (date: string) => date.slice(0, 7);

export function normalizeLines(lines: LineInput[]) {
  const out = lines
    .map((l) => ({ ...l, debit: Math.round(l.debit ?? 0), credit: Math.round(l.credit ?? 0) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  for (const l of out) {
    if (l.debit < 0 || l.credit < 0) throw badRequest(`dòng ${l.account}: số tiền âm`);
    if (l.debit > 0 && l.credit > 0) throw badRequest(`dòng ${l.account}: không được vừa Nợ vừa Có`);
  }
  const debit = out.reduce((s, l) => s + l.debit, 0);
  const credit = out.reduce((s, l) => s + l.credit, 0);
  if (out.length < 2) throw badRequest('bút toán cần ít nhất 2 dòng');
  if (debit !== credit) throw badRequest(`bút toán lệch: Nợ ${debit} ≠ Có ${credit}`);
  return { lines: out, total: debit };
}

/** Hash nội dung bút toán + hash bút toán trước → chuỗi chống sửa lén (tamper-evident). */
export function entryHash(prev: string, e: { entryNo: string; date: string; total: number; description: string }, lines: LineInput[]) {
  const canon = JSON.stringify([
    prev,
    e.entryNo,
    e.date,
    e.total,
    e.description,
    lines.map((l) => [l.account, l.debit ?? 0, l.credit ?? 0, l.partyType ?? null, l.partyId ?? null, l.orderId ?? null]),
  ]);
  return createHash('sha256').update(canon).digest('hex');
}

/** Kỳ đã khoá → dời ngày hạch toán sang hôm nay (kỳ mở hiện tại), ghi chú ngày gốc. */
async function resolveDate(c: PoolClient, date: string, today: string, description: string) {
  const { rows } = await c.query<{ status: string }>('SELECT status FROM periods WHERE period = $1', [periodOf(date)]);
  if (rows[0]?.status !== 'CLOSED') return { date, description };
  const now = await c.query<{ status: string }>('SELECT status FROM periods WHERE period = $1', [periodOf(today)]);
  if (now.rows[0]?.status === 'CLOSED') throw conflict(`kỳ ${periodOf(today)} đã khoá sổ — không ghi được`);
  return { date: today, description: `${description} (chứng từ ngày ${date}, ghi sau khoá sổ kỳ ${periodOf(date)})` };
}

/**
 * Ghi một bút toán trong transaction `c`. Khử trùng theo (source, sourceRef): ghi lại trả về bút toán cũ.
 * Khoá advisory theo transaction để chuỗi hash tuần tự (một người ghi tại một thời điểm).
 */
export async function postEntry(c: PoolClient, input: EntryInput, today: string): Promise<{ entry: EntryRow; created: boolean }> {
  const dup = await c.query<EntryRow>('SELECT * FROM journal_entries WHERE source = $1 AND source_ref = $2', [input.source, input.sourceRef]);
  if (dup.rowCount) return { entry: dup.rows[0], created: false };
  const { lines, total } = normalizeLines(input.lines);
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
  const { date, description } = await resolveDate(c, input.date, today, input.description);
  const period = periodOf(date);
  await c.query('INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING', [period]);
  const last = await c.query<{ hash: string; seq: string }>('SELECT hash, seq FROM journal_entries ORDER BY seq DESC LIMIT 1');
  const prev = last.rows[0]?.hash ?? GENESIS;
  const seq = Number(last.rows[0]?.seq ?? 0) + 1;
  const entryNo = `BT-${period.replace('-', '')}-${String(seq).padStart(6, '0')}`;
  const hash = entryHash(prev, { entryNo, date, total, description }, lines);
  const id = newId();
  await c.query(
    `INSERT INTO journal_entries (id, seq, entry_no, entry_date, period, source, source_ref, event_type, description, created_by,
       reversal_of, total, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, seq, entryNo, date, period, input.source, input.sourceRef, input.eventType ?? null, description, input.createdBy,
      input.reversalOf ?? null, total, prev, hash],
  );
  for (const [i, l] of lines.entries()) {
    await c.query(
      `INSERT INTO journal_lines (entry_id, line_no, account, debit, credit, party_type, party_id, order_id, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, i + 1, l.account, l.debit, l.credit, l.partyType ?? null, l.partyId ?? null, l.orderId ?? null, l.memo ?? null],
    );
  }
  const row = await c.query<EntryRow>('SELECT * FROM journal_entries WHERE id = $1', [id]);
  return { entry: row.rows[0], created: true };
}

/** Bút toán đảo: Nợ ↔ Có, ghi vào kỳ mở hiện tại; đánh dấu bút toán gốc. */
export async function reverseEntry(c: PoolClient, id: string, reason: string, actor: string, today: string) {
  const { rows } = await c.query<EntryRow>('SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE', [id]);
  const orig = rows[0];
  if (!orig) return null;
  if (orig.reversed_by) throw conflict(`bút toán ${orig.entry_no} đã được đảo`);
  if (orig.reversal_of) throw conflict('không đảo một bút toán đảo — lập bút toán mới');
  const lines = await c.query<LineRow>('SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [id]);
  const { entry } = await postEntry(c, {
    date: today,
    source: 'reversal',
    sourceRef: orig.id,
    description: `Đảo ${orig.entry_no}: ${reason}`,
    createdBy: actor,
    reversalOf: orig.id,
    lines: lines.rows.map((l) => ({
      account: l.account, debit: Number(l.credit), credit: Number(l.debit),
      partyType: l.party_type ?? undefined, partyId: l.party_id ?? undefined, orderId: l.order_id ?? undefined, memo: l.memo ?? undefined,
    })),
  }, today);
  await c.query('UPDATE journal_entries SET reversed_by = $1 WHERE id = $2', [entry.id, orig.id]);
  return entry;
}

export async function withLines(pool: Pool | PoolClient, entries: EntryRow[]) {
  if (!entries.length) return entries;
  const { rows } = await pool.query<LineRow & { entry_id: string }>(
    'SELECT * FROM journal_lines WHERE entry_id = ANY($1) ORDER BY entry_id, line_no', [entries.map((e) => e.id)]);
  const by = new Map<string, LineRow[]>();
  for (const r of rows) by.set(r.entry_id, [...(by.get(r.entry_id) ?? []), r]);
  return entries.map((e) => ({ ...e, lines: by.get(e.id) ?? [] }));
}

/** Kiểm toàn vẹn: chuỗi hash liên tục, hash khớp nội dung, mọi bút toán cân. */
export async function verifyChain(pool: Pool, upToSeq?: number) {
  const { rows } = await pool.query<EntryRow>(
    'SELECT * FROM journal_entries WHERE ($1::bigint IS NULL OR seq <= $1) ORDER BY seq', [upToSeq ?? null]);
  const full = await withLines(pool, rows);
  let prev = GENESIS;
  const problems: { entryNo: string; problem: string }[] = [];
  for (const e of full) {
    const lines = (e.lines ?? []).map((l) => ({
      account: l.account, debit: Number(l.debit), credit: Number(l.credit),
      partyType: l.party_type ?? undefined, partyId: l.party_id ?? undefined, orderId: l.order_id ?? undefined,
    }));
    if (e.prev_hash !== prev) problems.push({ entryNo: e.entry_no, problem: 'đứt chuỗi hash (prev_hash không khớp)' });
    const h = entryHash(e.prev_hash, { entryNo: e.entry_no, date: String(e.entry_date), total: Number(e.total), description: e.description }, lines);
    if (h !== e.hash) problems.push({ entryNo: e.entry_no, problem: 'nội dung bị sửa (hash không khớp)' });
    const d = lines.reduce((s, l) => s + l.debit, 0);
    const cr = lines.reduce((s, l) => s + l.credit, 0);
    if (d !== cr || d !== Number(e.total)) problems.push({ entryNo: e.entry_no, problem: `lệch Nợ ${d} / Có ${cr}` });
    prev = e.hash;
  }
  return { ok: problems.length === 0, entries: full.length, head: prev, problems };
}

export interface TrialRow {
  account: string;
  name: string;
  type: string;
  normal: 'DEBIT' | 'CREDIT';
  openingDebit: number;
  openingCredit: number;
  debit: number;
  credit: number;
  closingDebit: number;
  closingCredit: number;
}

/** Bảng cân đối số phát sinh (trial balance) của một kỳ — số dư đầu kỳ, phát sinh, số dư cuối kỳ. */
export async function trialBalance(pool: Pool | PoolClient, period: string) {
  const { rows } = await pool.query<{ code: string; name: string; type: string; normal: 'DEBIT' | 'CREDIT'; od: string; oc: string; d: string; c: string }>(
    `SELECT a.code, a.name, a.type, a.normal,
            COALESCE(SUM(l.debit)  FILTER (WHERE e.period <  $1), 0) AS od,
            COALESCE(SUM(l.credit) FILTER (WHERE e.period <  $1), 0) AS oc,
            COALESCE(SUM(l.debit)  FILTER (WHERE e.period =  $1), 0) AS d,
            COALESCE(SUM(l.credit) FILTER (WHERE e.period =  $1), 0) AS c
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account = a.code
       LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.period <= $1
      GROUP BY a.code ORDER BY a.code`, [period]);
  const out: TrialRow[] = [];
  for (const r of rows) {
    const opening = Number(r.od) - Number(r.oc);
    const closing = opening + Number(r.d) - Number(r.c);
    if (!opening && !Number(r.d) && !Number(r.c)) continue;
    out.push({
      account: r.code, name: r.name, type: r.type, normal: r.normal,
      openingDebit: Math.max(0, opening), openingCredit: Math.max(0, -opening),
      debit: Number(r.d), credit: Number(r.c),
      closingDebit: Math.max(0, closing), closingCredit: Math.max(0, -closing),
    });
  }
  const sum = (k: keyof TrialRow) => out.reduce((s, r) => s + (r[k] as number), 0);
  const totals = {
    openingDebit: sum('openingDebit'), openingCredit: sum('openingCredit'), debit: sum('debit'), credit: sum('credit'),
    closingDebit: sum('closingDebit'), closingCredit: sum('closingCredit'),
  };
  const balanced = totals.debit === totals.credit && totals.closingDebit === totals.closingCredit;
  return { period, rows: out, totals, balanced };
}
