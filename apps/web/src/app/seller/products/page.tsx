'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, Package, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmSheet, EmptyState, Img, LinkButton, PageTitle, Pagination, QueryView, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { PRODUCT_STATUS, asArray, formatNumber, formatVND, pick, statusOf, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { ProductSnapshot } from '@/lib/types';

const TABS = [
  { value: '', label: 'Tất cả' },
  { value: 'APPROVED', label: 'Đang bán' },
  { value: 'PENDING', label: 'Chờ duyệt' },
  { value: 'DRAFT', label: 'Nháp' },
  { value: 'REJECTED', label: 'Bị từ chối' },
  { value: 'HIDDEN', label: 'Đã ẩn' },
];

export default function SellerProductsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [del, setDel] = useState<ProductSnapshot | null>(null);
  const pageSize = 20;
  const q = useQuery({
    queryKey: ['seller-products', status, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/catalog/seller/products', { status: status || undefined, page, pageSize });
      return { items: asArray<ProductSnapshot>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  const done = (m: string) => { toast.success(m); setDel(null); void qc.invalidateQueries({ queryKey: ['seller-products'] }); };
  const submit = useMutation({ mutationFn: (id: string) => api.post(`/catalog/seller/products/${id}/submit`), onSuccess: () => done('Đã gửi duyệt') });
  const hide = useMutation({ mutationFn: (id: string) => api.post(`/catalog/seller/products/${id}/hide`), onSuccess: () => done('Đã ẩn sản phẩm') });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/catalog/seller/products/${id}`), onSuccess: () => done('Đã xoá sản phẩm') });

  return (
    <div>
      <PageTitle actions={<LinkButton href="/seller/products/new"><Plus className="size-4" /> Thêm sản phẩm</LinkButton>}>Sản phẩm</PageTitle>
      <Tabs className="mb-3" value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={TABS} />
      <QueryView q={q} isEmpty={(d) => !d.items.length}
        empty={<EmptyState icon={<Package className="size-6" />} title="Chưa có sản phẩm" action={<LinkButton href="/seller/products/new">Thêm sản phẩm đầu tiên</LinkButton>} />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              rowKey={(p) => p.id}
              columns={[
                {
                  key: 'title', header: 'Sản phẩm', primary: true,
                  cell: (p) => (
                    <Link href={`/seller/products/${p.id}`} className="flex min-w-0 items-center gap-3 md:min-w-64">
                      <Img src={p.images?.[0]} alt={p.title} className="w-12 shrink-0" />
                      <span className="min-w-0">
                        <span className="line-clamp-2 font-medium">{p.title}</span>
                        {p.status === 'REJECTED' && p.rejectReason && <span className="block truncate text-xs text-danger">Lý do: {p.rejectReason}</span>}
                      </span>
                    </Link>
                  ),
                },
                { key: 'status', header: 'Trạng thái', badge: true, cell: (p) => { const s = statusOf(PRODUCT_STATUS, p.status); return <Badge tone={s.tone}>{s.label}</Badge>; } },
                { key: 'price', header: 'Giá', align: 'right', cell: (p) => (p.maxPrice > p.minPrice ? `${formatVND(p.minPrice)} – ${formatVND(p.maxPrice)}` : formatVND(p.minPrice)) },
                { key: 'variants', header: 'Phân loại', align: 'right', cell: (p) => p.variants?.filter((v) => v.status !== 'INACTIVE').length ?? 0 },
                { key: 'sold', header: 'Đã bán', align: 'right', cell: (p) => formatNumber(p.soldCount) },
              ]}
              actions={(p) => (
                <>
                  <LinkButton href={`/seller/products/${p.id}`} variant="outline" size="sm"><Pencil className="size-4" /> Sửa</LinkButton>
                  {(p.status === 'DRAFT' || p.status === 'REJECTED' || p.status === 'HIDDEN') && (
                    <Button size="sm" variant="secondary" loading={submit.isPending && submit.variables === p.id} onClick={() => submit.mutate(p.id)}><Send className="size-4" /> Gửi duyệt</Button>
                  )}
                  {p.status === 'APPROVED' && (
                    <Button size="sm" variant="outline" loading={hide.isPending && hide.variables === p.id} onClick={() => hide.mutate(p.id)}><EyeOff className="size-4" /> Ẩn</Button>
                  )}
                  {(p.status === 'DRAFT' || p.status === 'REJECTED') && (
                    <Button size="sm" variant="ghost" className="text-danger" aria-label="Xoá" onClick={() => setDel(p)}><Trash2 className="size-4" /></Button>
                  )}
                </>
              )}
            />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>
      <ConfirmSheet open={!!del} onClose={() => setDel(null)} title="Xoá sản phẩm" danger confirmText="Xoá"
        message={<>Xoá “<span className="text-fg">{del?.title}</span>”? Không thể hoàn tác.</>} loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </div>
  );
}
