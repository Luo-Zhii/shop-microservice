'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardList, Eye, X } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { formatAddress } from '@/components/shop/address-form';
import { OrderItems } from '@/components/shop/order-card';
import { Badge, Button, EmptyState, KV, PageTitle, Pagination, QueryView, ReasonSheet, Sheet, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { ORDER_STATUS, PAYMENT_METHOD, asArray, formatDate, formatVND, pick, statusOf, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { OrderSnapshot } from '@/lib/types';

const TABS = [
  { value: 'RETURN_REQUESTED', label: 'Yêu cầu trả hàng' },
  { value: '', label: 'Tất cả' },
  { value: 'AWAITING_PAYMENT', label: 'Chờ thanh toán' },
  { value: 'CONFIRMED', label: 'Chờ lấy hàng' },
  { value: 'SHIPPING', label: 'Đang giao' },
  { value: 'DELIVERED', label: 'Đã giao' },
  { value: 'COMPLETED', label: 'Hoàn thành' },
  { value: 'CANCELLED', label: 'Đã huỷ' },
  { value: 'RETURNED', label: 'Đã trả hàng' },
];

export default function AdminOrdersPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('RETURN_REQUESTED');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<OrderSnapshot | null>(null);
  const [rejecting, setRejecting] = useState<OrderSnapshot | null>(null);
  const pageSize = 20;
  const q = useQuery({
    queryKey: ['admin-orders', status, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/order/admin/orders', { status: status || undefined, page, pageSize });
      return { items: asArray<OrderSnapshot>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  const done = (m: string) => { toast.success(m); setView(null); setRejecting(null); void qc.invalidateQueries({ queryKey: ['admin-orders'] }); };
  const approve = useMutation({ mutationFn: (id: string) => api.post(`/order/admin/orders/${id}/return/approve`), onSuccess: () => done('Đã duyệt trả hàng — hoàn tiền cho người mua') });
  const reject = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/order/admin/orders/${v.id}/return/reject`, { note: v.reason }), onSuccess: () => done('Đã từ chối trả hàng') });

  const returnActions = (o: OrderSnapshot) => o.status === 'RETURN_REQUESTED' && (
    <>
      <Button size="sm" loading={approve.isPending && approve.variables === o.id} onClick={() => approve.mutate(o.id)}><Check className="size-4" /> Duyệt trả</Button>
      <Button size="sm" variant="outline" onClick={() => setRejecting(o)}><X className="size-4" /> Từ chối</Button>
    </>
  );

  return (
    <div>
      <PageTitle>Đơn hàng & trả hàng</PageTitle>
      <Tabs className="mb-3" value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={TABS} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<ClipboardList className="size-6" />} title="Không có đơn hàng" />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              rowKey={(o) => o.id}
              onRowClick={setView}
              columns={[
                { key: 'id', header: 'Mã đơn', primary: true, cell: (o) => <span className="font-mono text-sm">#{o.id.slice(-8).toUpperCase()}</span> },
                { key: 'status', header: 'Trạng thái', badge: true, cell: (o) => { const s = statusOf(ORDER_STATUS, o.status); return <Badge tone={s.tone}>{s.label}</Badge>; } },
                { key: 'shop', header: 'Shop', cell: (o) => o.shopName ?? o.shopId.slice(-8) },
                { key: 'reason', header: 'Lý do', cell: (o) => <span className="line-clamp-1 max-w-56">{o.returnReason ?? o.cancelReason ?? o.reason ?? '—'}</span> },
                { key: 'total', header: 'Tổng', align: 'right', cell: (o) => formatVND(o.total) },
                { key: 'created', header: 'Ngày đặt', hideOnMobile: true, cell: (o) => formatDate(o.createdAt) },
              ]}
              actions={(o) => (
                <>
                  <Button size="sm" variant="outline" onClick={() => setView(o)}><Eye className="size-4" /> Xem</Button>
                  {returnActions(o)}
                </>
              )}
            />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>
      <Sheet open={!!view} onClose={() => setView(null)} wide title={view ? `Đơn #${view.id.slice(-8).toUpperCase()}` : ''} footer={view && returnActions(view)}>
        {view && (
          <div className="space-y-3">
            <KV label="Trạng thái"><Badge tone={statusOf(ORDER_STATUS, view.status).tone}>{statusOf(ORDER_STATUS, view.status).label}</Badge></KV>
            <KV label="Người mua"><span className="font-mono text-xs">{view.buyerId}</span></KV>
            <KV label="Thanh toán">{PAYMENT_METHOD[view.paymentMethod] ?? view.paymentMethod}</KV>
            {(view.returnReason || view.cancelReason) && <KV label="Lý do">{view.returnReason ?? view.cancelReason}</KV>}
            <p className="break-words rounded-lg bg-surface-2 p-3 text-sm">{view.shippingAddress?.fullName} · {view.shippingAddress?.phone}<br />{formatAddress(view.shippingAddress)}</p>
            <OrderItems order={view} />
            <KV label="Tổng tiền"><span className="font-semibold text-primary">{formatVND(view.total)}</span></KV>
          </div>
        )}
      </Sheet>
      <ReasonSheet open={!!rejecting} onClose={() => setRejecting(null)} title="Từ chối yêu cầu trả hàng" confirmText="Từ chối" danger
        loading={reject.isPending} onConfirm={(reason) => rejecting && reject.mutate({ id: rejecting.id, reason })} />
    </div>
  );
}
