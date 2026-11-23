'use client';

import { AlertTriangle, CheckCircle2, Wrench } from 'lucide-react';
import { Badge, Card, EmptyState, PageTitle, QueryView, SectionTitle, cn } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { LEVEL, PHASE, usePublicStatus, type PublicIncident, type PublicMaintenance, type StatusDay } from '@/lib/status';

const DAY_COLOR: Record<StatusDay['status'], string> = { operational: 'bg-success', degraded: 'bg-warning', outage: 'bg-danger' };

/** Trang trạng thái cho khách: tình trạng từng nhóm chức năng, uptime 90 ngày, thông báo sự cố do đội vận hành viết. */
export default function StatusPage() {
  const q = usePublicStatus(30_000);
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageTitle>Trạng thái hệ thống</PageTitle>
      <QueryView q={q} empty={<EmptyState title="Chưa có dữ liệu trạng thái" />}>
        {(d) => {
          const ok = d.overall === 'operational';
          return (
            <div className="flex flex-col gap-5">
              <Card className={cn('flex items-start gap-3 p-4', ok ? 'border-success' : 'border-warning')}>
                {ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />}
                <div className="min-w-0">
                  <p className="font-semibold">{ok ? 'Mọi chức năng đang hoạt động bình thường' : d.overall === 'under_maintenance' ? 'Một số chức năng đang bảo trì theo kế hoạch' : 'Một số chức năng đang gặp sự cố'}</p>
                  <p className="text-xs text-muted">Cập nhật {formatDate(d.updated_at)}</p>
                </div>
              </Card>

              {(d.maintenance ?? []).length > 0 && (
                <section>
                  <SectionTitle>Bảo trì có kế hoạch</SectionTitle>
                  <div className="flex flex-col gap-3">{(d.maintenance ?? []).map((m) => <MaintenanceCard key={m.id} m={m} />)}</div>
                </section>
              )}

              {d.active_incidents.length > 0 && (
                <section>
                  <SectionTitle>Sự cố đang xử lý</SectionTitle>
                  <div className="flex flex-col gap-3">{d.active_incidents.map((i) => <IncidentCard key={i.id} inc={i} />)}</div>
                </section>
              )}

              <section>
                <SectionTitle>Chức năng</SectionTitle>
                <ul className="flex flex-col gap-3">
                  {d.components.map((c) => (
                    <li key={c.id}>
                      <Card className="p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 font-medium break-words">{c.name}</span>
                          <Badge tone={LEVEL[c.status].tone}>{LEVEL[c.status].label}</Badge>
                        </div>
                        {/* điện thoại: 30 ngày gần nhất; từ sm: đủ 90 ngày */}
                        <div className="mt-3 flex h-8 gap-px" role="img" aria-label={`Uptime 90 ngày ${(c.uptime_90d * 100).toFixed(2)}%`}>
                          {c.days.map((day, idx) => (
                            <span key={day.date} title={`${day.date}: ${(day.uptime * 100).toFixed(2)}%`}
                              className={cn('min-w-0 flex-1 rounded-sm', DAY_COLOR[day.status], idx < c.days.length - 30 && 'hidden sm:block')} />
                          ))}
                        </div>
                        <div className="mt-1 flex justify-between text-xs text-muted">
                          <span><span className="sm:hidden">30</span><span className="hidden sm:inline">90</span> ngày trước</span>
                          <span>Uptime 90 ngày {(c.uptime_90d * 100).toFixed(2)}%</span>
                          <span>Hôm nay</span>
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <SectionTitle>Sự cố gần đây</SectionTitle>
                {d.recent_incidents.length
                  ? <div className="flex flex-col gap-3">{d.recent_incidents.map((i) => <IncidentCard key={i.id} inc={i} />)}</div>
                  : <p className="text-sm text-muted">Không có sự cố nào trong 14 ngày qua.</p>}
              </section>
            </div>
          );
        }}
      </QueryView>
    </div>
  );
}

function MaintenanceCard({ m }: { m: PublicMaintenance }) {
  const now = m.status === 'in_progress';
  return (
    <Card className={cn('flex items-start gap-3 p-4', now && 'border-info')}>
      <Wrench className="mt-0.5 size-5 shrink-0 text-info" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 break-words font-medium">{m.title}</p>
          <Badge tone={now ? 'info' : 'neutral'}>{now ? 'Đang bảo trì' : 'Sắp diễn ra'}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted break-words">{formatDate(m.starts)} → {formatDate(m.ends)} · {m.components.join(', ')}</p>
        <p className="mt-2 text-sm break-words">{m.message}</p>
      </div>
    </Card>
  );
}

function IncidentCard({ inc }: { inc: PublicIncident }) {
  return (
    <Card className="p-4">
      {/* điện thoại: nhãn giai đoạn lên dòng riêng để tiêu đề không bị bóp hẹp; từ sm: cùng hàng */}
      <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:gap-2">
        <Badge className="sm:order-2" tone={inc.status === 'resolved' ? 'success' : LEVEL[inc.impact].tone}>{PHASE[inc.status]}</Badge>
        <span className="min-w-0 font-medium break-words sm:order-1 sm:flex-1">{inc.title}</span>
      </div>
      <p className="mt-1 text-xs text-muted break-words">Ảnh hưởng: {inc.components.join(', ')} · bắt đầu {formatDate(inc.started_at)}</p>
      <ol className="mt-3 flex flex-col gap-2 border-l-2 border-border pl-3">
        {inc.updates.map((u) => (
          <li key={u.at + u.status} className="text-sm">
            <p className="break-words"><b>{PHASE[u.status]}</b> — {u.message}</p>
            <p className="text-xs text-muted">{formatDate(u.at)}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}
