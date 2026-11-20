'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Ban, ClipboardList, Coins, DollarSign, Gauge, PackageCheck, ShieldCheck, Siren } from 'lucide-react';
import { BarChart } from '@/components/bar-chart';
import { StatCard } from '@/components/dash-shell';
import { Badge, Card, LinkButton, PageTitle, QueryView, SectionTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { ORDER_STATUS, formatCompact, formatNumber, formatVND, pick, statusOf } from '@/lib/format';
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
          const gmv = Number(pick(s.raw, 'gmv') ?? s.revenue);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="GMV" icon={DollarSign} value={
                  // thẻ 2 cột trên điện thoại không đủ chỗ cho số tiền 12 chữ số → rút gọn (tỷ/tr), đủ số từ md; title giữ số đầy đủ
                  <span title={formatVND(gmv)}><span className="md:hidden">{formatCompact(gmv)} ₫</span><span className="hidden md:inline">{formatVND(gmv)}</span></span>
                } />
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
      <PlatformHealth />
    </div>
  );
}

interface PlatformSummary { incidents_open: number; cost_per_order_usd: number | null; lcp_p75_s: number | null; error_budget: Record<string, number>; prometheus: boolean }

/** Tín hiệu vận hành (AIOps/SRE/FinOps) cạnh số liệu kinh doanh — lỗi/không có quyền thì ẩn, không làm hỏng trang. */
function PlatformHealth() {
  const q = useQuery({
    queryKey: ['platform-summary'], refetchInterval: 60_000, retry: false,
    queryFn: () => api.get<PlatformSummary>('/aiops/platform/summary', undefined, { silent: true }),
  });
  if (!q.data) return null;
  const d = q.data;
  const budgets = Object.entries(d.error_budget).sort((a, b) => a[1] - b[1]);
  const lowest = budgets[0];
  const lcpTone = d.lcp_p75_s == null ? 'info' : d.lcp_p75_s <= 2.5 ? 'success' : d.lcp_p75_s <= 4 ? 'warning' : 'danger';
  const budgetTone = !lowest ? 'info' : lowest[1] <= 0 ? 'danger' : lowest[1] < 0.25 ? 'warning' : 'success';
  return (
    <section className="mt-6">
      <SectionTitle action={<LinkButton href="/admin/aiops" variant="ghost" size="sm">Sự cố <ArrowRight className="size-4" /></LinkButton>}>
        Sức khoẻ nền tảng
      </SectionTitle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Sự cố mở" value={formatNumber(d.incidents_open)} icon={Siren} tone={d.incidents_open ? 'danger' : 'success'} />
        <StatCard label="LCP p75" value={d.lcp_p75_s == null ? '—' : d.lcp_p75_s.toFixed(2) + 's'} icon={Gauge} tone={lcpTone} hint="tốt ≤ 2.5s" />
        <StatCard label="Chi phí/đơn" value={d.cost_per_order_usd == null ? '—' : '$' + d.cost_per_order_usd.toFixed(4)} icon={Coins} tone="info" />
        <StatCard label="Error budget" value={lowest ? Math.round(lowest[1] * 100) + '%' : '—'} icon={ShieldCheck} tone={budgetTone} hint={lowest?.[0]} />
      </div>
      {!d.prometheus && <p className="mt-2 text-xs text-muted">Chưa nối Prometheus — chỉ hiện số sự cố.</p>}
    </section>
  );
}
