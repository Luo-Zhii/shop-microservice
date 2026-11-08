'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pause, Store, X } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, EmptyState, PageTitle, Pagination, QueryView, ReasonSheet, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { SHOP_STATUS, asArray, formatDate, pick, statusOf, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { Shop } from '@/lib/types';

const TABS = [
  { value: 'PENDING', label: 'Chờ duyệt' },
  { value: 'APPROVED', label: 'Đang hoạt động' },
  { value: 'REJECTED', label: 'Bị từ chối' },
  { value: 'SUSPENDED', label: 'Tạm khoá' },
];

export default function AdminShopsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [rejecting, setRejecting] = useState<Shop | null>(null);
  const pageSize = 20;
  const q = useQuery({
    queryKey: ['admin-shops', status, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/seller/admin/shops', { status, page, pageSize });
      return { items: asArray<Shop>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  const done = (m: string) => { toast.success(m); setRejecting(null); void qc.invalidateQueries({ queryKey: ['admin-shops'] }); };
  const approve = useMutation({ mutationFn: (id: string) => api.post(`/seller/admin/shops/${id}/approve`), onSuccess: () => done('Đã duyệt shop') });
  const reject = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/seller/admin/shops/${v.id}/reject`, { reason: v.reason }), onSuccess: () => done('Đã từ chối shop') });
  const suspend = useMutation({ mutationFn: (id: string) => api.post(`/seller/admin/shops/${id}/suspend`), onSuccess: () => done('Đã tạm khoá shop') });

  return (
    <div>
      <PageTitle>Duyệt shop</PageTitle>
      <Tabs className="mb-3" value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={TABS} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<Store className="size-6" />} title="Không có shop nào" />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              rowKey={(s) => s.id}
              columns={[
                { key: 'name', header: 'Shop', primary: true, cell: (s) => <span><span className="font-medium">{s.name}</span><span className="block text-xs font-normal text-muted">/{s.slug}</span></span> },
                { key: 'status', header: 'Trạng thái', badge: true, cell: (s) => { const st = statusOf(SHOP_STATUS, s.status); return <Badge tone={st.tone}>{st.label}</Badge>; } },
                { key: 'province', header: 'Kho lấy hàng', cell: (s) => s.pickupProvince ?? '—' },
                { key: 'phone', header: 'Điện thoại', cell: (s) => s.phone ?? '—' },
                { key: 'desc', header: 'Giới thiệu', cell: (s) => <span className="line-clamp-2 max-w-72">{s.description ?? '—'}</span> },
                { key: 'created', header: 'Ngày nộp', cell: (s) => formatDate(s.submittedAt ?? s.createdAt) },
              ]}
              actions={(s) => (
                <>
                  {(s.status === 'PENDING' || s.status === 'SUSPENDED') && (
                    <Button size="sm" loading={approve.isPending && approve.variables === s.id} onClick={() => approve.mutate(s.id)}><Check className="size-4" /> Duyệt</Button>
                  )}
                  {s.status === 'PENDING' && <Button size="sm" variant="outline" onClick={() => setRejecting(s)}><X className="size-4" /> Từ chối</Button>}
                  {s.status === 'APPROVED' && (
                    <Button size="sm" variant="outline" className="text-danger" loading={suspend.isPending && suspend.variables === s.id} onClick={() => suspend.mutate(s.id)}><Pause className="size-4" /> Tạm khoá</Button>
                  )}
                </>
              )}
            />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>
      <ReasonSheet open={!!rejecting} onClose={() => setRejecting(null)} title={`Từ chối shop “${rejecting?.name ?? ''}”`} confirmText="Từ chối" danger
        presets={['Thông tin shop chưa đầy đủ', 'Tên shop vi phạm chính sách', 'Không xác minh được người bán']}
        loading={reject.isPending} onConfirm={(reason) => rejecting && reject.mutate({ id: rejecting.id, reason })} />
    </div>
  );
}
