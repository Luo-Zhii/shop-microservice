'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackagePlus, Plus, Trash2, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, EmptyState, Field, Input, PageTitle, QueryView, SectionTitle, Select, Sheet } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatNumber, type Tone } from '@/lib/format';
import { toast } from '@/lib/toast';

interface StockRow { sku_id: string; warehouse: string; on_hand: number; available: number | null; quarantined: number | null }
interface Replenish { skuId: string; abc: string; forecastPerDay: number; available: number; daysOfCover: number | null; suggestQty: number; status: 'critical' | 'reorder' | 'ok' }
const RS: Record<Replenish['status'], { label: string; tone: Tone }> = {
  critical: { label: 'Sắp hết', tone: 'danger' }, reorder: { label: 'Nên gửi thêm', tone: 'warning' }, ok: { label: 'Đủ hàng', tone: 'success' },
};

/** Hàng gửi kho sàn (ShopNow Fulfillment): tồn theo kho, gợi ý gửi thêm, báo trước lô hàng (ASN). */
export default function SellerFulfillmentPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [wh, setWh] = useState('HCM1');
  const [lines, setLines] = useState([{ skuId: '', qty: '', unitCost: '' }]);
  const stock = useQuery({ queryKey: ['seller-wh-stock'], queryFn: () => api.get<{ items: StockRow[] }>('/warehouse/seller/stock') });
  const rep = useQuery({ queryKey: ['seller-wh-rep'], queryFn: () => api.get<{ items: Replenish[] }>('/warehouse/seller/replenishment') });
  const asn = useMutation({
    mutationFn: () => api.post<{ receiptNo: string }>('/warehouse/seller/receipts', {
      warehouse: wh,
      lines: lines.filter((l) => l.skuId.trim()).map((l) => ({ skuId: l.skuId.trim(), qty: Number(l.qty), unitCost: Number(l.unitCost || 0) })),
    }),
    onSuccess: (r) => {
      toast.success(`Đã báo lô hàng ${r.receiptNo} — kho sẽ đếm khi nhận`);
      setOpen(false); setLines([{ skuId: '', qty: '', unitCost: '' }]);
      void qc.invalidateQueries({ queryKey: ['seller-wh-stock'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = lines.some((l) => l.skuId.trim() && Number(l.qty) > 0) && lines.every((l) => !l.skuId.trim() || Number(l.qty) > 0);
  const set = (i: number, k: 'skuId' | 'qty' | 'unitCost', v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div>
      <PageTitle actions={<Button onClick={() => setOpen(true)}><PackagePlus className="size-4" />Báo gửi hàng</Button>}>Hàng gửi kho sàn</PageTitle>
      <section className="mb-6">
        <SectionTitle>Gợi ý gửi thêm</SectionTitle>
        <QueryView q={rep} isEmpty={(d) => !d.items.some((r) => r.status !== 'ok')}
          empty={<EmptyState icon={<Warehouse className="size-6" />} title="Chưa có mã nào cần gửi thêm" description="Gợi ý dựa trên tốc độ bán 28 ngày gần nhất và thời gian vận chuyển 7 ngày." />}>
          {(d) => (
            <DataTable rows={d.items.filter((r) => r.status !== 'ok')} rowKey={(r) => r.skuId}
              columns={[
                { key: 'sku', header: 'SKU', primary: true, cell: (r) => <span className="font-mono text-sm break-all">{r.skuId}</span> },
                { key: 'st', header: 'Tình trạng', badge: true, cell: (r) => <Badge tone={RS[r.status].tone}>{RS[r.status].label}</Badge> },
                { key: 'f', header: 'Bán/ngày', align: 'right', cell: (r) => formatNumber(r.forecastPerDay) },
                { key: 'cov', header: 'Còn đủ bán', align: 'right', cell: (r) => (r.daysOfCover == null ? '—' : `${formatNumber(r.daysOfCover)} ngày`) },
                { key: 'sg', header: 'Nên gửi', align: 'right', cell: (r) => <b className="text-primary">{formatNumber(r.suggestQty)}</b> },
              ]} />
          )}
        </QueryView>
      </section>
      <section>
        <SectionTitle>Tồn tại kho</SectionTitle>
        <QueryView q={stock} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa gửi hàng vào kho sàn" />}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => `${r.sku_id}-${r.warehouse}`}
              columns={[
                { key: 'sku', header: 'SKU', primary: true, cell: (r) => <span className="font-mono text-sm break-all">{r.sku_id}</span> },
                { key: 'wh', header: 'Kho', badge: true, cell: (r) => <Badge>{r.warehouse}</Badge> },
                { key: 'oh', header: 'Trong kho', align: 'right', cell: (r) => formatNumber(r.on_hand) },
                { key: 'av', header: 'Bán được', align: 'right', cell: (r) => <b>{formatNumber(r.available ?? 0)}</b> },
                { key: 'q', header: 'Hỏng/cách ly', align: 'right', cell: (r) => (r.quarantined ? <span className="text-danger">{formatNumber(r.quarantined)}</span> : '—') },
              ]} />
          )}
        </QueryView>
      </section>
      <Sheet open={open} onClose={() => setOpen(false)} title="Báo trước lô hàng gửi kho (ASN)"
        footer={<Button onClick={() => asn.mutate()} disabled={!valid || asn.isPending}>Gửi phiếu báo</Button>}>
        <Field label="Kho nhận" htmlFor="asn-wh" className="mb-3">
          <Select id="asn-wh" value={wh} onChange={(e) => setWh(e.target.value)}><option value="HCM1">HCM1 · Củ Chi</option><option value="HN1">HN1 · Long Biên</option></Select>
        </Field>
        <ul className="flex flex-col gap-3">
          {lines.map((l, i) => (
            <li key={i} className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">Dòng {i + 1}</span>
                {lines.length > 1 && <Button variant="ghost" size="icon" aria-label={`Xoá dòng ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>}
              </div>
              <Field label="Mã SKU" htmlFor={`sku-${i}`} className="mb-2"><Input id={`sku-${i}`} autoCapitalize="off" value={l.skuId} onChange={(e) => set(i, 'skuId', e.target.value)} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Số lượng" htmlFor={`q-${i}`}><Input id={`q-${i}`} type="number" inputMode="numeric" min={1} value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></Field>
                <Field label="Giá vốn/đv (đ)" htmlFor={`c-${i}`}><Input id={`c-${i}`} type="number" inputMode="numeric" min={0} value={l.unitCost} onChange={(e) => set(i, 'unitCost', e.target.value)} /></Field>
              </div>
            </li>
          ))}
        </ul>
        <Button variant="outline" className="mt-3 w-full" onClick={() => setLines((ls) => [...ls, { skuId: '', qty: '', unitCost: '' }])}><Plus className="size-4" />Thêm dòng</Button>
      </Sheet>
    </div>
  );
}
