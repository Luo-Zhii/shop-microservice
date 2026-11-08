'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useRef } from 'react';
import { Card, ErrorState, LinkButton, LoadingBlock } from '@/components/ui';
import { api } from '@/lib/api';
import { formatVND } from '@/lib/format';
import type { CheckoutStatus } from '@/lib/types';

const OK = ['CONFIRMED', 'PAID', 'COMPLETED', 'SUCCEEDED'];
const FAIL = ['CANCELLED', 'FAILED', 'EXPIRED'];
const REASONS: Record<string, string> = {
  OUT_OF_STOCK: 'Sản phẩm đã hết hàng', PAYMENT_FAILED: 'Thanh toán thất bại', PAYMENT_TIMEOUT: 'Quá hạn thanh toán', EXPIRED: 'Quá hạn giữ hàng', BUYER_CANCELLED: 'Bạn đã huỷ đơn',
};

function ResultView() {
  const sp = useSearchParams();
  const checkoutId = sp.get('checkoutId') ?? sp.get('vnp_TxnRef') ?? sp.get('id');
  const started = useRef(Date.now());
  const q = useQuery({
    queryKey: ['checkout', checkoutId],
    enabled: !!checkoutId,
    queryFn: () => api.get<CheckoutStatus>(`/order/checkouts/${checkoutId}`),
    refetchInterval: (query) => {
      const st = String(query.state.data?.status ?? '').toUpperCase();
      if (OK.includes(st) || FAIL.includes(st)) return false;
      return Date.now() - started.current < 90_000 ? 2000 : false;
    },
  });

  if (!checkoutId) return <ErrorState error={new Error('Thiếu mã thanh toán')} />;
  if (q.isPending) return <LoadingBlock label="Đang kiểm tra kết quả thanh toán…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const st = String(q.data.status ?? '').toUpperCase();
  const ok = OK.includes(st);
  const fail = FAIL.includes(st);
  const orders = q.data.orders ?? [];
  const reason = q.data.cancelReason ?? q.data.reason ?? orders[0]?.cancelReason ?? undefined;
  const total = q.data.total ?? orders.reduce((n, o) => n + (o.total ?? 0), 0);

  return (
    <Card className="mx-auto max-w-lg p-6 text-center">
      <div className="flex flex-col items-center gap-3">
        {ok ? <CheckCircle2 className="size-14 text-success" /> : fail ? <XCircle className="size-14 text-danger" /> : <Clock className="size-14 text-warning" />}
        <h1 className="text-xl font-semibold">{ok ? 'Đặt hàng thành công' : fail ? 'Đơn hàng không thành công' : 'Đang chờ xác nhận'}</h1>
        <p className="text-sm text-muted">
          {ok ? 'Cảm ơn bạn! Shop sẽ sớm chuẩn bị hàng.'
            : fail ? (reason === 'OUT_OF_STOCK' ? 'Sản phẩm đã hết hàng nên đơn bị huỷ.' : reason ? `Lý do: ${REASONS[reason] ?? reason}` : 'Thanh toán thất bại hoặc đơn đã bị huỷ.')
            : 'Hệ thống đang xử lý thanh toán. Trang sẽ tự cập nhật.'}
        </p>
        {total > 0 && <p className="text-sm">Tổng tiền: <span className="font-semibold text-primary">{formatVND(total)}</span></p>}
        {orders.length > 1 && <p className="text-xs text-muted">Đơn được tách thành {orders.length} đơn theo từng shop.</p>}
        {!ok && !fail && q.data.redirectUrl && (
          <a href={q.data.redirectUrl} className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg">Tiếp tục thanh toán</a>
        )}
        <div className="mt-2 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <LinkButton href="/orders" variant={ok ? 'primary' : 'outline'}>Xem đơn mua</LinkButton>
          <LinkButton href="/" variant="outline">Tiếp tục mua sắm</LinkButton>
        </div>
      </div>
    </Card>
  );
}

export default function CheckoutResultPage() {
  return <Suspense fallback={<LoadingBlock />}><ResultView /></Suspense>;
}
