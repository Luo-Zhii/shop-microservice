'use client';

import { useQuery } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import { Stat } from '@/components/stat';
import { Badge, Card, EmptyState, PageTitle, QueryView } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/format';

interface CarrierHealth {
  carrier: string; name: string; enabled: boolean; delivered: number; onTime: number; onTimeRatio: number | null; finished: number; failed: number;
  failedRatio: number | null; pickupP90Hours: number | null; active: number; stuck: number; webhookAgeHours: number | null;
  degraded: boolean; avoided: boolean; reasons: string[];
}
interface HealthReport {
  policy: { minOnTime: number; maxFailed: number; minSample: number; stuckHours: number; webhookStaleHours: number; graceHours: number };
  updatedAt: string; items: CarrierHealth[];
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);

/** SLO đối tác vận chuyển: đúng hạn, thất bại, tốc độ lấy hàng, vận đơn kẹt, webhook im lặng — hãng xuống cấp bị tránh cho đơn mới. */
export default function AdminShippingPage() {
  const q = useQuery({ queryKey: ['carrier-health'], refetchInterval: 300_000, queryFn: () => api.get<HealthReport>('/shipping/admin/carriers/health') });
  return (
    <div>
      <PageTitle>Vận chuyển</PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<Truck className="size-6" />} title="Chưa có hãng vận chuyển" />}>
        {(d) => (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              SLO hãng (7 ngày): giao đúng hạn ≥ {d.policy.minOnTime * 100}% (hạn = ETA + {d.policy.graceHours} giờ), giao thất bại ≤ {d.policy.maxFailed * 100}%,
              chỉ xét khi có ≥ {d.policy.minSample} vận đơn; còn vận đơn đang chạy mà hãng im lặng quá {d.policy.webhookStaleHours} giờ cũng tính là xuống cấp.
              Hãng xuống cấp bị tránh khi chọn hãng cho đơn mới (không bao giờ tránh hết). Cập nhật {formatDate(d.updatedAt)}.
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {d.items.map((c) => (
                <Card key={c.carrier} className={'flex min-w-0 flex-col gap-3 p-3' + (c.degraded ? ' border-danger' : '')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Truck className="size-4 shrink-0 text-muted" />
                    <b className="min-w-0 flex-1 break-words">{c.name} <span className="font-mono text-xs text-muted">{c.carrier}</span></b>
                    <Badge tone={!c.enabled ? 'neutral' : c.degraded ? 'danger' : 'success'}>{!c.enabled ? 'Đã tắt' : c.degraded ? 'Xuống cấp' : 'Ổn định'}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="Đúng hạn" value={pct(c.onTimeRatio)} tone={c.onTimeRatio != null && c.delivered >= d.policy.minSample ? (c.onTimeRatio < d.policy.minOnTime ? 'danger' : 'success') : undefined} />
                    <Stat label="Giao thất bại" value={pct(c.failedRatio)} tone={c.failedRatio != null && c.finished >= d.policy.minSample && c.failedRatio > d.policy.maxFailed ? 'danger' : undefined} />
                    <Stat label="Lấy hàng p90" value={c.pickupP90Hours == null ? '—' : `${c.pickupP90Hours} giờ`} />
                    <Stat label={`Kẹt > ${d.policy.stuckHours} giờ`} value={`${formatNumber(c.stuck)} / ${formatNumber(c.active)}`} tone={c.stuck ? 'danger' : undefined} />
                  </div>
                  <p className="text-xs text-muted">
                    {formatNumber(c.delivered)} giao xong · webhook gần nhất {c.webhookAgeHours == null ? 'không có trong 7 ngày' : `${c.webhookAgeHours} giờ trước`}
                  </p>
                  {c.reasons.length > 0 && (
                    <ul className="flex flex-col gap-1 text-sm">
                      {c.reasons.map((r) => <li key={r} className="break-words text-danger">• {r}</li>)}
                      <li className="text-xs text-muted">{c.avoided ? 'Đang bị tránh khi chọn hãng cho đơn mới.' : 'Không tránh được vì mọi hãng đều xuống cấp — vẫn chọn rẻ nhất.'}</li>
                    </ul>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}
      </QueryView>
    </div>
  );
}
