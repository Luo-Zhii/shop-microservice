import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Tone } from '@/lib/format';

export type Level = 'operational' | 'degraded_performance' | 'partial_outage' | 'major_outage';
export type Phase = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export interface StatusDay { date: string; uptime: number; status: 'operational' | 'degraded' | 'outage' }
export interface StatusComponent { id: string; name: string; status: Level; uptime_90d: number; days: StatusDay[] }
export interface PublicIncident {
  id: string; title: string; status: Phase; impact: Level; components: string[]; started_at: string; resolved_at: string | null;
  updates: { status: Phase; message: string; at: string }[];
}
export interface PublicStatus { overall: Level; updated_at: string; components: StatusComponent[]; active_incidents: PublicIncident[]; recent_incidents: PublicIncident[] }

export const LEVEL: Record<Level, { label: string; tone: Tone }> = {
  operational: { label: 'Hoạt động bình thường', tone: 'success' },
  degraded_performance: { label: 'Chậm hơn bình thường', tone: 'warning' },
  partial_outage: { label: 'Gián đoạn một phần', tone: 'warning' },
  major_outage: { label: 'Gián đoạn', tone: 'danger' },
};
export const PHASE: Record<Phase, string> = {
  investigating: 'Đang điều tra', identified: 'Đã xác định nguyên nhân', monitoring: 'Đang theo dõi', resolved: 'Đã khắc phục',
};

/** Trạng thái công khai (gateway mở không cần đăng nhập, AIOps cache 30s). */
export function usePublicStatus(refetchMs = 60_000) {
  return useQuery({
    queryKey: ['public-status'], retry: false, refetchInterval: refetchMs, staleTime: 30_000,
    queryFn: () => api.get<PublicStatus>('/aiops/status/public', undefined, { silent: true }),
  });
}
