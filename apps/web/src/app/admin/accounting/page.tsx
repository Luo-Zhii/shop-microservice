'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FileCheck2, Lock, ShieldCheck, ShieldX, Sparkles, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Stat } from '@/components/stat';
import { Badge, Button, Card, ConfirmSheet, EmptyState, Field, Input, PageTitle, Pagination, QueryView, ReasonSheet, SectionTitle, Select, Tabs, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatVND, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';

type Tab = 'trial' | 'journal' | 'payables' | 'recon' | 'close' | 'audit';
interface TrialRow { account: string; name: string; openingDebit: number; openingCredit: number; debit: number; credit: number; closingDebit: number; closingCredit: number }
interface Trial { period: string; rows: TrialRow[]; totals: Omit<TrialRow, 'account' | 'name'>; balanced: boolean }
interface Line { line_no: number; account: string; debit: number; credit: number; party_type: string | null; party_id: string | null; order_id: string | null }
interface Entry { id: string; entry_no: string; entry_date: string; period: string; source: string; description: string; created_by: string; total: number; reversed_by: string | null; reversal_of: string | null; hash: string; lines: Line[] }
interface Period { period: string; status: 'OPEN' | 'CLOSED'; closed_at: string | null; closed_by: string | null; closing_hash: string | null }
interface Finding { rule: string; severity: 'low' | 'medium' | 'high'; entry_no: string | null; detail: string }

const thisMonth = () => new Date().toISOString().slice(0, 7);
const RULE: Record<string, string> = {
  benford: 'Lệch luật Benford', round_amount: 'Số tròn bất thường', off_hours: 'Ghi ngoài giờ', sensitive_account: 'TK nhạy cảm',
  duplicate: 'Nghi chi trùng', reversal_rate: 'Tỉ lệ đảo cao',
};

export default function AdminAccountingPage() {
  const [tab, setTab] = useState<Tab>('trial');
  const [period, setPeriod] = useState(thisMonth());
  return (
    <div>
      <PageTitle actions={<Field label="Kỳ" htmlFor="period" className="w-48 max-w-full"><Input id="period" type="month" value={period} onChange={(e) => setPeriod(e.target.value || thisMonth())} /></Field>}>
        Kế toán
      </PageTitle>
      <Tabs className="mb-4" value={tab} onChange={setTab} items={[
        { value: 'trial', label: 'Cân đối số phát sinh' }, { value: 'journal', label: 'Nhật ký chung' }, { value: 'payables', label: 'Tuổi nợ seller' },
        { value: 'recon', label: 'Đối soát' }, { value: 'close', label: 'Khoá sổ & toàn vẹn' }, { value: 'audit', label: 'Kiểm toán AI' },
      ]} />
      {tab === 'trial' && <TrialBalance period={period} />}
      {tab === 'journal' && <Journal period={period} />}
      {tab === 'payables' && <Payables />}
      {tab === 'recon' && <Reconciliation period={period} />}
      {tab === 'close' && <Closing />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function TrialBalance({ period }: { period: string }) {
  const q = useQuery({ queryKey: ['acc-trial', period], queryFn: () => api.get<Trial>('/accounting/admin/trial-balance', { period }) });
  const vat = useQuery({ queryKey: ['acc-vat', period], queryFn: () => api.get<{ outputVat: number; inputVat: number; payable: number; carryForward: number; invoices: { count: number }; invoiceGap: number }>('/accounting/admin/vat-summary', { period }) });
  const pnl = useQuery({ queryKey: ['acc-pnl', period], queryFn: () => api.get<{ revenue: number; expense: number; profit: number; vatOutput: number }>('/accounting/admin/pnl', { period }) });
  return (
    <QueryView q={q} isEmpty={(d) => !d.rows.length} empty={<EmptyState icon={<BookOpen className="size-6" />} title="Kỳ chưa có phát sinh" />}>
      {(d) => (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Doanh thu" value={formatVND(pnl.data?.revenue ?? 0)} />
            <Stat label="Chi phí" value={formatVND(pnl.data?.expense ?? 0)} />
            <Stat label="Lợi nhuận" value={formatVND(pnl.data?.profit ?? 0)} tone={(pnl.data?.profit ?? 0) < 0 ? 'danger' : 'success'} />
            <Stat label="VAT đầu ra" value={formatVND(pnl.data?.vatOutput ?? 0)} />
          </div>
          {vat.data && (
            <Card className="mb-4 flex flex-col gap-1.5 p-3 text-sm sm:flex-row sm:flex-wrap sm:gap-x-6">
              <span>GTGT đầu ra <b>{formatVND(vat.data.outputVat)}</b></span>
              <span>Đầu vào được khấu trừ <b>{formatVND(vat.data.inputVat)}</b></span>
              {vat.data.payable > 0
                ? <span>Phải nộp <b className="text-danger">{formatVND(vat.data.payable)}</b></span>
                : <span>Khấu trừ chuyển kỳ sau <b className="text-success">{formatVND(vat.data.carryForward)}</b></span>}
              <span className="text-muted">HĐĐT đã phát hành: {vat.data.invoices.count} · lệch so với đầu ra {formatVND(vat.data.invoiceGap)}</span>
            </Card>
          )}
          <DataTable rows={d.rows} rowKey={(r) => r.account}
            columns={[
              { key: 'acc', header: 'Tài khoản', primary: true, cell: (r) => <span><span className="font-mono">{r.account}</span> · {r.name}</span> },
              { key: 'od', header: 'Dư Nợ đầu', align: 'right', hideOnMobile: true, cell: (r) => money(r.openingDebit) },
              { key: 'oc', header: 'Dư Có đầu', align: 'right', hideOnMobile: true, cell: (r) => money(r.openingCredit) },
              { key: 'd', header: 'PS Nợ', align: 'right', cell: (r) => money(r.debit) },
              { key: 'c', header: 'PS Có', align: 'right', cell: (r) => money(r.credit) },
              { key: 'cd', header: 'Dư Nợ cuối', align: 'right', cell: (r) => money(r.closingDebit) },
              { key: 'cc', header: 'Dư Có cuối', align: 'right', cell: (r) => money(r.closingCredit) },
            ]} />
          <Card className="mt-3 flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <span>Tổng PS Nợ <b>{formatVND(d.totals.debit)}</b> · PS Có <b>{formatVND(d.totals.credit)}</b></span>
            {d.balanced ? <Badge tone="success">Cân</Badge> : <Badge tone="danger">Lệch</Badge>}
          </Card>
        </>
      )}
    </QueryView>
  );
}

const money = (v: number) => (v ? formatVND(v) : <span className="text-muted">—</span>);

function Journal({ period }: { period: string }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [rev, setRev] = useState<Entry | null>(null);
  const pageSize = 20;
  const q = useQuery({
    queryKey: ['acc-journal', period, page, search],
    placeholderData: keepPreviousData,
    queryFn: () => api.get<{ items: Entry[]; total: number }>('/accounting/admin/journal', { period, page, pageSize, q: search || undefined }),
  });
  const reverse = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/accounting/admin/journal/${id}/reverse`, { reason }),
    onSuccess: () => { toast.success('Đã lập bút toán đảo'); setRev(null); void qc.invalidateQueries({ queryKey: ['acc-journal'] }); },
  });
  return (
    <>
      <Input className="mb-3" type="search" inputMode="search" placeholder="Tìm số bút toán, diễn giải…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Không có bút toán" />}>
        {(d) => (
          <>
            <DataTable rows={d.items} rowKey={(e) => e.id}
              columns={[
                { key: 'no', header: 'Số BT', primary: true, cell: (e) => <span className="font-mono text-sm">{e.entry_no}</span> },
                { key: 'src', header: 'Nguồn', badge: true, cell: (e) => <Badge tone={e.source === 'manual' ? 'warning' : e.source === 'reversal' ? 'danger' : 'neutral'}>{e.source}</Badge> },
                { key: 'date', header: 'Ngày', cell: (e) => formatDate(e.entry_date, false) },
                { key: 'desc', header: 'Diễn giải', cell: (e) => <span className="line-clamp-2 break-words">{e.description}</span> },
                { key: 'lines', header: 'Định khoản', cell: (e) => (
                  <ul className="text-xs">{e.lines.map((l) => <li key={l.line_no} className="whitespace-nowrap">{l.debit ? `Nợ ${l.account}` : `Có ${l.account}`} {formatVND(l.debit || l.credit)}</li>)}</ul>
                ) },
                { key: 'total', header: 'Số tiền', align: 'right', cell: (e) => <span className="font-semibold">{formatVND(e.total)}</span> },
              ]}
              actions={(e) => !e.reversed_by && !e.reversal_of && (
                <Button size="sm" variant="outline" onClick={() => setRev(e)}><Undo2 className="size-4" />Đảo</Button>
              )} />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>
      <ReasonSheet open={!!rev} onClose={() => setRev(null)} title={`Đảo bút toán ${rev?.entry_no ?? ''}`} confirmText="Lập bút toán đảo" danger
        loading={reverse.isPending} onConfirm={(reason) => rev && reverse.mutate({ id: rev.id, reason })}
        presets={['Ghi nhầm tài khoản', 'Sai số tiền', 'Trùng chứng từ']} />
    </>
  );
}

interface Aging { shopId: string; balance: number; buckets: Record<'0-7' | '8-15' | '16-30' | '>30', number>; oldestDays: number | null; overdue: number }

function Payables() {
  const q = useQuery({ queryKey: ['acc-aging'], queryFn: () => api.get<{ asOf: string; overdueDays: number; totals: Record<string, number>; items: Aging[] }>('/accounting/admin/payables/aging') });
  return (
    <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa có công nợ seller" />}>
      {(d) => (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(['0-7', '8-15', '16-30', '>30'] as const).map((b) => (
              <Stat key={b} label={`${b} ngày`} value={formatVND(d.totals[b] ?? 0)} tone={b === '>30' && d.totals[b] ? 'danger' : undefined} />
            ))}
          </div>
          <DataTable rows={d.items} rowKey={(r) => r.shopId}
            columns={[
              { key: 'shop', header: 'Shop', primary: true, cell: (r) => <span className="font-mono text-xs break-all">{r.shopId}</span> },
              { key: 'st', header: 'Quá hạn', badge: true, cell: (r) => (r.overdue ? <Badge tone="danger">Quá {d.overdueDays} ngày</Badge> : <Badge tone="success">Trong hạn</Badge>) },
              { key: 'bal', header: 'Còn phải trả', align: 'right', cell: (r) => <b>{formatVND(r.balance)}</b> },
              { key: 'b1', header: '0–7', align: 'right', hideOnMobile: true, cell: (r) => money(r.buckets['0-7']) },
              { key: 'b2', header: '8–15', align: 'right', hideOnMobile: true, cell: (r) => money(r.buckets['8-15']) },
              { key: 'b3', header: '16–30', align: 'right', hideOnMobile: true, cell: (r) => money(r.buckets['16-30']) },
              { key: 'b4', header: '>30', align: 'right', cell: (r) => (r.buckets['>30'] ? <span className="text-danger">{formatVND(r.buckets['>30'])}</span> : '—') },
              { key: 'old', header: 'Khoản cũ nhất', align: 'right', cell: (r) => (r.oldestDays == null ? '—' : `${r.oldestDays} ngày`) },
            ]} />
        </>
      )}
    </QueryView>
  );
}

function Closing() {
  const qc = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const periods = useQuery({ queryKey: ['acc-periods'], queryFn: () => api.get<{ items: Period[] }>('/accounting/admin/periods') });
  const integ = useQuery({ queryKey: ['acc-integrity'], queryFn: () => api.get<{ ok: boolean; entries: number; head: string; problems: { entryNo: string; problem: string }[] }>('/accounting/admin/integrity') });
  const close = useMutation({
    mutationFn: (p: string) => api.post(`/accounting/admin/periods/${p}/close`),
    onSuccess: () => { toast.success('Đã khoá sổ'); setTarget(null); void qc.invalidateQueries({ queryKey: ['acc-periods'] }); },
  });
  return (
    <div className="flex flex-col gap-4">
      <QueryView q={integ}>
        {(d) => (
          <Card className="flex items-start gap-3 p-3">
            {d.ok ? <ShieldCheck className="size-6 shrink-0 text-success" /> : <ShieldX className="size-6 shrink-0 text-danger" />}
            <div className="min-w-0 text-sm">
              <p className="font-medium">{d.ok ? 'Sổ cái nguyên vẹn' : 'Phát hiện sổ cái bị can thiệp'}</p>
              <p className="text-muted">{d.entries} bút toán · đầu chuỗi <span className="font-mono break-all">{d.head.slice(0, 16)}…</span></p>
              {d.problems.slice(0, 5).map((p) => <p key={p.entryNo + p.problem} className="text-danger">{p.entryNo}: {p.problem}</p>)}
            </div>
          </Card>
        )}
      </QueryView>
      <section>
        <SectionTitle>Kỳ kế toán</SectionTitle>
        <QueryView q={periods} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa có kỳ" />}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(p) => p.period}
              columns={[
                { key: 'p', header: 'Kỳ', primary: true, cell: (p) => <span className="font-medium">{p.period}</span> },
                { key: 's', header: 'Trạng thái', badge: true, cell: (p) => (p.status === 'CLOSED' ? <Badge tone="neutral">Đã khoá</Badge> : <Badge tone="success">Đang mở</Badge>) },
                { key: 'by', header: 'Người khoá', cell: (p) => p.closed_by ?? '—' },
                { key: 'at', header: 'Lúc', cell: (p) => (p.closed_at ? formatDate(p.closed_at) : '—') },
              ]}
              actions={(p) => p.status === 'OPEN' && p.period < thisMonth() && <Button size="sm" onClick={() => setTarget(p.period)}><Lock className="size-4" />Khoá sổ</Button>} />
          )}
        </QueryView>
      </section>
      <ConfirmSheet open={!!target} onClose={() => setTarget(null)} title={`Khoá sổ kỳ ${target}`} confirmText="Khoá sổ" danger
        message="Sau khi khoá, không ghi thêm bút toán vào kỳ này; chứng từ đến trễ sẽ hạch toán vào kỳ hiện tại."
        loading={close.isPending} onConfirm={() => target && close.mutate(target)} />
    </div>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ['aiops-ledger-audit'], queryFn: () => api.get<{ entries: number; findings: Finding[]; benford: { n: number; mad: number | null; conformity: string; observed: Record<string, number>; expected: Record<string, number> } }>('/aiops/audit/ledger') });
  return (
    <QueryView q={q}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Bút toán đã quét" value={String(d.entries)} />
            <Stat label="Phát hiện" value={String(d.findings.length)} tone={d.findings.length ? 'danger' : 'success'} />
            <Stat label="Benford (MAD)" value={d.benford.mad == null ? 'chưa đủ mẫu' : String(d.benford.mad)} />
            <Stat label="Mức phù hợp" value={d.benford.conformity} />
          </div>
          {d.benford.mad != null && (
            <Card className="p-3">
              <SectionTitle>Chữ số đầu: thực tế vs Benford</SectionTitle>
              <div className="flex h-32 items-end gap-1.5" role="img" aria-label="Biểu đồ phân phối chữ số đầu">
                {Object.keys(d.benford.expected).map((k) => (
                  <div key={k} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-0.5">
                    <div className="relative w-full flex-1">
                      <div className="absolute inset-x-0 bottom-0 rounded-t bg-primary/70" style={{ height: `${(d.benford.observed[k] ?? 0) * 250}%` }} title={`thực tế ${(d.benford.observed[k] * 100).toFixed(1)}%`} />
                      <div className="absolute inset-x-0 border-t-2 border-dashed border-warning" style={{ bottom: `${d.benford.expected[k] * 250}%` }} title={`Benford ${(d.benford.expected[k] * 100).toFixed(1)}%`} />
                    </div>
                    <span className="text-xs text-muted">{k}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">Cột: tỉ lệ thực tế · vạch đứt: kỳ vọng Benford</p>
            </Card>
          )}
          <DataTable rows={d.findings} rowKey={(f) => `${f.rule}-${f.entry_no}-${f.detail}`}
            empty={<EmptyState icon={<Sparkles className="size-6" />} title="Không phát hiện bất thường" />}
            columns={[
              { key: 'rule', header: 'Luật', primary: true, cell: (f) => RULE[f.rule] ?? f.rule },
              { key: 'sev', header: 'Mức', badge: true, cell: (f) => <Badge tone={f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warning' : 'neutral'}>{f.severity}</Badge> },
              { key: 'no', header: 'Bút toán', cell: (f) => <span className="font-mono text-xs">{f.entry_no ?? '—'}</span> },
              { key: 'detail', header: 'Chi tiết', cell: (f) => <span className="break-words">{f.detail}</span> },
            ]} />
        </div>
      )}
    </QueryView>
  );
}

// ---------------------------------------------------------------- đối soát (cổng thanh toán / COD ĐVVC)
interface ReconException { ref?: string; orderId?: string; status?: string; reason?: string; gateway_amount?: number | null; ledger_amount?: number | null; ledger?: number | null; carrier?: number }
interface ReconResult { settled?: number; received?: number; summary?: Record<string, number>; exceptions: ReconException[] }
const REASON_VI: Record<string, string> = {
  AMOUNT_MISMATCH: 'Lệch tiền', MISSING_IN_LEDGER: 'Không có trong sổ', MISSING_AT_GATEWAY: 'Có trong sổ, thiếu ở sao kê',
  ALREADY_SETTLED: 'Đã đối soát trước đó', FEE_EXCEEDS_COD: 'Phí lớn hơn tiền thu hộ',
};

/** Dán CSV từ ĐVVC / cổng thanh toán — dòng tiêu đề (nếu có) bị bỏ qua, phân cách bằng dấu phẩy, chấm phẩy hoặc tab. */
function parseCsv(text: string) {
  return text.split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((c) => c.trim())).filter((c) => c[0] && /\d/.test(c[1] ?? ''));
}

function Reconciliation({ period }: { period: string }) {
  const [kind, setKind] = useState<'cod' | 'gateway'>('cod');
  const [partner, setPartner] = useState('GHN');
  const [batch, setBatch] = useState('');
  const [csv, setCsv] = useState('');
  const rows = parseCsv(csv);
  const run = useMutation({
    mutationFn: (): Promise<ReconResult> => (kind === 'cod'
      ? api.post<ReconResult>('/accounting/admin/cod-reconciliation', {
        carrier: partner, batchRef: batch || `DS-${new Date().toISOString().slice(0, 10)}`,
        rows: rows.map((c) => ({ orderId: c[0], codAmount: Number(c[1]), fee: Number(c[2] || 0) })),
      })
      : api.post<ReconResult>('/accounting/admin/reconciliation', {
        provider: partner, period, rows: rows.map((c) => ({ ref: c[0], amount: Number(c[1]) })),
      })),
    onSuccess: () => toast.success('Đã đối soát'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const res = run.data;
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Loại" htmlFor="rk"><Select id="rk" value={kind} onChange={(e) => { setKind(e.target.value as 'cod' | 'gateway'); setPartner(e.target.value === 'cod' ? 'GHN' : 'vnpay'); }}>
            <option value="cod">COD với đơn vị vận chuyển</option><option value="gateway">Sao kê cổng thanh toán</option></Select></Field>
          <Field label={kind === 'cod' ? 'Đơn vị vận chuyển' : 'Cổng thanh toán'} htmlFor="rp"><Input id="rp" value={partner} onChange={(e) => setPartner(e.target.value)} /></Field>
          {kind === 'cod' && <Field label="Mã đợt bảng kê" htmlFor="rb"><Input id="rb" placeholder="vd DS-2026-11-20" value={batch} onChange={(e) => setBatch(e.target.value)} /></Field>}
        </div>
        <Field label={kind === 'cod' ? 'Bảng kê (mã đơn, tiền thu hộ, phí)' : 'Sao kê (mã checkout, số tiền)'} htmlFor="rc"
          hint={`${rows.length} dòng hợp lệ · dán thẳng từ Excel/CSV`}>
          <Textarea id="rc" rows={6} className="font-mono" value={csv} onChange={(e) => setCsv(e.target.value)}
            placeholder={kind === 'cod' ? 'ma_don,tien_thu_ho,phi\n01934f6e-…,500000,8000' : 'checkout_id,so_tien\n01934f6e-…,1030000'} />
        </Field>
        <Button className="self-end" onClick={() => run.mutate()} disabled={!rows.length || run.isPending}><FileCheck2 className="size-4" />Đối soát</Button>
      </Card>
      {res && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {res.settled != null && <Stat label="Đã quyết toán" value={String(res.settled)} tone="success" />}
            {res.received != null && <Stat label="Thực nhận" value={formatVND(res.received)} />}
            {res.summary && Object.entries(res.summary).map(([k, v]) => <Stat key={k} label={REASON_VI[k] ?? (k === 'MATCHED' ? 'Khớp' : k)} value={String(v)} tone={k === 'MATCHED' ? 'success' : 'danger'} />)}
            <Stat label="Ngoại lệ" value={String(res.exceptions.length)} tone={res.exceptions.length ? 'danger' : 'success'} />
          </div>
          <DataTable rows={res.exceptions} rowKey={(e) => `${e.orderId ?? e.ref}-${e.reason ?? e.status}`}
            empty={<EmptyState icon={<FileCheck2 className="size-6" />} title="Không có ngoại lệ" />}
            columns={[
              { key: 'ref', header: kind === 'cod' ? 'Mã đơn' : 'Mã checkout', primary: true, cell: (e) => <span className="font-mono text-xs break-all">{e.orderId ?? e.ref}</span> },
              { key: 'why', header: 'Lý do', badge: true, cell: (e) => <Badge tone="danger">{REASON_VI[e.reason ?? e.status ?? ''] ?? e.reason ?? e.status}</Badge> },
              { key: 'ledger', header: 'Trong sổ', align: 'right', cell: (e) => { const v = e.ledger ?? e.ledger_amount; return v == null ? '—' : formatVND(v); } },
              { key: 'partner', header: kind === 'cod' ? 'Bảng kê ĐVVC' : 'Sao kê', align: 'right', cell: (e) => { const v = e.carrier ?? e.gateway_amount; return v == null ? '—' : formatVND(v); } },
            ]} />
        </>
      )}
    </div>
  );
}
