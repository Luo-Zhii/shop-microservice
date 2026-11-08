'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Card, EmptyState, Field, Input, PageTitle, QueryView, Sheet } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { asArray, formatDate, formatVND, toDateTimeLocal, variantLabel } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { FlashSale, ProductSnapshot } from '@/lib/types';

interface Line { productId: string; skuId: string; title: string; label: string; price: number; salePrice: string; quota: string }

function saleState(s: FlashSale) {
  const now = Date.now();
  if (new Date(s.startsAt).getTime() > now) return { label: 'Sắp diễn ra', tone: 'info' as const };
  if (new Date(s.endsAt).getTime() < now) return { label: 'Đã kết thúc', tone: 'neutral' as const };
  return { label: 'Đang diễn ra', tone: 'success' as const };
}

export default function AdminFlashSalesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-flash'], queryFn: async () => asArray<FlashSale>(await api.get('/promotion/admin/flash-sales')) });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [startsAt, setStartsAt] = useState(toDateTimeLocal(new Date(Date.now() + 3600_000).toISOString()));
  const [endsAt, setEndsAt] = useState(toDateTimeLocal(new Date(Date.now() + 3 * 3600_000).toISOString()));
  const [lines, setLines] = useState<Line[]>([]);
  const [lookup, setLookup] = useState('');
  const [found, setFound] = useState<ProductSnapshot | null>(null);
  const [looking, setLooking] = useState(false);

  const find = async () => {
    if (!lookup.trim()) return;
    setLooking(true);
    try {
      const r = await api.get<ProductSnapshot | { product: ProductSnapshot }>(`/catalog/products/${encodeURIComponent(lookup.trim())}`);
      setFound('product' in r ? r.product : r);
    } catch (e) {
      toast.error(errorMessage(e));
      setFound(null);
    } finally {
      setLooking(false);
    }
  };
  const addVariant = (p: ProductSnapshot, v: ProductSnapshot['variants'][number]) => {
    if (lines.some((l) => l.skuId === v.id)) return;
    setLines((x) => [...x, { productId: p.id, skuId: v.id, title: p.title, label: variantLabel(v.options), price: v.price, salePrice: String(Math.round(v.price * 0.8)), quota: '50' }]);
  };
  const create = useMutation({
    mutationFn: () => api.post('/promotion/admin/flash-sales', {
      name: name.trim(),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      items: lines.map((l) => ({ productId: l.productId, skuId: l.skuId, salePrice: Number(l.salePrice), quota: Number(l.quota) })),
    }),
    onSuccess: () => {
      toast.success('Đã tạo flash sale');
      setOpen(false); setLines([]); setName(''); setFound(null); setLookup('');
      void qc.invalidateQueries({ queryKey: ['admin-flash'] });
    },
  });
  const valid = name.trim().length >= 3 && lines.length > 0 && new Date(endsAt) > new Date(startsAt)
    && lines.every((l) => Number(l.salePrice) >= 1000 && Number(l.salePrice) < l.price && Number(l.quota) > 0);

  return (
    <div>
      <PageTitle actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" /> Tạo flash sale</Button>}>Flash sale</PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.length} empty={<EmptyState icon={<Zap className="size-6" />} title="Chưa có chương trình flash sale" />}>
        {(list) => (
          <DataTable rows={list} rowKey={(s) => s.id} columns={[
            { key: 'name', header: 'Chương trình', primary: true, cell: (s) => s.name ?? s.title ?? 'Flash sale' },
            { key: 'state', header: 'Trạng thái', badge: true, cell: (s) => { const st = saleState(s); return <Badge tone={st.tone}>{st.label}</Badge>; } },
            { key: 'time', header: 'Thời gian', cell: (s) => <span className="text-xs">{formatDate(s.startsAt)} → {formatDate(s.endsAt)}</span> },
            { key: 'items', header: 'Số SKU', align: 'right', cell: (s) => asArray(s.items).length },
            { key: 'sold', header: 'Đã bán', align: 'right', cell: (s) => asArray<{ sold?: number }>(s.items).reduce((n, i) => n + (i.sold ?? 0), 0) },
          ]} />
        )}
      </QueryView>

      <Sheet open={open} onClose={() => setOpen(false)} wide title="Tạo flash sale" footer={(
        <><Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button><Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>Tạo ({lines.length} SKU)</Button></>
      )}>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Tên chương trình" className="sm:col-span-3"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Flash sale 12h trưa" /></Field>
            <Field label="Bắt đầu"><Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></Field>
            <Field label="Kết thúc" error={new Date(endsAt) <= new Date(startsAt) ? 'Phải sau giờ bắt đầu' : null}><Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></Field>
          </div>
          <Card className="p-3">
            <p className="mb-2 text-sm font-medium">Thêm sản phẩm</p>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void find(); }}>
              <Input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="ID hoặc slug sản phẩm" aria-label="ID hoặc slug" />
              <Button type="submit" variant="outline" className="shrink-0" loading={looking}><Search className="size-4" /> Tìm</Button>
            </form>
            {found && (
              <div className="mt-3">
                <p className="mb-1 truncate text-sm font-medium">{found.title}</p>
                <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                  {found.variants.filter((v) => v.status !== 'INACTIVE').map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="min-w-0 truncate">{variantLabel(v.options) || 'Mặc định'} · {formatVND(v.price)}</span>
                      <Button size="sm" variant="secondary" disabled={lines.some((l) => l.skuId === v.id)} onClick={() => addVariant(found, v)}>Thêm</Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          {lines.length > 0 && (
            <ul className="space-y-2">
              {lines.map((l, i) => (
                <li key={l.skuId} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-sm"><span className="line-clamp-1">{l.title}</span><span className="text-xs text-muted">{l.label || 'Mặc định'} · Giá gốc {formatVND(l.price)}</span></p>
                    <Button variant="ghost" size="icon" aria-label="Bỏ SKU" onClick={() => setLines((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={<span className="text-xs text-muted">Giá flash sale</span>} error={Number(l.salePrice) >= l.price ? 'Phải thấp hơn giá gốc' : null}>
                      <Input inputMode="numeric" value={l.salePrice} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, salePrice: e.target.value.replace(/\D/g, '') } : y)))} />
                    </Field>
                    <Field label={<span className="text-xs text-muted">Số suất</span>}>
                      <Input inputMode="numeric" value={l.quota} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, quota: e.target.value.replace(/\D/g, '') } : y)))} />
                    </Field>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
    </div>
  );
}
