'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, FileText, GitPullRequest, ShieldAlert, Siren, Snowflake, Wrench } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Stat } from '@/components/stat';
import { Badge, Button, Card, EmptyState, KV, PageTitle, QueryView, SectionTitle, Sheet, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, timeAgo, type Tone } from '@/lib/format';
import { toast } from '@/lib/toast';

interface Incident { id: string; service: string; severity: string; status: string; title: string; summary?: string; detected_at: string; root_causes?: { service: string; score: number }[] }
interface Step { n: number; thought: string; tool: string | null; evidence?: string; ok?: boolean }
interface Hypothesis { service: string; cause: string; confidence: number; evidence: string[] }
interface Investigation {
  id: string; mode: 'llm' | 'planner'; steps: Step[]; hypotheses: Hypothesis[]; dropped_hypotheses: Hypothesis[]; grounding: number;
  remediation: { action: string; service: string; reason: string; allowed: boolean; interlock: string; original_action?: string };
  evidence: { id: string; tool: string; ok: boolean; data: unknown }[];
  cost: { tool_calls: number; llm_tokens: number; seconds: number; usd: number };
  pr?: { status: string; url?: string; dry_run?: boolean; diff?: string; problems?: string[] } | null; created_at: string;
}

const SEV: Record<string, Tone> = { critical: 'danger', warning: 'warning', info: 'info' };
const STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Đang mở', tone: 'danger' }, acknowledged: { label: 'Đã nhận', tone: 'warning' },
  mitigated: { label: 'Đã khắc phục', tone: 'info' }, resolved: { label: 'Đã đóng', tone: 'success' },
};

export default function AdminAiopsPage() {
  const [view, setView] = useState<'incidents' | 'slo' | 'capacity' | 'changes' | 'digest'>('incidents');
  return (
    <div>
      <PageTitle>AIOps</PageTitle>
      <Tabs className="mb-4" value={view} onChange={setView}
        items={[{ value: 'incidents', label: 'Sự cố' }, { value: 'slo', label: 'SLO' }, { value: 'capacity', label: 'Dự báo dung lượng' }, { value: 'changes', label: 'Thay đổi' }, { value: 'digest', label: 'Bàn giao ca' }]} />
      {view === 'incidents' && <Incidents />}
      {view === 'slo' && <Slo />}
      {view === 'capacity' && <Capacity />}
      {view === 'changes' && <Changes />}
      {view === 'digest' && <Digest />}
    </div>
  );
}

interface SimilarItem { id: string; title: string | null; service: string; score: number; root_cause: string | null; actions: { type: string; status: string }[]; mttr_s: number | null }

/** "Lần trước bị thế này đã làm gì?" — sự cố đã đóng có dấu vân tay giống (service, nguyên nhân gốc, đặc trưng, alert). */
function SimilarIncidents({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['aiops-similar', id], retry: false, queryFn: () => api.get<{ items: SimilarItem[] }>(`/aiops/incidents/${id}/similar`) });
  if (!q.data?.items.length) return null;
  return (
    <section className="mb-4">
      <SectionTitle>Sự cố tương tự đã xử lý</SectionTitle>
      <ul className="flex flex-col gap-2">
        {q.data.items.map((s) => (
          <li key={s.id} className="rounded-xl border border-border p-3 text-sm">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 break-words font-medium">{s.title ?? s.service}</span>
              <Badge tone="info">giống {Math.round(s.score * 100)}%</Badge>
            </div>
            <p className="mt-1 break-words text-muted">
              Gốc: <b>{s.root_cause ?? '—'}</b>
              {' · '}Đã làm: {s.actions.length ? s.actions.map((a) => a.type + ' (' + a.status + ')').join(', ') : 'chỉ thông báo'}
              {s.mttr_s != null && ' · khắc phục sau ' + Math.round(s.mttr_s / 60) + ' phút'}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SloItem { slo: string; objective?: number | null; burn_rate?: number | null; budget_remaining?: number | null; state: 'exhausted' | 'fast_burn' | 'at_risk' | 'healthy'; services: string[] }
const SLO_STATE: Record<SloItem['state'], { label: string; tone: Tone }> = {
  exhausted: { label: 'Hết error budget', tone: 'danger' }, fast_burn: { label: 'Đốt nhanh', tone: 'danger' },
  at_risk: { label: 'Có rủi ro', tone: 'warning' }, healthy: { label: 'Khoẻ', tone: 'success' },
};

/** Trạng thái SLO (Sloth): hết budget → chính sách đóng băng thay đổi không khẩn cấp (chấm rủi ro thay đổi ép mức high). */
function Slo() {
  const q = useQuery({ queryKey: ['aiops-slo'], retry: false, refetchInterval: 60_000, queryFn: () => api.get<{ items: SloItem[] }>('/aiops/slo/status') });
  const pct = (v?: number | null) => (v == null ? '—' : (v * 100).toFixed(v >= 0.99 ? 1 : 0) + '%');
  return (
    <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa có SLO" description="Sloth chưa sinh recording rule hoặc Prometheus chưa sẵn sàng." />}>
      {(d) => (
        <DataTable rows={d.items} rowKey={(i) => i.slo}
          columns={[
            { key: 'slo', header: 'SLO', primary: true, cell: (i) => <span className="font-mono text-sm break-all">{i.slo}</span> },
            { key: 'st', header: 'Trạng thái', badge: true, cell: (i) => <Badge tone={SLO_STATE[i.state].tone}>{SLO_STATE[i.state].label}</Badge> },
            { key: 'obj', header: 'Mục tiêu', align: 'right', cell: (i) => pct(i.objective) },
            { key: 'burn', header: 'Tốc độ đốt', align: 'right', cell: (i) => (i.burn_rate == null ? '—' : <span className={i.burn_rate > 1 ? 'text-danger' : ''}>{i.burn_rate.toFixed(2)}×</span>) },
            { key: 'rem', header: 'Budget còn lại', align: 'right', cell: (i) => <b className={(i.budget_remaining ?? 1) <= 0 ? 'text-danger' : ''}>{pct(i.budget_remaining)}</b> },
            { key: 'svc', header: 'Service ràng buộc', hideOnMobile: true, cell: (i) => <span className="text-xs">{i.services.join(', ') || '—'}</span> },
          ]} />
      )}
    </QueryView>
  );
}

interface CapacityItem { service: string; model: string; current: number; peak: number; rmse: number; rps_per_pod: number; recommended_min_replicas: number; scale_up_ahead: boolean; event_uplift: number | null }

/** Dự báo rps 1–6 giờ tới (Holt-Winters + lịch flash sale) → replica tối thiểu đề xuất; KEDA đọc cùng số này để scale trước. */
function Capacity() {
  const [hours, setHours] = useState('1');
  const q = useQuery({
    queryKey: ['aiops-capacity', hours], retry: false,
    queryFn: () => api.get<{ upcoming_flash_sales: number; past_flash_sales: number; items: CapacityItem[] }>('/aiops/capacity/forecast', { hours: Number(hours) }),
  });
  return (
    <>
      <Tabs className="mb-3" value={hours} onChange={setHours} items={[{ value: '1', label: '1 giờ tới' }, { value: '3', label: '3 giờ tới' }, { value: '6', label: '6 giờ tới' }]} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa đủ dữ liệu để dự báo" description="Cần ít nhất 6 giờ lịch sử lưu lượng trong Prometheus." />}>
        {(d) => (
          <>
            {d.upcoming_flash_sales > 0 && (
              <Card className="mb-3 p-3 text-sm">
                <b>{d.upcoming_flash_sales}</b> flash sale sắp diễn ra trong khung dự báo — hệ số tăng tải học từ {d.past_flash_sales} sale đã qua.
              </Card>
            )}
            <DataTable rows={d.items} rowKey={(i) => i.service}
              columns={[
                { key: 'svc', header: 'Service', primary: true, cell: (i) => <span className="font-mono text-sm">{i.service}</span> },
                { key: 'st', header: 'Xu hướng', badge: true, cell: (i) => (i.scale_up_ahead ? <Badge tone="warning">Sắp tăng tải</Badge> : <Badge tone="success">Ổn định</Badge>) },
                { key: 'cur', header: 'Hiện tại (rps)', align: 'right', cell: (i) => i.current.toFixed(1) },
                { key: 'peak', header: 'Đỉnh dự báo', align: 'right', cell: (i) => <b>{i.peak.toFixed(1)}</b> },
                { key: 'up', header: 'Hệ số flash sale', align: 'right', hideOnMobile: true, cell: (i) => (i.event_uplift ? '×' + i.event_uplift.toFixed(2) : '—') },
                { key: 'rep', header: 'Replica tối thiểu', align: 'right', cell: (i) => <b className="text-primary">{i.recommended_min_replicas}</b> },
                { key: 'model', header: 'Mô hình', hideOnMobile: true, cell: (i) => <span className="text-xs text-muted">{i.model} · RMSE {i.rmse.toFixed(1)}</span> },
              ]} />
          </>
        )}
      </QueryView>
    </>
  );
}

type Level = 'low' | 'medium' | 'high';
interface DeployRow { id: string; ref: string; services: string[]; probability: number; level: Level; label: number | null; deployed_at: string }
interface ChangeSummary {
  deploys: number; labeled: number; pending: number; change_failure_rate: number | null; brier: number | null;
  calibration: { level: Level; deploys: number; failed: number; failure_rate: number | null; mean_predicted: number | null }[];
  model: { source: 'fitted' | 'prior'; records?: number; positives?: number; logloss_prior?: number; logloss_fit?: number; fitted_at?: string };
  items: DeployRow[];
}
const LEVEL: Record<Level, { label: string; tone: Tone }> = {
  low: { label: 'Thấp', tone: 'success' }, medium: { label: 'Trung bình', tone: 'warning' }, high: { label: 'Cao', tone: 'danger' },
};

type DoraKey = 'deployment_frequency' | 'lead_time' | 'change_failure_rate' | 'time_to_restore';
type Band = 'elite' | 'high' | 'medium' | 'low';
interface DoraMetric { value: number | null; band: Band | null; previous: number | null; previous_band: Band | null }
interface Dora { days: number; overall: Band | null; metrics: Record<DoraKey, DoraMetric>; counts: { deploys: number; labeled: number; with_lead_time: number; restored: number } }
const BAND: Record<Band, { label: string; tone: Tone }> = {
  elite: { label: 'Elite', tone: 'success' }, high: { label: 'High', tone: 'info' }, medium: { label: 'Medium', tone: 'warning' }, low: { label: 'Low', tone: 'danger' },
};
const dur = (s: number) => (s < 3600 ? Math.round(s / 60) + ' phút' : s < 86400 ? (s / 3600).toFixed(1) + ' giờ' : (s / 86400).toFixed(1) + ' ngày');
const DORA: { key: DoraKey; label: string; fmt: (v: number) => string; lowerIsBetter: boolean }[] = [
  { key: 'deployment_frequency', label: 'Tần suất deploy', fmt: (v) => (v >= 1 ? v.toFixed(1) + '/ngày' : (v * 7).toFixed(1) + '/tuần'), lowerIsBetter: false },
  { key: 'lead_time', label: 'Lead time', fmt: dur, lowerIsBetter: true },
  { key: 'change_failure_rate', label: 'Change failure rate', fmt: (v) => Math.round(v * 100) + '%', lowerIsBetter: true },
  { key: 'time_to_restore', label: 'Thời gian khôi phục', fmt: dur, lowerIsBetter: true },
];

/** Bốn chỉ số DORA 30 ngày tính từ dữ liệu nền tảng (deploy do promote.yml ghi + sự cố AIOps), so với 30 ngày trước. */
function DoraPanel() {
  const [env, setEnv] = useState('');
  const q = useQuery({ queryKey: ['aiops-dora', env], retry: false, placeholderData: keepPreviousData,
    queryFn: () => api.get<Dora>('/aiops/reports/dora', { days: 30, environment: env || undefined }) });
  return (
    <section>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SectionTitle className="mb-0 min-w-0 flex-1">DORA 30 ngày{q.data?.overall && <Badge className="ml-2" tone={BAND[q.data.overall].tone}>{BAND[q.data.overall].label}</Badge>}</SectionTitle>
        <Tabs value={env} onChange={setEnv} items={[{ value: '', label: 'Tất cả' }, { value: 'staging', label: 'Staging' }, { value: 'prod-onprem', label: 'On-prem' }, { value: 'prod-aws', label: 'AWS' }]} />
      </div>
      <QueryView q={q}>
        {(d) => (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {DORA.map(({ key, label, fmt, lowerIsBetter }) => {
              const m = d.metrics[key];
              const better = m.value != null && m.previous != null && m.value !== m.previous ? (m.value < m.previous) === lowerIsBetter : null;
              return (
                <li key={key} className="rounded-xl border border-border p-3">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-sm text-muted">{label}</span>
                    {m.band && <Badge tone={BAND[m.band].tone}>{BAND[m.band].label}</Badge>}
                  </div>
                  <p className="mt-1 text-lg font-semibold">{m.value == null ? '—' : fmt(m.value)}</p>
                  <p className={'text-xs ' + (better == null ? 'text-muted' : better ? 'text-success' : 'text-danger')}>
                    {m.previous == null ? 'Kỳ trước: chưa có dữ liệu' : `Kỳ trước: ${fmt(m.previous)}`}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </QueryView>
    </section>
  );
}

interface FreezeWindow { starts: string; ends: string; sale_starts: string; sale_ends: string; active: boolean }

/** Lịch đóng băng thay đổi quanh flash sale (promotion) — deploy chạm đường mua hàng trong khung này bị cổng promote chặn. */
function FreezeWindows() {
  const q = useQuery({ queryKey: ['aiops-freeze'], retry: false, refetchInterval: 300_000,
    queryFn: () => api.get<{ enabled: boolean; services: string[]; items: FreezeWindow[]; error?: string }>('/aiops/change-risk/freeze-windows', { hours: 48 }) });
  const d = q.data;
  if (!d?.enabled || (!d.items.length && !d.error)) return null;
  const active = d.items.find((w) => w.active);
  return (
    <Card className={'flex flex-col gap-2 p-3 text-sm' + (active ? ' border-danger' : '')}>
      <div className="flex items-start gap-2">
        <Snowflake className={'mt-0.5 size-4 shrink-0 ' + (active ? 'text-danger' : 'text-info')} />
        <p className="min-w-0 flex-1 break-words">
          {d.error ? <span className="text-muted">{d.error}. Cổng promote tạm cho qua (fail-open).</span>
            : active ? <><b>Đang đóng băng thay đổi</b> tới {formatDate(active.ends)}: chỉ deploy khẩn cấp (có lý do, ghi audit).</>
              : <><b>Lịch đóng băng 48 giờ tới</b>: promote lên prod chạm đường mua hàng sẽ bị chặn trong các khung dưới.</>}
        </p>
      </div>
      {d.items.length > 0 && (
        <ul className="flex flex-col gap-1 pl-6">
          {d.items.map((w) => (
            <li key={w.starts} className="break-words">
              {formatDate(w.starts)} → {formatDate(w.ends)}
              <span className="text-muted"> · flash sale {formatDate(w.sale_starts)}–{formatDate(w.sale_ends)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="pl-6 text-xs text-muted break-words">Phạm vi: {d.services.join(', ')}</p>
    </Card>
  );
}

/** Vòng học chấm rủi ro thay đổi: deploy thật (promote.yml ghi) → nhãn theo RCA sau 2h → học lại trọng số có cổng log-loss. */
function Changes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['aiops-changes'], retry: false, queryFn: () => api.get<ChangeSummary>('/aiops/change-risk/summary', { limit: 50 }) });
  const fit = useMutation({
    mutationFn: () => api.post<{ fitted: boolean; labeled_now: number; reason?: string }>('/aiops/change-risk/fit'),
    onSuccess: (r) => {
      if (r.fitted) toast.success(`Đã học lại trọng số (gắn thêm ${r.labeled_now} nhãn)`);
      else toast(r.reason ?? `Gắn thêm ${r.labeled_now} nhãn, chưa đủ để học lại`);
      void qc.invalidateQueries({ queryKey: ['aiops-changes'] });
    },
  });
  const pct = (v: number | null | undefined) => (v == null ? '—' : Math.round(v * 100) + '%');
  return (
    <div className="flex flex-col gap-4">
      <FreezeWindows />
      <QueryView q={q} isEmpty={(d) => !d.deploys}
        empty={<EmptyState title="Chưa có deploy nào được ghi" description="Đặt biến AIOPS_URL cho workflow promote để mỗi lần promote ghi diff thật vào vòng học." />}>
        {(d) => (
          <div className="flex flex-col gap-4">
            <DoraPanel />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Deploy đã gắn nhãn" value={`${d.labeled}/${d.deploys}`} />
              <Stat label="Chờ gắn nhãn (2 giờ)" value={String(d.pending)} />
              <Stat label="Brier score" value={d.brier == null ? '—' : d.brier.toFixed(3)} />
              <Stat label="Trọng số" value={d.model.source === 'fitted' ? 'Đã học' : 'Prior'} />
            </div>
            <Card className="flex flex-col gap-3 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <p className="min-w-0 flex-1 text-sm text-muted">
                  {d.model.source === 'fitted'
                    ? <>Mô hình học từ <b>{d.model.records}</b> deploy ({d.model.positives} lần gây sự cố) lúc {formatDate(d.model.fitted_at)} · log-loss {d.model.logloss_fit} so với prior {d.model.logloss_prior}.</>
                    : <>Đang dùng trọng số prior do người đặt. Cần ≥ 30 deploy đã gắn nhãn, có cả deploy hỏng lẫn không, mới học lại.</>}
                </p>
                <Button variant="outline" className="sm:shrink-0" onClick={() => fit.mutate()} disabled={fit.isPending}>{fit.isPending ? 'Đang học…' : 'Gắn nhãn & học lại'}</Button>
              </div>
              <div>
                <SectionTitle>Hiệu chỉnh theo mức rủi ro</SectionTitle>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {d.calibration.map((c) => (
                    <li key={c.level} className="rounded-xl border border-border p-3 text-sm">
                      <Badge tone={LEVEL[c.level].tone}>{LEVEL[c.level].label}</Badge>
                      <p className="mt-2">Dự báo <b>{pct(c.mean_predicted)}</b> · thực tế <b>{pct(c.failure_rate)}</b></p>
                      <p className="text-xs text-muted">{c.failed}/{c.deploys} deploy gây sự cố</p>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
            <section>
              <SectionTitle>Deploy gần nhất</SectionTitle>
              <DataTable rows={d.items} rowKey={(i) => i.id}
                columns={[
                  { key: 'ref', header: 'Thay đổi', primary: true, cell: (i) => <span className="break-words text-sm">{i.ref || i.services.join(', ')}</span> },
                  { key: 'lv', header: 'Rủi ro', badge: true, cell: (i) => <Badge tone={LEVEL[i.level].tone}>{LEVEL[i.level].label} · {pct(i.probability)}</Badge> },
                  { key: 'svc', header: 'Service', cell: (i) => <span className="font-mono text-xs break-all">{i.services.join(', ') || '—'}</span> },
                  { key: 'lab', header: 'Kết quả (RCA)', cell: (i) => (i.label == null ? <span className="text-muted">Chờ 2 giờ</span> : i.label ? <Badge tone="danger">Gây sự cố</Badge> : <Badge tone="success">Ổn</Badge>) },
                  { key: 'at', header: 'Lúc', hideOnMobile: true, cell: (i) => <span title={formatDate(i.deployed_at)}>{timeAgo(i.deployed_at)}</span> },
                ]} />
            </section>
          </div>
        )}
      </QueryView>
    </div>
  );
}

/** Bản tin bàn giao ca (cùng nội dung CronJob 8:30 gửi lên kênh trực) — xem trước hoặc gửi ngay. */
function Digest() {
  const q = useQuery({ queryKey: ['aiops-digest'], queryFn: () => api.get<{ markdown: string; attention: string[]; incidents: { new: number; open: number; resolved: number } }>('/aiops/reports/oncall-digest', { hours: 24 }) });
  return (
    <QueryView q={q}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Sự cố mới 24h" value={String(d.incidents.new)} />
            <Stat label="Đang mở" value={String(d.incidents.open)} tone={d.incidents.open ? 'danger' : 'success'} />
            <Stat label="Đã đóng" value={String(d.incidents.resolved)} />
          </div>
          {d.attention.length > 0 && (
            <Card className="p-3">
              <SectionTitle>Cần chú ý</SectionTitle>
              <ul className="list-disc space-y-1 pl-5 text-sm">{d.attention.map((a) => <li key={a} className="break-words">{a}</li>)}</ul>
            </Card>
          )}
          <Card className="p-3"><pre className="whitespace-pre-wrap break-words text-sm">{d.markdown}</pre></Card>
          <AlertQuality />
        </div>
      )}
    </QueryView>
  );
}

interface AlertQ { alertname: string; incidents: number; flapping_ratio: number; ack_ratio: number; action_ratio: number; recommendation: 'noisy' | 'ticket' | 'actionable' | 'insufficient'; reason: string }
const REC: Record<AlertQ['recommendation'], { label: string; tone: Tone }> = {
  noisy: { label: 'Ồn — chỉnh ngưỡng', tone: 'danger' }, ticket: { label: 'Hạ xuống ticket', tone: 'warning' },
  actionable: { label: 'Giữ nguyên', tone: 'success' }, insufficient: { label: 'Chưa đủ dữ liệu', tone: 'neutral' },
};

/** Alert hygiene 30 ngày: cảnh báo nào ồn (tự hết nhanh, không ai nhận) nên chỉnh, cảnh báo nào nên hạ xuống ticket. */
function AlertQuality() {
  const q = useQuery({ queryKey: ['aiops-alert-quality'], retry: false, queryFn: () => api.get<{ noise_ratio: number; items: AlertQ[] }>('/aiops/reports/alert-quality', { days: 30 }) });
  if (!q.data?.items.length) return null;
  const pct = (v: number) => Math.round(v * 100) + '%';
  return (
    <section>
      <SectionTitle>Chất lượng cảnh báo (30 ngày)</SectionTitle>
      <p className="-mt-2 mb-3 text-sm text-muted">{pct(q.data.noise_ratio)} sự cố đến từ cảnh báo ồn.</p>
      <DataTable rows={q.data.items} rowKey={(r) => r.alertname}
        columns={[
          { key: 'name', header: 'Cảnh báo', primary: true, cell: (r) => <span className="font-mono text-sm break-all">{r.alertname}</span> },
          { key: 'rec', header: 'Khuyến nghị', badge: true, cell: (r) => <Badge tone={REC[r.recommendation].tone}>{REC[r.recommendation].label}</Badge> },
          { key: 'n', header: 'Sự cố', align: 'right', cell: (r) => r.incidents },
          { key: 'flap', header: 'Tự hết < 5 phút', align: 'right', cell: (r) => pct(r.flapping_ratio) },
          { key: 'ack', header: 'Có người nhận', align: 'right', hideOnMobile: true, cell: (r) => pct(r.ack_ratio) },
          { key: 'act', header: 'Dẫn tới khắc phục', align: 'right', hideOnMobile: true, cell: (r) => pct(r.action_ratio) },
          { key: 'why', header: 'Lý do', hideOnMobile: true, cell: (r) => <span className="text-xs">{r.reason}</span> },
        ]} />
    </section>
  );
}

function Incidents() {
  const [status, setStatus] = useState('open');
  const [sel, setSel] = useState<Incident | null>(null);
  const q = useQuery({
    queryKey: ['aiops-incidents', status],
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    queryFn: () => api.get<{ items: Incident[] }>('/aiops/incidents', { status: status || undefined, limit: 100 }),
  });
  return (
    <div>
      <Tabs className="mb-3" value={status} onChange={setStatus}
        items={[{ value: 'open', label: 'Đang mở' }, { value: 'acknowledged', label: 'Đã nhận' }, { value: 'resolved', label: 'Đã đóng' }, { value: '', label: 'Tất cả' }]} />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<CheckCircle2 className="size-6" />} title="Không có sự cố" description="Detector chưa phát hiện bất thường nào." />}>
        {(d) => (
          <DataTable rows={d.items} rowKey={(i) => i.id} onRowClick={setSel}
            columns={[
              { key: 'title', header: 'Sự cố', primary: true, cell: (i) => <span className="line-clamp-2">{i.title}</span> },
              { key: 'status', header: 'Trạng thái', badge: true, cell: (i) => <Badge tone={STATUS[i.status]?.tone}>{STATUS[i.status]?.label ?? i.status}</Badge> },
              { key: 'svc', header: 'Service', cell: (i) => <span className="font-mono text-xs">{i.service}</span> },
              { key: 'sev', header: 'Mức', cell: (i) => <Badge tone={SEV[i.severity] ?? 'neutral'}>{i.severity}</Badge> },
              { key: 'rc', header: 'Nguyên nhân gốc (RCA)', cell: (i) => i.root_causes?.[0]?.service ?? '—' },
              { key: 'at', header: 'Phát hiện', cell: (i) => <span title={formatDate(i.detected_at)}>{timeAgo(i.detected_at)}</span> },
            ]} />
        )}
      </QueryView>
      {sel && <IncidentSheet incident={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function IncidentSheet({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  const qc = useQueryClient();
  const inv = useQuery({
    queryKey: ['aiops-inv', incident.id],
    queryFn: () => api.get<{ items: Investigation[] }>(`/aiops/incidents/${incident.id}/investigations`),
  });
  const run = useMutation({
    mutationFn: () => api.post<Investigation>(`/aiops/incidents/${incident.id}/agent-investigate`),
    onSuccess: () => { toast.success('Tác tử đã điều tra xong'); void qc.invalidateQueries({ queryKey: ['aiops-inv', incident.id] }); },
  });
  const pr = useMutation({
    mutationFn: (id: string) => api.post<NonNullable<Investigation['pr']>>(`/aiops/investigations/${id}/propose-pr`),
    onSuccess: (r) => {
      if (r.status === 'proposed') toast.success(r.dry_run ? 'Đã tạo bản vá (dry-run, chưa có token GitHub)' : 'Đã mở PR GitOps — chờ duyệt');
      else toast.error(`Không mở PR: ${(r.problems ?? []).join('; ') || r.status}`);
      void qc.invalidateQueries({ queryKey: ['aiops-inv', incident.id] });
    },
  });
  const ack = useMutation({
    mutationFn: (path: 'ack' | 'resolve') => api.post(`/aiops/incidents/${incident.id}/${path}`),
    onSuccess: () => { toast.success('Đã cập nhật'); void qc.invalidateQueries({ queryKey: ['aiops-incidents'] }); onClose(); },
  });
  // postmortem blameless sinh từ dữ liệu sự cố → tải về .md để đưa vào wiki / họp review
  const pm = useMutation({
    mutationFn: () => api.get<{ markdown: string }>(`/aiops/incidents/${incident.id}/postmortem`),
    onSuccess: ({ markdown }) => {
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `postmortem-${incident.service}-${incident.id.slice(0, 8)}.md` });
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Đã tải postmortem');
    },
  });
  const latest = inv.data?.items[0];
  return (
    <Sheet open onClose={onClose} wide title={<span className="flex items-center gap-2"><Siren className="size-4 text-danger" />{incident.service}</span>}
      footer={<>
        {incident.status === 'open' && <Button variant="outline" onClick={() => ack.mutate('ack')} disabled={ack.isPending}>Nhận xử lý</Button>}
        {incident.status !== 'resolved' && <Button variant="outline" onClick={() => ack.mutate('resolve')} disabled={ack.isPending}>Đóng sự cố</Button>}
        <Button variant="outline" onClick={() => pm.mutate()} disabled={pm.isPending}><FileText className="size-4" />Postmortem</Button>
        <Button onClick={() => run.mutate()} disabled={run.isPending}><Bot className="size-4" />{run.isPending ? 'Đang điều tra…' : 'Tác tử điều tra'}</Button>
      </>}>
      <p className="mb-3 break-words text-sm">{incident.title}</p>
      {incident.summary && <Card className="mb-4 p-3 text-sm whitespace-pre-line">{incident.summary}</Card>}
      <SimilarIncidents id={incident.id} />
      <QueryView q={inv} isEmpty={(d) => !d.items.length}
        empty={<EmptyState icon={<Bot className="size-6" />} title="Chưa có bản điều tra" description="Bấm “Tác tử điều tra” để chạy RCA nhiều bước qua công cụ MCP." />}>
        {() => latest && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Chế độ" value={latest.mode === 'llm' ? 'LLM ReAct' : 'Planner'} />
              <Stat label="Grounding" value={`${Math.round(latest.grounding * 100)}%`} />
              <Stat label="Lần gọi công cụ" value={String(latest.cost.tool_calls)} />
              <Stat label="Chi phí" value={`$${latest.cost.usd.toFixed(4)} · ${latest.cost.seconds}s`} />
            </div>

            <section>
              <SectionTitle>Giả thuyết (có bằng chứng)</SectionTitle>
              {latest.hypotheses.length ? (
                <ul className="flex flex-col gap-2">
                  {latest.hypotheses.map((h, i) => (
                    <li key={i} className="rounded-xl border border-border p-3">
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 break-words text-sm font-medium">{h.service}: {h.cause}</span>
                        <Badge tone={h.confidence >= 0.7 ? 'danger' : h.confidence >= 0.5 ? 'warning' : 'neutral'}>{Math.round(h.confidence * 100)}%</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">{h.evidence.map((e) => <Badge key={e} tone="info">{e}</Badge>)}</div>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted">Không có giả thuyết đủ bằng chứng.</p>}
              {latest.dropped_hypotheses.length > 0 && (
                <p className="mt-2 text-xs text-muted">Đã loại {latest.dropped_hypotheses.length} giả thuyết không trích bằng chứng: {latest.dropped_hypotheses.map((h) => h.service).join(', ')}</p>
              )}
            </section>

            <section>
              <SectionTitle>Đề xuất khắc phục</SectionTitle>
              <Card className="flex flex-col gap-2 p-3">
                <KV label="Hành động"><span className="inline-flex items-center gap-1 font-medium"><Wrench className="size-4" />{latest.remediation.action} {latest.remediation.service}</span></KV>
                <KV label="Lý do">{latest.remediation.reason}</KV>
                <KV label="SafetyInterlock">
                  {latest.remediation.allowed ? <Badge tone="success">cho phép</Badge>
                    : <span className="inline-flex items-center gap-1 text-danger"><ShieldAlert className="size-4" />{latest.remediation.interlock}</span>}
                </KV>
                {latest.pr?.url && <KV label="PR"><a className="text-primary underline break-all" href={latest.pr.url} target="_blank" rel="noreferrer">{latest.pr.url}</a></KV>}
                {latest.pr?.problems && <KV label="Cổng xác minh"><span className="text-danger">{latest.pr.problems.join('; ')}</span></KV>}
                {latest.pr?.diff && <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre">{latest.pr.diff}</pre>}
                {['rollback', 'scale_up'].includes(latest.remediation.action) && latest.remediation.allowed && !latest.pr?.url && (
                  <Button variant="secondary" className="self-end" onClick={() => pr.mutate(latest.id)} disabled={pr.isPending}>
                    <GitPullRequest className="size-4" />Mở PR GitOps
                  </Button>
                )}
              </Card>
            </section>

            <section>
              <SectionTitle>Các bước điều tra</SectionTitle>
              <ol className="flex flex-col gap-2 border-l-2 border-border pl-3">
                {latest.steps.map((s) => (
                  <li key={s.n} className="text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted">#{s.n}</span>
                      {s.tool && <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{s.tool}</code>}
                      {s.evidence && <Badge tone={s.ok ? 'info' : 'danger'}>{s.evidence}</Badge>}
                    </div>
                    <p className="mt-0.5 break-words text-muted">{s.thought}</p>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </QueryView>
    </Sheet>
  );
}
