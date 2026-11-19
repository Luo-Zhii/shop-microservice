'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, PackageCheck, PackageOpen, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, EmptyState, Field, Input, PageTitle, QueryView, Select, Sheet, Tabs } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatNumber, formatVND, type Tone } from '@/lib/format';
import { toast } from '@/lib/toast';

type Tab = 'receipts' | 'picks' | 'counts' | 'ledger' | 'replenish';
interface Replenish { shopId: string; skuId: string; abc: 'A' | 'B' | 'C'; forecastPerDay: number; safetyStock: number; reorderPoint: number; available: number; daysOfCover: number | null; suggestQty: number; status: 'critical' | 'reorder' | 'ok' }
const RS: Record<Replenish['status'], { label: string; tone: Tone }> = { critical: { label: 'Dưới tồn an toàn', tone: 'danger' }, reorder: { label: 'Cần đặt hàng', tone: 'warning' }, ok: { label: 'Đủ hàng', tone: 'success' } };

function Replenishment() {
  const [lead, setLead] = useState('7');
  const q = useQuery({
    queryKey: ['wh-replenish', lead],
    queryFn: () => api.get<{ params: { days: number; serviceLevelZ: number }; items: Replenish[] }>('/warehouse/reports/replenishment', { leadTimeDays: Number(lead) || 7 }),
  });
  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
        <Field label="Thời gian giao hàng của NCC (ngày)" htmlFor="lead" className="w-full sm:w-64 sm:shrink-0">
          <Input id="lead" type="number" inputMode="numeric" min={1} max={90} value={lead} onChange={(e) => setLead(e.target.value)} />
        </Field>
        <p className="min-w-0 flex-1 text-sm text-muted">Dự báo làm mượt hàm mũ trên 28 ngày xuất kho · tồn an toàn mức phục vụ 95% · phân loại ABC theo giá trị xuất.</p>
      </div>
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa có dữ liệu xuất kho để dự báo" />}>
        {(d) => (
          <DataTable rows={d.items} rowKey={(r) => `${r.shopId}-${r.skuId}`}
            columns={[
              { key: 'sku', header: 'SKU', primary: true, cell: (r) => <span className="font-mono text-sm break-all">{r.skuId}</span> },
              { key: 'st', header: 'Tình trạng', badge: true, cell: (r) => <Badge tone={RS[r.status].tone}>{RS[r.status].label}</Badge> },
              { key: 'abc', header: 'ABC', align: 'center', cell: (r) => <b>{r.abc}</b> },
              { key: 'f', header: 'Dự báo/ngày', align: 'right', cell: (r) => formatNumber(r.forecastPerDay) },
              { key: 'a', header: 'Khả dụng', align: 'right', cell: (r) => formatNumber(r.available) },
              { key: 'cov', header: 'Đủ bán (ngày)', align: 'right', hideOnMobile: true, cell: (r) => (r.daysOfCover == null ? '—' : formatNumber(r.daysOfCover)) },
              { key: 'ss', header: 'Tồn an toàn / ROP', align: 'right', hideOnMobile: true, cell: (r) => `${formatNumber(r.safetyStock)} / ${formatNumber(r.reorderPoint)}` },
              { key: 'sg', header: 'Đề xuất nhập', align: 'right', cell: (r) => (r.suggestQty ? <b className="text-primary">{formatNumber(r.suggestQty)}</b> : '—') },
            ]} />
        )}
      </QueryView>
    </>
  );
}
interface ReceiptLine { sku_id: string; qty_expected: number; qty_received: number | null; qty_damaged: number; unit_cost: number }
interface Receipt { id: string; receipt_no: string; warehouse: string; shop_id: string; status: string; created_at: string; lines: ReceiptLine[] }
interface Pick { id: string; order_id: string; status: string; short_reason: string | null; created_at: string; lines: { sku_id: string; bin: string; qty: number }[] | null }
interface Count { id: string; count_no: string; warehouse: string; bin_prefix: string; status: string; variance_value: number | null; created_by: string; approved_by: string | null }
interface SheetLine { lot_id: string; bin: string; sku_id: string; counted_qty: number | null }

const ST: Record<string, Tone> = { EXPECTED: 'warning', RECEIVED: 'success', OPEN: 'warning', PICKED: 'success', SHORT: 'danger', CANCELLED: 'neutral',
  COUNTING: 'warning', SUBMITTED: 'info', APPROVED: 'success', REJECTED: 'danger' };

export default function AdminWarehousePage() {
  const [tab, setTab] = useState<Tab>('receipts');
  return (
    <div>
      <PageTitle>Kho sàn</PageTitle>
      <Tabs className="mb-4" value={tab} onChange={setTab} items={[
        { value: 'receipts', label: 'Nhập kho' }, { value: 'picks', label: 'Lấy hàng' }, { value: 'counts', label: 'Kiểm kê' }, { value: 'ledger', label: 'Nhập – xuất – tồn' },
        { value: 'replenish', label: 'Đề xuất nhập' },
      ]} />
      {tab === 'replenish' && <Replenishment />}
      {tab === 'receipts' && <Receipts />}
      {tab === 'picks' && <Picks />}
      {tab === 'counts' && <Counts />}
      {tab === 'ledger' && <StockLedger />}
    </div>
  );
}

function Receipts() {
  const qc = useQueryClient();
  const [sel, setSel] = useState<Receipt | null>(null);
  const [form, setForm] = useState<Record<string, { received: string; damaged: string; bin: string }>>({});
  const q = useQuery({ queryKey: ['wh-receipts'], queryFn: () => api.get<{ items: Receipt[] }>('/warehouse/receipts', { status: 'EXPECTED' }) });
  const recv = useMutation({
    mutationFn: (r: Receipt) => api.post<{ discrepancies: unknown[] }>(`/warehouse/receipts/${r.id}/receive`, {
      lines: r.lines.map((l) => {
        const f = form[l.sku_id];
        return { skuId: l.sku_id, received: Number(f?.received ?? l.qty_expected), damaged: Number(f?.damaged || 0), bin: f?.bin || 'A-01-01' };
      }),
    }),
    onSuccess: (r) => {
      toast.success(r.discrepancies.length ? `Đã nhập — ${r.discrepancies.length} dòng chênh lệch so với ASN` : 'Đã nhập kho đủ');
      setSel(null); void qc.invalidateQueries({ queryKey: ['wh-receipts'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (sku: string, k: 'received' | 'damaged' | 'bin', v: string) =>
    setForm((f) => ({ ...f, [sku]: { ...(f[sku] ?? { received: '', damaged: '', bin: '' }), [k]: v } }));
  return (
    <>
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<PackageOpen className="size-6" />} title="Không có lô hàng chờ nhận" />}>
        {(d) => (
          <DataTable rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => { setSel(r); setForm({}); }}
            columns={[
              { key: 'no', header: 'Phiếu nhập', primary: true, cell: (r) => <span className="font-mono">{r.receipt_no}</span> },
              { key: 'st', header: 'Trạng thái', badge: true, cell: (r) => <Badge tone={ST[r.status]}>{r.status}</Badge> },
              { key: 'wh', header: 'Kho', cell: (r) => r.warehouse },
              { key: 'n', header: 'Số SKU · SL', cell: (r) => `${r.lines.length} · ${formatNumber(r.lines.reduce((s, l) => s + l.qty_expected, 0))}` },
              { key: 'at', header: 'Báo lúc', cell: (r) => formatDate(r.created_at) },
            ]}
            actions={(r) => <Button size="sm" onClick={() => { setSel(r); setForm({}); }}><ScanLine className="size-4" />Nhận hàng</Button>} />
        )}
      </QueryView>
      <Sheet open={!!sel} onClose={() => setSel(null)} wide title={`Nhận hàng ${sel?.receipt_no ?? ''}`}
        footer={<Button onClick={() => sel && recv.mutate(sel)} disabled={recv.isPending}><PackageCheck className="size-4" />Xác nhận nhập kho</Button>}>
        <p className="mb-3 text-sm text-muted">Đếm thực tế từng SKU. Hàng hỏng tự chuyển khu cách ly (QRT), không bán được.</p>
        <ul className="flex flex-col gap-3">
          {sel?.lines.map((l) => (
            <li key={l.sku_id} className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-mono" title={l.sku_id}>{l.sku_id}</span>
                <span className="shrink-0 text-muted">ASN {l.qty_expected}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Nhận" htmlFor={`r-${l.sku_id}`}><Input id={`r-${l.sku_id}`} type="number" inputMode="numeric" min={0} placeholder={String(l.qty_expected)} value={form[l.sku_id]?.received ?? ''} onChange={(e) => set(l.sku_id, 'received', e.target.value)} /></Field>
                <Field label="Hỏng" htmlFor={`d-${l.sku_id}`}><Input id={`d-${l.sku_id}`} type="number" inputMode="numeric" min={0} placeholder="0" value={form[l.sku_id]?.damaged ?? ''} onChange={(e) => set(l.sku_id, 'damaged', e.target.value)} /></Field>
                <Field label="Vị trí" htmlFor={`b-${l.sku_id}`}><Input id={`b-${l.sku_id}`} autoCapitalize="characters" placeholder="A-01-01" value={form[l.sku_id]?.bin ?? ''} onChange={(e) => set(l.sku_id, 'bin', e.target.value.toUpperCase())} /></Field>
              </div>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}

function Picks() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const q = useQuery({ queryKey: ['wh-picks', status], queryFn: () => api.get<{ items: Pick[] }>('/warehouse/picks', { status }) });
  const confirm = useMutation({
    mutationFn: (id: string) => api.post<{ cogs: number }>(`/warehouse/picks/${id}/confirm`),
    onSuccess: (r) => { toast.success(`Đã xuất kho — giá vốn FIFO ${formatVND(r.cogs)}`); void qc.invalidateQueries({ queryKey: ['wh-picks'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <Tabs className="mb-3" value={status} onChange={setStatus} items={[{ value: 'OPEN', label: 'Chờ lấy' }, { value: 'SHORT', label: 'Thiếu hàng' }, { value: 'PICKED', label: 'Đã xuất' }]} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Không có phiếu" />}>
        {(d) => (
          <DataTable rows={d.items} rowKey={(p) => p.id}
            columns={[
              { key: 'o', header: 'Đơn', primary: true, cell: (p) => <span className="font-mono text-xs break-all">{p.order_id}</span> },
              { key: 'st', header: 'Trạng thái', badge: true, cell: (p) => <Badge tone={ST[p.status]}>{p.status}</Badge> },
              { key: 'l', header: 'Lấy ở', cell: (p) => p.short_reason ?? (
                <ul className="text-xs">{(p.lines ?? []).map((l, i) => <li key={i} className="whitespace-nowrap"><b>{l.bin}</b> · {l.sku_id} × {l.qty}</li>)}</ul>
              ) },
              { key: 'at', header: 'Tạo lúc', cell: (p) => formatDate(p.created_at) },
            ]}
            actions={(p) => p.status === 'OPEN' && <Button size="sm" onClick={() => confirm.mutate(p.id)} disabled={confirm.isPending}><PackageCheck className="size-4" />Đã lấy</Button>} />
        )}
      </QueryView>
    </>
  );
}

function Counts() {
  const qc = useQueryClient();
  const [wh, setWh] = useState('HCM1');
  const [prefix, setPrefix] = useState('');
  const [sheet, setSheet] = useState<Count | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['wh-counts'], queryFn: () => api.get<{ items: Count[] }>('/warehouse/counts') });
  const lines = useQuery({ enabled: !!sheet, queryKey: ['wh-count-sheet', sheet?.id], queryFn: () => api.get<{ items: SheetLine[] }>(`/warehouse/counts/${sheet!.id}/sheet`) });
  const inv = () => void qc.invalidateQueries({ queryKey: ['wh-counts'] });
  const start = useMutation({
    mutationFn: () => api.post<{ countNo: string; lines: number }>('/warehouse/counts', { warehouse: wh, binPrefix: prefix }),
    onSuccess: (r) => { toast.success(`Đã tạo ${r.countNo} (${r.lines} dòng)`); inv(); }, onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = useMutation({
    mutationFn: () => api.post<{ needsApproval: boolean; varianceValue: number }>(`/warehouse/counts/${sheet!.id}/submit`, {
      lines: (lines.data?.items ?? []).map((l) => ({ lotId: l.lot_id, qty: Number(counted[l.lot_id] ?? 0) })),
    }),
    onSuccess: (r) => {
      toast.success(`Đã nộp — chênh lệch ${formatVND(r.varianceValue)}${r.needsApproval ? ' · cần người khác duyệt' : ''}`);
      setSheet(null); inv();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const decide = useMutation({
    mutationFn: ({ id, ok }: { id: string; ok: boolean }) => api.post(`/warehouse/counts/${id}/${ok ? 'approve' : 'reject'}`),
    onSuccess: () => { toast.success('Đã xử lý phiếu kiểm kê'); inv(); }, onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
        <Field label="Kho" htmlFor="wh"><Select id="wh" value={wh} onChange={(e) => setWh(e.target.value)}><option value="HCM1">HCM1 · Củ Chi</option><option value="HN1">HN1 · Long Biên</option></Select></Field>
        <Field label="Dãy / kệ (tiền tố vị trí)" htmlFor="pf"><Input id="pf" placeholder="vd A-01 (trống = cả kho)" autoCapitalize="characters" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} /></Field>
        <Button onClick={() => start.mutate()} disabled={start.isPending}><ClipboardCheck className="size-4" />Tạo phiếu kiểm kê</Button>
      </div>
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa có phiếu kiểm kê" />}>
        {(d) => (
          <DataTable rows={d.items} rowKey={(c) => c.id}
            columns={[
              { key: 'no', header: 'Phiếu', primary: true, cell: (c) => <span className="font-mono">{c.count_no}</span> },
              { key: 'st', header: 'Trạng thái', badge: true, cell: (c) => <Badge tone={ST[c.status]}>{c.status}</Badge> },
              { key: 'scope', header: 'Phạm vi', cell: (c) => `${c.warehouse} ${c.bin_prefix || '(cả kho)'}` },
              { key: 'var', header: 'Chênh lệch', align: 'right', cell: (c) => (c.variance_value == null ? '—' : <span className={c.variance_value < 0 ? 'text-danger' : ''}>{formatVND(c.variance_value)}</span>) },
              { key: 'by', header: 'Người đếm / duyệt', cell: (c) => `${c.created_by}${c.approved_by ? ` / ${c.approved_by}` : ''}` },
            ]}
            actions={(c) => (c.status === 'COUNTING'
              ? <Button size="sm" onClick={() => { setSheet(c); setCounted({}); }}><ScanLine className="size-4" />Đếm</Button>
              : c.status === 'SUBMITTED' && <>
                <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: c.id, ok: false })}>Từ chối</Button>
                <Button size="sm" onClick={() => decide.mutate({ id: c.id, ok: true })}>Duyệt</Button>
              </>)} />
        )}
      </QueryView>
      <Sheet open={!!sheet} onClose={() => setSheet(null)} title={`Đếm ${sheet?.count_no ?? ''} (kiểm kê mù)`}
        footer={<Button onClick={() => submit.mutate()} disabled={submit.isPending || !lines.data}>Nộp kết quả</Button>}>
        <p className="mb-3 text-sm text-muted">Không hiển thị số trên hệ thống để kết quả đếm khách quan.</p>
        <QueryView q={lines}>
          {(d) => (
            <ul className="flex flex-col gap-2">
              {d.items.map((l) => (
                <li key={l.lot_id} className="flex items-center gap-3 rounded-xl border border-border p-3">
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="font-semibold">{l.bin}</div>
                    <div className="truncate font-mono text-xs text-muted" title={l.sku_id}>{l.sku_id}</div>
                  </div>
                  <Input aria-label={`Số đếm ${l.bin} ${l.sku_id}`} className="w-24 shrink-0" type="number" inputMode="numeric" min={0} enterKeyHint="next"
                    value={counted[l.lot_id] ?? ''} onChange={(e) => setCounted((c) => ({ ...c, [l.lot_id]: e.target.value }))} />
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Sheet>
    </>
  );
}

function StockLedger() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const end = new Date(new Date(to).getTime() + 86_400_000).toISOString().slice(0, 10);
  const q = useQuery({ queryKey: ['wh-ledger', from, end], queryFn: () => api.get<{ items: Record<string, number | string>[] }>('/warehouse/reports/stock-ledger', { from, to: end }) });
  const n = (v: unknown) => formatNumber(Number(v));
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:max-w-md">
        <Field label="Từ ngày" htmlFor="from"><Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Đến ngày" htmlFor="to"><Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Không có biến động trong kỳ" />}>
        {(d) => (
          <DataTable rows={d.items} rowKey={(r) => `${r.shop_id}-${r.sku_id}`}
            columns={[
              { key: 'sku', header: 'SKU', primary: true, cell: (r) => <span className="font-mono text-sm break-all">{String(r.sku_id)}</span> },
              { key: 'shop', header: 'Shop', hideOnMobile: true, cell: (r) => <span className="font-mono text-xs">{String(r.shop_id).slice(0, 8)}</span> },
              { key: 'o', header: 'Tồn đầu', align: 'right', cell: (r) => n(r.opening_qty) },
              { key: 'i', header: 'Nhập', align: 'right', cell: (r) => n(r.in_qty) },
              { key: 'x', header: 'Xuất', align: 'right', cell: (r) => n(r.out_qty) },
              { key: 'c', header: 'Tồn cuối', align: 'right', cell: (r) => <b>{n(r.closing_qty)}</b> },
              { key: 'v', header: 'Giá trị tồn', align: 'right', cell: (r) => formatVND(Number(r.closing_value)) },
            ]} />
        )}
      </QueryView>
    </>
  );
}
