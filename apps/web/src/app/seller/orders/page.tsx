'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Eye, Truck } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { DataTable } from '@/components/data-table';
import { formatAddress } from '@/components/shop/address-form';
import { OrderItems } from '@/components/shop/order-card';
import { Badge, Button, EmptyState, KV, LoadingBlock, PageTitle, Pagination, QueryView, ReasonSheet, Sheet, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { ORDER_STATUS, PAYMENT_METHOD, SHIPMENT_STATUS, asArray, formatDate, formatVND, pick, statusOf, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { OrderSnapshot, Shipment } from '@/lib/types';

const TABS = [
  { value: '', label: 'Tất cả' },
  { value: 'AWAITING_PAYMENT', label: 'Chờ thanh toán' },
  { value: 'CONFIRMED', label: 'Chờ lấy hàng' },
  { value: 'SHIPPING', label: 'Đang giao' },
  { value: 'DELIVERED', label: 'Đã giao' },
  { value: 'COMPLETED', label: 'Hoàn thành' },
  { value: 'RETURN_REQUESTED', label: 'Trả hàng' },
  { value: 'CANCELLED', label: 'Đã huỷ' },
];

function useOrderActions(onDone: () => void) {
  const qc = useQueryClient();
  const done = (m: string) => { toast.success(m); onDone(); void qc.invalidateQueries({ queryKey: ['seller-orders'] }); void qc.invalidateQueries({ queryKey: ['seller-shipment'] }); };
  const pick_ = useMutation({
    mutationFn: async (o: OrderSnapshot) => {
      // order đã lưu shipmentId khi shipping tạo vận đơn; chưa có thì tra theo đơn
      const id = o.shipmentId ?? (await api.get<Shipment>(`/shipping/shipments/by-order/${o.id}`, undefined, { silent: false })).id;
      return api.post(`/shipping/seller/shipments/${id}/pick`);
    },
    onSuccess: () => done('Đã bàn giao cho đơn vị vận chuyển'),
  });
  const approveReturn = useMutation({ mutationFn: (id: string) => api.post(`/order/seller/orders/${id}/return/approve`), onSuccess: () => done('Đã chấp nhận trả hàng') });
  const rejectReturn = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/order/seller/orders/${v.id}/return/reject`, { note: v.reason }), onSuccess: () => done('Đã từ chối trả hàng') });
  return { pick: pick_, approveReturn, rejectReturn };
}

function OrderSheet({ order, onClose }: { order: OrderSnapshot | null; onClose: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const a = useOrderActions(onClose);
  const ship = useQuery({
    queryKey: ['seller-shipment', order?.id],
    enabled: !!order && ['CONFIRMED', 'SHIPPING', 'DELIVERED', 'COMPLETED', 'RETURN_REQUESTED'].includes(order.status),
    queryFn: () => api.get<Shipment>(`/shipping/shipments/by-order/${order!.id}`),
  });
  if (!order) return null;
  const st = statusOf(ORDER_STATUS, order.status);
  return (
    <>
      <Sheet open={!!order} onClose={onClose} wide title={`Đơn #${order.id.slice(-8).toUpperCase()}`} footer={(
        <>
          {order.status === 'CONFIRMED' && <Button loading={a.pick.isPending} onClick={() => a.pick.mutate(order)}><Truck className="size-4" /> Giao cho vận chuyển</Button>}
          {order.status === 'RETURN_REQUESTED' && (
            <>
              <Button variant="outline" onClick={() => setRejecting(true)}>Từ chối trả hàng</Button>
              <Button loading={a.approveReturn.isPending} onClick={() => a.approveReturn.mutate(order.id)}>Chấp nhận trả hàng</Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>Đóng</Button>
        </>
      )}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <KV label="Trạng thái"><Badge tone={st.tone}>{st.label}</Badge></KV>
            <KV label="Đặt lúc">{formatDate(order.createdAt)}</KV>
            <KV label="Thanh toán">{PAYMENT_METHOD[order.paymentMethod] ?? order.paymentMethod}</KV>
            {(order.cancelReason ?? order.reason) && <KV label="Lý do huỷ">{order.cancelReason ?? order.reason}</KV>}
            {order.returnReason && <KV label="Lý do trả hàng">{order.returnReason}</KV>}
          </div>
          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            <p className="font-medium">{order.shippingAddress?.fullName} · {order.shippingAddress?.phone}</p>
            <p className="break-words text-muted">{formatAddress(order.shippingAddress)}</p>
          </div>
          {ship.data && (
            <div className="space-y-1.5">
              <KV label="Vận chuyển">{ship.data.carrier ?? '—'}</KV>
              <KV label="Mã vận đơn"><span className="select-all font-mono">{ship.data.trackingCode ?? '—'}</span></KV>
              <KV label="Trạng thái giao">{SHIPMENT_STATUS[ship.data.status] ?? ship.data.status}</KV>
            </div>
          )}
          <OrderItems order={order} />
          <div className="space-y-1.5 border-t border-border pt-3">
            <KV label="Tiền hàng">{formatVND(order.subtotal)}</KV>
            <KV label="Phí vận chuyển">{formatVND(order.shippingFee)}</KV>
            {order.discount > 0 && <KV label="Giảm giá">-{formatVND(order.discount)}</KV>}
            <KV label="Tổng"><span className="font-semibold text-primary">{formatVND(order.total)}</span></KV>
          </div>
        </div>
      </Sheet>
      <ReasonSheet open={rejecting} onClose={() => setRejecting(false)} title="Từ chối trả hàng" confirmText="Từ chối" danger
        loading={a.rejectReturn.isPending} onConfirm={(reason) => { a.rejectReturn.mutate({ id: order.id, reason }); setRejecting(false); }} />
    </>
  );
}

function SellerOrdersView() {
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<OrderSnapshot | null>(null);
  const pageSize = 20;
  const actions = useOrderActions(() => undefined);
  const q = useQuery({
    queryKey: ['seller-orders', status, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/order/seller/orders', { status: status || undefined, page, pageSize });
      return { items: asArray<OrderSnapshot>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  return (
    <div>
      <PageTitle>Đơn hàng</PageTitle>
      <Tabs className="mb-3" value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={TABS} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<ClipboardList className="size-6" />} title="Không có đơn hàng" />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              rowKey={(o) => o.id}
              onRowClick={setOpen}
              columns={[
                { key: 'id', header: 'Mã đơn', primary: true, cell: (o) => <span className="font-mono text-sm">#{o.id.slice(-8).toUpperCase()}</span> },
                { key: 'status', header: 'Trạng thái', badge: true, cell: (o) => { const s = statusOf(ORDER_STATUS, o.status); return <Badge tone={s.tone}>{s.label}</Badge>; } },
                { key: 'items', header: 'Sản phẩm', cell: (o) => <span className="line-clamp-1 max-w-64">{o.items[0]?.title}{o.items.length > 1 ? ` +${o.items.length - 1}` : ''}</span> },
                { key: 'buyer', header: 'Người nhận', cell: (o) => o.shippingAddress?.fullName ?? '—' },
                { key: 'total', header: 'Tổng', align: 'right', cell: (o) => <span className="font-medium">{formatVND(o.total)}</span> },
                { key: 'created', header: 'Ngày đặt', hideOnMobile: true, cell: (o) => formatDate(o.createdAt) },
              ]}
              actions={(o) => (
                <>
                  <Button size="sm" variant="outline" onClick={() => setOpen(o)}><Eye className="size-4" /> Xem</Button>
                  {o.status === 'CONFIRMED' && (
                    <Button size="sm" loading={actions.pick.isPending && actions.pick.variables?.id === o.id} onClick={() => actions.pick.mutate(o)}><Truck className="size-4" /> Giao vận chuyển</Button>
                  )}
                </>
              )}
            />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>
      <OrderSheet order={open} onClose={() => setOpen(null)} />
    </div>
  );
}

export default function SellerOrdersPage() {
  return <Suspense fallback={<LoadingBlock />}><SellerOrdersView /></Suspense>;
}
