'use client';

import { useQuery } from '@tanstack/react-query';
import { Ban, ClipboardList, DollarSign, PackageCheck } from 'lucide-react';
import { BarChart } from '@/components/bar-chart';
import { StatCard } from '@/components/dash-shell';
import { Badge, Card, PageTitle, QueryView, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { ORDER_STATUS, formatNumber, formatVND, pick, statusOf } from '@/lib/format';
import { normalizeStats } from '@/lib/stats';

export default function AdminDashboard() {
  const q = useQuery({ queryKey: ['admin-stats'], queryFn: async () => normalizeStats(await api.get('/order/admin/stats')) });
  return (
    <div>
      <PageTitle>Tổng quan sàn</PageTitle>
      <QueryView q={q} loading={<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20" />)}</div>}>
        {(s) => {
          const cancelled = Number(s.byStatus.CANCELLED ?? 0);
          const rate = Number(pick(s.raw, 'cancelRate', 'cancellationRate') ?? (s.orders ? cancelled / s.orders : 0));
          const pct = rate > 1 ? rate : rate * 100;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="GMV" value={formatVND(Number(pick(s.raw, 'gmv') ?? s.revenue))} icon={DollarSign} />
                <StatCard label="Tổng đơn" value={formatNumber(s.orders)} icon={ClipboardList} tone="info" />
                <StatCard label="Tỉ lệ huỷ" value={`${pct.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`} icon={Ban} tone={pct > 10 ? 'danger' : 'warning'} hint={`${formatNumber(cancelled)} đơn huỷ`} />
                <StatCard label="Hoàn thành" value={formatNumber(Number(s.byStatus.COMPLETED ?? 0))} icon={PackageCheck} tone="success" />
              </div>
              {s.series.length > 0 && <Card className="p-3 md:p-4"><h2 className="mb-1 font-semibold">GMV theo ngày</h2><BarChart data={s.series} format={formatVND} /></Card>}
              <Card className="p-3 md:p-4">
                <h2 className="mb-3 font-semibold">Đơn theo trạng thái</h2>
                {!Object.values(s.byStatus).some((v) => Number(v) > 0) ? <p className="text-sm text-muted">Chưa có dữ liệu.</p> : (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {Object.entries(s.byStatus).filter(([, v]) => Number(v) > 0).map(([k, v]) => {
                      const st = statusOf(ORDER_STATUS, k);
                      return <li key={k} className="rounded-lg border border-border p-3"><Badge tone={st.tone}>{st.label}</Badge><p className="mt-1 text-lg font-semibold">{formatNumber(Number(v))}</p></li>;
                    })}
                  </ul>
                )}
              </Card>
            </div>
          );
        }}
      </QueryView>
    </div>
  );
}
