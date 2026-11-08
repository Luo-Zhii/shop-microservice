'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Package, Star, Store, Truck } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatAddress } from '@/components/shop/address-form';
import {
  Badge, Button, Card, ConfirmSheet, Field, Img, KV, LoadingBlock, PageTitle, QueryView, ReasonSheet, Sheet, StarInput, Textarea, cn,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { ORDER_STATUS, PAYMENT_METHOD, SHIPMENT_STATUS, formatDate, formatVND, statusOf } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { CheckoutStatus, OrderItemSnapshot, OrderSnapshot, Shipment } from '@/lib/types';

const FLOW = ['PENDING', 'CONFIRMED', 'SHIPPING', 'DELIVERED', 'COMPLETED'] as const;
const FLOW_LABEL: Record<(typeof FLOW)[number], string> = {
  PENDING: 'Đặt hàng', CONFIRMED: 'Đã xác nhận', SHIPPING: 'Đang giao', DELIVERED: 'Đã giao', COMPLETED: 'Hoàn thành',
};

function ReviewSheet({ order, item, onClose }: { order: OrderSnapshot; item: OrderItemSnapshot | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [rating, setRating] = useState(5);
  const [content, setContent] = useState('');
  const [images, setImages] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/review/reviews', {
      orderId: order.id,
      productId: item!.productId,
      rating,
      content: content.trim(),
      images: images.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s)).slice(0, 5),
    }),
    onSuccess: () => {
      toast.success('Cảm ơn bạn đã đánh giá!');
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
      onClose();
    },
  });
  return (
    <Sheet open={!!item} onClose={onClose} title="Đánh giá sản phẩm" footer={(
      <><Button variant="outline" onClick={onClose}>Đóng</Button><Button loading={m.isPending} disabled={content.trim().length < 5} onClick={() => m.mutate()}>Gửi đánh giá</Button></>
    )}>
      {item && (
        <div className="space-y-4">
          <div className="flex gap-3"><Img src={item.image} alt={item.title} className="w-14 shrink-0" /><p className="line-clamp-2 text-sm">{item.title}</p></div>
          <StarInput value={rating} onChange={setRating} />
          <Field label="Nhận xét" hint="Tối thiểu 5 ký tự">
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} placeholder="Chất lượng, đóng gói, giao hàng…" />
          </Field>
          <Field label="Ảnh thực tế (tuỳ chọn)" hint="Dán tối đa 5 đường dẫn ảnh, cách nhau bởi dấu phẩy hoặc xuống dòng">
            <Textarea value={images} onChange={(e) => setImages(e.target.value)} rows={2} placeholder="https://…" />
          </Field>
        </div>
      )}
    </Sheet>
  );
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { ready } = useRequireAuth();
  const qc = useQueryClient();
  const [sheet, setSheet] = useState<'cancel' | 'return' | 'received' | null>(null);
  const [reviewItem, setReviewItem] = useState<OrderItemSnapshot | null>(null);

  const q = useQuery({ queryKey: ['order', id], enabled: ready, queryFn: () => api.get<OrderSnapshot>(`/order/orders/${id}`) });
  const ship = useQuery({
    queryKey: ['shipment', id],
    enabled: ready && !!q.data && ['CONFIRMED', 'SHIPPING', 'DELIVERED', 'COMPLETED', 'RETURN_REQUESTED', 'RETURNED'].includes(q.data.status),
    queryFn: () => api.get<Shipment>(`/shipping/shipments/by-order/${id}`),
  });

  const after = (msg: string) => () => {
    toast.success(msg);
    setSheet(null);
    void qc.invalidateQueries({ queryKey: ['order', id] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };
  const cancel = useMutation({ mutationFn: (reason: string) => api.post(`/order/orders/${id}/cancel`, { reason }), onSuccess: after('Đã huỷ đơn hàng') });
  const received = useMutation({ mutationFn: () => api.post(`/order/orders/${id}/confirm-received`), onSuccess: after('Đã xác nhận nhận hàng') });
  const ret = useMutation({ mutationFn: (reason: string) => api.post(`/order/orders/${id}/return`, { reason }), onSuccess: after('Đã gửi yêu cầu trả hàng') });
  const repay = useMutation({
    mutationFn: async (checkoutId: string) => {
      const st = await api.get<CheckoutStatus>(`/order/checkouts/${checkoutId}`, undefined, { silent: false });
      if (st.redirectUrl) window.location.href = st.redirectUrl;
      else toast.error('Không còn liên kết thanh toán cho đơn này');
    },
  });

  if (!ready) return <LoadingBlock />;
  return (
    <div>
      <PageTitle back="/orders">Chi tiết đơn hàng</PageTitle>
      <QueryView q={q}>
        {(o) => {
          const st = statusOf(ORDER_STATUS, o.status);
          const flowIdx = FLOW.indexOf((o.status === 'AWAITING_PAYMENT' ? 'PENDING' : o.status) as (typeof FLOW)[number]);
          const events = ship.data?.events ?? ship.data?.history ?? [];
          const timeline = o.timeline ?? [];
          return (
            <div className="space-y-3 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 lg:space-y-0">
              <div className="space-y-3">
                <Card className="p-3 md:p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-all text-sm text-muted">Mã đơn: <span className="font-mono text-fg">{o.id}</span></p>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </div>
                  {o.status === 'CANCELLED' || o.status.startsWith('RETURN') ? (
                    <p className="rounded-lg bg-surface-2 p-3 text-sm">{o.status === 'CANCELLED' ? 'Đơn đã huỷ' : st.label}{(o.cancelReason ?? o.returnReason ?? o.reason) ? ` · Lý do: ${o.cancelReason ?? o.returnReason ?? o.reason}` : ''}</p>
                  ) : (
                    <ol className="grid grid-cols-5 gap-1">
                      {FLOW.map((s, i) => (
                        <li key={s} className="flex flex-col items-center gap-1 text-center">
                          <span className={cn('grid size-8 place-items-center rounded-full text-xs font-semibold', i <= flowIdx ? 'bg-success text-white' : 'bg-surface-2 text-muted')}>{i + 1}</span>
                          <span className={cn('text-[11px] leading-tight sm:text-xs', i <= flowIdx ? 'text-fg' : 'text-muted')}>{FLOW_LABEL[s]}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>

                {timeline.length > 0 && (
                  <Card className="p-3 md:p-4">
                    <h2 className="mb-2 font-semibold">Lịch sử đơn hàng</h2>
                    <ol className="relative ml-2 space-y-3 border-l border-border pl-4">
                      {[...timeline].reverse().map((e, i) => (
                        <li key={`${e.at}-${i}`} className="relative">
                          <span className={cn('absolute -left-[21px] top-1 size-2.5 rounded-full', i === 0 ? 'bg-primary ring-4 ring-primary-soft' : 'bg-border')} />
                          <p className={cn('text-sm', i === 0 && 'font-medium')}>{statusOf(ORDER_STATUS, e.status).label}{e.note ? ` · ${e.note}` : ''}</p>
                          <p className="text-xs text-muted">{formatDate(e.at)}</p>
                        </li>
                      ))}
                    </ol>
                  </Card>
                )}

                {ship.data && (
                  <Card className="p-3 md:p-4">
                    <h2 className="mb-2 flex items-center gap-2 font-semibold"><Truck className="size-5 text-primary" /> Vận chuyển</h2>
                    <div className="mb-3 space-y-1">
                      <KV label="Đơn vị">{ship.data.carrier ?? '—'}</KV>
                      <KV label="Mã vận đơn"><span className="select-all font-mono">{ship.data.trackingCode ?? '—'}</span></KV>
                      <KV label="Trạng thái">{SHIPMENT_STATUS[ship.data.status] ?? ship.data.status}</KV>
                    </div>
                    {events.length > 0 && (
                      <ol className="relative ml-2 space-y-3 border-l border-border pl-4">
                        {[...events].reverse().map((e, i) => (
                          <li key={`${e.at}-${i}`} className="relative">
                            <span className={cn('absolute -left-[21px] top-1 size-2.5 rounded-full', i === 0 ? 'bg-success ring-4 ring-success-soft' : 'bg-border')} />
                            <p className={cn('text-sm', i === 0 ? 'font-medium text-success' : '')}>{SHIPMENT_STATUS[e.status as Shipment['status']] ?? e.status}{e.note ? ` · ${e.note}` : ''}</p>
                            <p className="text-xs text-muted">{formatDate(e.at)}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Card>
                )}

                <Card className="p-3 md:p-4">
                  <h2 className="mb-1 flex items-center gap-2 font-semibold"><Store className="size-5 text-primary" /> {o.shopName ?? 'Sản phẩm'}</h2>
                  <ul className="divide-y divide-border">
                    {o.items.map((it) => (
                      <li key={it.skuId} className="flex gap-3 py-3">
                        <Img src={it.image} alt={it.title} className="w-16 shrink-0" />
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="line-clamp-2">{it.title}</p>
                          {it.variantLabel && <p className="truncate text-xs text-muted">{it.variantLabel}</p>}
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-muted">{formatVND(it.unitPrice)} × {it.qty}</span>
                            {o.status === 'COMPLETED' && !it.reviewed && (
                              <Button size="sm" variant="secondary" onClick={() => setReviewItem(it)}><Star className="size-4" /> Đánh giá</Button>
                            )}
                            {it.reviewed && <Badge tone="success">Đã đánh giá</Badge>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>

              <div className="space-y-3">
                <Card className="p-3 md:p-4">
                  <h2 className="mb-2 flex items-center gap-2 font-semibold"><MapPin className="size-5 text-primary" /> Địa chỉ nhận hàng</h2>
                  <p className="text-sm font-medium">{o.shippingAddress?.fullName} <span className="font-normal text-muted">· {o.shippingAddress?.phone}</span></p>
                  <p className="break-words text-sm text-muted">{formatAddress(o.shippingAddress)}</p>
                </Card>
                <Card className="space-y-2 p-3 md:p-4">
                  <h2 className="mb-1 flex items-center gap-2 font-semibold"><Package className="size-5 text-primary" /> Thanh toán</h2>
                  <KV label="Tiền hàng">{formatVND(o.subtotal)}</KV>
                  <KV label="Phí vận chuyển">{formatVND(o.shippingFee)}</KV>
                  {o.discount > 0 && <KV label="Giảm giá"><span className="text-success">-{formatVND(o.discount)}</span></KV>}
                  <KV label="Thành tiền"><span className="text-lg font-semibold text-primary">{formatVND(o.total)}</span></KV>
                  <KV label="Phương thức">{PAYMENT_METHOD[o.paymentMethod] ?? o.paymentMethod}</KV>
                  <KV label="Đặt lúc">{formatDate(o.createdAt)}</KV>
                </Card>
                <div className="flex flex-col gap-2">
                  {o.status === 'AWAITING_PAYMENT' && <Button loading={repay.isPending} onClick={() => repay.mutate(o.checkoutId)}>Thanh toán ngay</Button>}
                  {o.status === 'DELIVERED' && <Button onClick={() => setSheet('received')}>Đã nhận được hàng</Button>}
                  {o.status === 'DELIVERED' && <Button variant="outline" onClick={() => setSheet('return')}>Yêu cầu trả hàng / hoàn tiền</Button>}
                  {['PENDING', 'AWAITING_PAYMENT', 'CONFIRMED'].includes(o.status) && <Button variant="outline" onClick={() => setSheet('cancel')}>Huỷ đơn hàng</Button>}
                </div>
              </div>

              <ReasonSheet open={sheet === 'cancel'} onClose={() => setSheet(null)} title="Huỷ đơn hàng" confirmText="Huỷ đơn" danger
                presets={['Muốn đổi địa chỉ giao hàng', 'Muốn đổi sản phẩm', 'Tìm được giá rẻ hơn', 'Không còn nhu cầu']}
                loading={cancel.isPending} onConfirm={(r) => cancel.mutate(r)} />
              <ReasonSheet open={sheet === 'return'} onClose={() => setSheet(null)} title="Yêu cầu trả hàng" confirmText="Gửi yêu cầu"
                presets={['Hàng lỗi, hư hỏng', 'Giao sai sản phẩm', 'Không giống mô tả', 'Thiếu hàng']} minLength={5}
                loading={ret.isPending} onConfirm={(r) => ret.mutate(r)} />
              <ConfirmSheet open={sheet === 'received'} onClose={() => setSheet(null)} title="Xác nhận đã nhận hàng"
                message="Sau khi xác nhận, tiền sẽ được chuyển cho người bán và bạn không thể yêu cầu trả hàng." confirmText="Đã nhận"
                loading={received.isPending} onConfirm={() => received.mutate()} />
              <ReviewSheet order={o} item={reviewItem} onClose={() => setReviewItem(null)} />
            </div>
          );
        }}
      </QueryView>
    </div>
  );
}

