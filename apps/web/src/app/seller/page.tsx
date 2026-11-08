'use client';

import { useQuery } from '@tanstack/react-query';
import { ClipboardList, DollarSign, PackageCheck, Truck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BarChart } from '@/components/bar-chart';
import { StatCard } from '@/components/dash-shell';
import { Badge, Card, PageTitle, QueryView, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { ORDER_STATUS, formatNumber, formatVND, statusOf } from '@/lib/format';
import { normalizeStats } from '@/lib/stats';

export default function SellerDashboard() {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['seller-stats', days], queryFn: async () => normalizeStats(await api.get('/order/seller/stats', { days })) });
  return (
    <div>
      <PageTitle actions={(
        <Select aria-label="Khoảng thời gian" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto">
          <option value={7}>7 ngày</option><option value={30}>30 ngày</option><option value={90}>90 ngày</option>
        </Select>
      )}>Tổng quan</PageTitle>
      <QueryView q={q} loading={<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20" />)}</div>}>
        {(s) => (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Doanh thu" value={formatVND(s.revenue)} icon={DollarSign} />
              <StatCard label="Đơn hàng" value={formatNumber(s.orders)} icon={ClipboardList} tone="info" />
              <StatCard label="Chờ lấy hàng" value={formatNumber(s.byStatus.CONFIRMED ?? 0)} icon={Truck} tone="warning" />
              <StatCard label="Hoàn thành" value={formatNumber(s.byStatus.COMPLETED ?? 0)} icon={PackageCheck} tone="success" />
            </div>
            <Card className="p-3 md:p-4">
              <h2 className="mb-1 font-semibold">Doanh thu theo ngày</h2>
              <BarChart data={s.series} format={formatVND} />
            </Card>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
              <Card className="min-w-0 p-3 md:p-4">
                <h2 className="mb-3 font-semibold">Đơn theo trạng thái</h2>
                {!Object.values(s.byStatus).some((v) => Number(v) > 0) ? <p className="text-sm text-muted">Chưa có đơn hàng.</p> : (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {Object.entries(s.byStatus).filter(([, v]) => Number(v) > 0).map(([k, v]) => {
                      const st = statusOf(ORDER_STATUS, k);
                      return (
                        <li key={k}>
                          <Link href={`/seller/orders?status=${k}`} className="flex min-h-14 flex-col justify-center rounded-lg border border-border px-3 hover:border-primary">
                            <Badge tone={st.tone} className="self-start">{st.label}</Badge>
                            <span className="mt-1 text-lg font-semibold">{formatNumber(Number(v))}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
              <Card className="min-w-0 p-3 md:p-4">
                <h2 className="mb-3 font-semibold">Sản phẩm bán chạy</h2>
                {s.top.length === 0 ? <p className="text-sm text-muted">Chưa có dữ liệu.</p> : (
                  <ol className="divide-y divide-border">
                    {s.top.slice(0, 8).map((t, i) => (
                      <li key={`${t.productId}-${i}`} className="flex items-center gap-3 py-2 text-sm">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        <span className="shrink-0 text-right"><span className="block font-medium">{formatVND(t.revenue)}</span><span className="text-xs text-muted">{t.qty} đã bán</span></span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>
          </div>
        )}
      </QueryView>
    </div>
  );
}
