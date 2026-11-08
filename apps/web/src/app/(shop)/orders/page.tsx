'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { useState } from 'react';
import { OrderCard } from '@/components/shop/order-card';
import { EmptyState, LinkButton, LoadingBlock, PageTitle, Pagination, QueryView, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { asArray, pick, totalPages } from '@/lib/format';
import type { OrderSnapshot } from '@/lib/types';

const TABS = [
  { value: '', label: 'Tất cả' },
  { value: 'AWAITING_PAYMENT', label: 'Chờ thanh toán' },
  { value: 'CONFIRMED', label: 'Chờ lấy hàng' },
  { value: 'SHIPPING', label: 'Đang giao' },
  { value: 'DELIVERED', label: 'Đã giao' },
  { value: 'COMPLETED', label: 'Hoàn thành' },
  { value: 'CANCELLED', label: 'Đã huỷ' },
  { value: 'RETURN_REQUESTED', label: 'Trả hàng' },
];

export default function OrdersPage() {
  const { ready } = useRequireAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const q = useQuery({
    queryKey: ['orders', status, page],
    enabled: ready,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/order/orders', { status: status || undefined, page, pageSize });
      return { items: asArray<OrderSnapshot>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  if (!ready) return <LoadingBlock />;
  return (
    <div>
      <PageTitle>Đơn mua</PageTitle>
      <Tabs className="mb-3" value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={TABS} />
      <QueryView q={q} isEmpty={(d) => !d.items.length}
        empty={<EmptyState icon={<ClipboardList className="size-6" />} title="Chưa có đơn hàng" action={<LinkButton href="/">Mua sắm ngay</LinkButton>} />}>
        {(d) => (
          <div className="space-y-3">
            {d.items.map((o) => <OrderCard key={o.id} order={o} href={`/orders/${o.id}`} />)}
            <Pagination page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </div>
        )}
      </QueryView>
    </div>
  );
}
