'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, EmptyState, Input, PageTitle, QueryView } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray, formatNumber, variantLabel } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { ProductSnapshot } from '@/lib/types';

interface StockRow { skuId: string; onHand: number; reserved: number; available: number; sku?: string; title?: string; label?: string }

function OnHandEditor({ row }: { row: StockRow }) {
  const qc = useQueryClient();
  const [v, setV] = useState(String(row.onHand));
  const dirty = v !== String(row.onHand);
  const m = useMutation({
    mutationFn: () => api.put(`/inventory/seller/stock/${row.skuId}`, { onHand: Number(v) }),
    onSuccess: () => { toast.success('Đã cập nhật tồn kho'); void qc.invalidateQueries({ queryKey: ['seller-stock'] }); },
  });
  return (
    <form className="flex items-center justify-end gap-2" onSubmit={(e) => { e.preventDefault(); if (dirty) m.mutate(); }}>
      <Input inputMode="numeric" aria-label="Tồn thực tế" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} className="w-24 text-right" />
      <Button type="submit" size="sm" variant={dirty ? 'primary' : 'outline'} disabled={!dirty || v === '' || Number(v) < row.reserved} loading={m.isPending}>Lưu</Button>
    </form>
  );
}

export default function InventoryPage() {
  const [term, setTerm] = useState('');
  const stock = useQuery({ queryKey: ['seller-stock'], queryFn: async () => asArray<StockRow>(await api.get('/inventory/seller/stock')) });
  const products = useQuery({
    queryKey: ['seller-products', 'all-for-stock'],
    queryFn: async () => asArray<ProductSnapshot>(await api.get('/catalog/seller/products', { pageSize: 100 })),
  });
  const skuMap = useMemo(() => {
    const m = new Map<string, { title: string; label: string; sku: string }>();
    for (const p of products.data ?? []) for (const v of p.variants ?? []) m.set(v.id, { title: p.title, label: variantLabel(v.options), sku: v.sku });
    return m;
  }, [products.data]);

  return (
    <div>
      <PageTitle>Tồn kho</PageTitle>
      <div className="mb-3 flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-3 md:max-w-sm">
        <Search className="size-4 shrink-0 text-muted" />
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Tìm theo tên hoặc SKU" aria-label="Tìm" className="h-full min-w-0 flex-1 bg-transparent outline-none" />
      </div>
      <QueryView q={stock} isEmpty={(d) => !d.length} empty={<EmptyState icon={<Boxes className="size-6" />} title="Chưa có SKU" description="SKU được tạo tự động khi bạn thêm sản phẩm." />}>
        {(rows) => {
          const t = term.trim().toLowerCase();
          const list = rows
            .map((r) => ({ ...r, ...skuMap.get(r.skuId), title: r.title ?? skuMap.get(r.skuId)?.title, sku: r.sku ?? skuMap.get(r.skuId)?.sku }))
            .filter((r) => !t || `${r.title ?? ''} ${r.sku ?? ''} ${r.skuId}`.toLowerCase().includes(t));
          return (
            <DataTable
              rows={list}
              rowKey={(r) => r.skuId}
              empty={<EmptyState title="Không có SKU phù hợp" />}
              columns={[
                {
                  key: 'name', header: 'Sản phẩm / SKU', primary: true,
                  cell: (r) => (
                    <span className="block min-w-0 md:min-w-56">
                      <span className="line-clamp-2">{r.title ?? 'SKU'}</span>
                      <span className="block truncate text-xs font-normal text-muted">{[r.label, r.sku ?? r.skuId].filter(Boolean).join(' · ')}</span>
                    </span>
                  ),
                },
                { key: 'state', header: 'Tình trạng', badge: true, cell: (r) => (r.available <= 0 ? <Badge tone="danger">Hết hàng</Badge> : r.available < 5 ? <Badge tone="warning">Sắp hết</Badge> : <Badge tone="success">Còn hàng</Badge>) },
                { key: 'reserved', header: 'Đang giữ', align: 'right', cell: (r) => formatNumber(r.reserved) },
                { key: 'available', header: 'Có thể bán', align: 'right', cell: (r) => formatNumber(r.available) },
                { key: 'onHand', header: 'Tồn thực tế', align: 'right', cell: (r) => <OnHandEditor key={`${r.skuId}-${r.onHand}`} row={r} /> },
              ]}
            />
          );
        }}
      </QueryView>
    </div>
  );
}
