'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmSheet, EmptyState, PageTitle, Pagination, QueryView, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray, formatDate, formatVND, pick, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';

interface Payout { id: string; shopId: string; shopName?: string; amount: number; status: string; bankAccount?: string; createdAt: string; paidAt?: string | null }

export default function AdminPayoutsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('REQUESTED');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<Payout | null>(null);
  const pageSize = 20;
  const q = useQuery({
    queryKey: ['admin-payouts', status, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/payment/admin/payouts', { status: status || undefined, page, pageSize });
      return { items: asArray<Payout>(r), total: pick<number>(r, 'total') ?? asArray(r).length };
    },
  });
  const paid = useMutation({
    mutationFn: (id: string) => api.post(`/payment/admin/payouts/${id}/paid`),
    onSuccess: () => { toast.success('Đã đánh dấu đã chuyển tiền'); setTarget(null); void qc.invalidateQueries({ queryKey: ['admin-payouts'] }); },
  });
  return (
    <div>
      <PageTitle>Yêu cầu rút tiền</PageTitle>
      <Tabs className="mb-3" value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[{ value: 'REQUESTED', label: 'Chờ chuyển' }, { value: 'PAID', label: 'Đã chuyển' }, { value: '', label: 'Tất cả' }]} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<Wallet className="size-6" />} title="Không có yêu cầu" />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              rowKey={(p) => p.id}
              columns={[
                { key: 'shop', header: 'Shop', primary: true, cell: (p) => p.shopName ?? <span className="font-mono text-xs">{p.shopId}</span> },
                { key: 'status', header: 'Trạng thái', badge: true, cell: (p) => (p.status === 'PAID' ? <Badge tone="success">Đã chuyển</Badge> : <Badge tone="warning">Chờ chuyển</Badge>) },
                { key: 'amount', header: 'Số tiền', align: 'right', cell: (p) => <span className="font-semibold">{formatVND(p.amount)}</span> },
                { key: 'bank', header: 'Tài khoản nhận', cell: (p) => <span className="select-all break-all">{p.bankAccount ?? '—'}</span> },
                { key: 'created', header: 'Ngày yêu cầu', cell: (p) => formatDate(p.createdAt) },
              ]}
              actions={(p) => p.status !== 'PAID' && <Button size="sm" onClick={() => setTarget(p)}><CheckCircle2 className="size-4" /> Đã trả</Button>}
            />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>
      <ConfirmSheet open={!!target} onClose={() => setTarget(null)} title="Xác nhận đã chuyển tiền" confirmText="Đã chuyển"
        message={target && <>Xác nhận đã chuyển <span className="font-semibold text-fg">{formatVND(target.amount)}</span> cho {target.shopName ?? target.shopId}?</>}
        loading={paid.isPending} onConfirm={() => target && paid.mutate(target.id)} />
    </div>
  );
}
