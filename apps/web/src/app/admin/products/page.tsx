'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, EyeOff, Package, X } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, EmptyState, Img, KV, PageTitle, Pagination, QueryView, ReasonSheet, Sheet, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { PRODUCT_STATUS, asArray, formatDate, formatVND, pick, statusOf, totalPages, variantLabel } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { ProductSnapshot } from '@/lib/types';

const TABS = [
  { value: 'PENDING', label: 'Chờ duyệt' },
  { value: 'APPROVED', label: 'Đang bán' },
  { value: 'REJECTED', label: 'Bị từ chối' },
  { value: 'HIDDEN', label: 'Đã ẩn' },
];

export default function AdminProductsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<ProductSnapshot | null>(null);
  const [reason, setReason] = useState<{ p: ProductSnapshot; action: 'reject' | 'hide' } | null>(null);
  const pageSize = 20;
  const q = useQuery({
    queryKey: ['admin-products', status, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/catalog/admin/products', { status, page, pageSize });
      return { items: asArray<ProductSnapshot>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  const done = (m: string) => { toast.success(m); setView(null); setReason(null); void qc.invalidateQueries({ queryKey: ['admin-products'] }); };
  const approve = useMutation({ mutationFn: (id: string) => api.post(`/catalog/admin/products/${id}/approve`), onSuccess: () => done('Đã duyệt sản phẩm') });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'reject' | 'hide'; reason: string }) => api.post(`/catalog/admin/products/${v.id}/${v.action}`, { reason: v.reason }),
    onSuccess: (_d, v) => done(v.action === 'reject' ? 'Đã từ chối sản phẩm' : 'Đã ẩn sản phẩm'),
  });

  const actions = (p: ProductSnapshot) => (
    <>
      {p.status !== 'APPROVED' && <Button size="sm" loading={approve.isPending && approve.variables === p.id} onClick={() => approve.mutate(p.id)}><Check className="size-4" /> Duyệt</Button>}
      {p.status === 'PENDING' && <Button size="sm" variant="outline" onClick={() => setReason({ p, action: 'reject' })}><X className="size-4" /> Từ chối</Button>}
      {p.status === 'APPROVED' && <Button size="sm" variant="outline" onClick={() => setReason({ p, action: 'hide' })}><EyeOff className="size-4" /> Ẩn</Button>}
    </>
  );

  return (
    <div>
      <PageTitle>Duyệt sản phẩm</PageTitle>
      <Tabs className="mb-3" value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={TABS} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<Package className="size-6" />} title="Không có sản phẩm" />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              rowKey={(p) => p.id}
              onRowClick={setView}
              columns={[
                {
                  key: 'title', header: 'Sản phẩm', primary: true,
                  cell: (p) => (
                    <span className="flex min-w-0 items-center gap-3 md:min-w-64">
                      <Img src={p.images?.[0]} alt={p.title} className="w-12 shrink-0" />
                      <span className="line-clamp-2 min-w-0">{p.title}</span>
                    </span>
                  ),
                },
                { key: 'status', header: 'Trạng thái', badge: true, cell: (p) => { const s = statusOf(PRODUCT_STATUS, p.status); return <Badge tone={s.tone}>{s.label}</Badge>; } },
                { key: 'shop', header: 'Shop', cell: (p) => p.shopName || '—' },
                { key: 'price', header: 'Giá', align: 'right', cell: (p) => formatVND(p.minPrice) },
                { key: 'updated', header: 'Cập nhật', hideOnMobile: true, cell: (p) => formatDate(p.updatedAt) },
              ]}
              actions={actions}
            />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>

      <Sheet open={!!view} onClose={() => setView(null)} wide title="Chi tiết sản phẩm" footer={view && actions(view)}>
        {view && (
          <div className="space-y-4">
            <div>
              <h3 className="break-words text-lg font-semibold">{view.title}</h3>
              <p className="text-sm text-muted">{view.shopName} · {view.categoryPath?.join(' / ')}</p>
            </div>
            {view.images?.length ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{view.images.map((src) => <a key={src} href={src} target="_blank" rel="noreferrer"><Img src={src} alt="" /></a>)}</div>
            ) : <p className="text-sm text-warning">Sản phẩm không có ảnh.</p>}
            <div className="space-y-1.5">
              {view.brand && <KV label="Thương hiệu">{view.brand}</KV>}
              {Object.entries(view.attributes ?? {}).map(([k, v]) => <KV key={k} label={k}>{v}</KV>)}
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">Phân loại ({view.variants?.length ?? 0})</p>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {view.variants?.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0"><span className="block truncate">{variantLabel(v.options) || 'Mặc định'}</span><span className="text-xs text-muted">{v.sku} · {v.weightGrams}g</span></span>
                    <span className="shrink-0 text-right">{formatVND(v.price)}{v.status === 'INACTIVE' && <Badge className="ml-2">Ngừng</Badge>}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">Mô tả</p>
              <p className="max-h-64 overflow-y-auto whitespace-pre-line break-words rounded-lg bg-surface-2 p-3 text-sm">{view.description || '—'}</p>
            </div>
          </div>
        )}
      </Sheet>

      <ReasonSheet open={!!reason} onClose={() => setReason(null)} title={reason?.action === 'reject' ? 'Từ chối sản phẩm' : 'Ẩn sản phẩm'}
        confirmText={reason?.action === 'reject' ? 'Từ chối' : 'Ẩn'} danger
        presets={['Ảnh sản phẩm không rõ ràng', 'Mô tả sai lệch hoặc thiếu', 'Hàng cấm / vi phạm chính sách', 'Giá không hợp lý', 'Sai danh mục']}
        loading={act.isPending} onConfirm={(r) => reason && act.mutate({ id: reason.p.id, action: reason.action, reason: r })} />
    </div>
  );
}
