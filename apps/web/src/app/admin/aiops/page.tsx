'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, FileText, GitPullRequest, ShieldAlert, Siren, Snowflake, Wrench } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Stat } from '@/components/stat';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, KV, PageTitle, QueryView, SectionTitle, Select, Sheet, Tabs, Textarea } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatCompact, formatDate, formatNumber, formatVND, timeAgo, toDateTimeLocal, type Tone } from '@/lib/format';
import { LEVEL as STATUS_LEVEL, PHASE, type Level as StatusLevel, type Phase } from '@/lib/status';
import { toast } from '@/lib/toast';

interface Incident { id: string; service: string; severity: string; status: string; title: string; summary?: string; detected_at: string; drill_id?: string | null; assignee?: string | null; root_causes?: { service: string; score: number }[] }
interface Step { n: number; thought: string; tool: string | null; evidence?: string; ok?: boolean }
interface Hypothesis { service: string; cause: string; confidence: number; evidence: string[] }
interface Investigation {
  id: string; mode: 'llm' | 'planner'; steps: Step[]; hypotheses: Hypothesis[]; dropped_hypotheses: Hypothesis[]; grounding: number;
  remediation: { action: string; service: string; reason: string; allowed: boolean; interlock: string; original_action?: string; params?: { flag?: string } };
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
  const [view, setView] = useState<'incidents' | 'slo' | 'capacity' | 'changes' | 'problems' | 'security' | 'autonomy' | 'drills' | 'digest'>('incidents');
  return (
    <div>
      <PageTitle>AIOps</PageTitle>
      <Tabs className="mb-4" value={view} onChange={setView}
        items={[{ value: 'incidents', label: 'Sự cố' }, { value: 'slo', label: 'SLO' }, { value: 'capacity', label: 'Dự báo dung lượng' }, { value: 'changes', label: 'Thay đổi' }, { value: 'problems', label: 'Vấn đề' }, { value: 'security', label: 'Bảo mật' }, { value: 'autonomy', label: 'Tự động hoá' }, { value: 'drills', label: 'Diễn tập' }, { value: 'digest', label: 'Bàn giao ca' }]} />
      {view === 'incidents' && <Incidents />}
      {view === 'slo' && <Slo />}
      {view === 'capacity' && <Capacity />}
      {view === 'changes' && <Changes />}
      {view === 'problems' && <Problems />}
      {view === 'security' && <Security />}
      {view === 'autonomy' && <Autonomy />}
      {view === 'drills' && <Drills />}
      {view === 'digest' && <Digest />}
    </div>
  );
}

interface Impact { available: boolean; reason?: string; ongoing?: boolean; orders_actual: number; orders_expected: number; orders_deficit: number; orders_rebound: number; rebound_measured: boolean; orders_lost: number; aov_vnd: number; gmv_lost_vnd: number; drop_ratio: number | null; confidence: 'low' | 'medium'; note: string }

/** Quy sự cố ra tiền: đơn hụt so với cùng khung giờ hôm qua/tuần trước, trừ khách mua bù, × giá trị đơn TB 7 ngày. */
function BusinessImpact({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['aiops-impact', id], retry: false, queryFn: () => api.get<Impact>(`/aiops/incidents/${id}/impact`) });
  const d = q.data;
  if (!d?.available) return null;
  return (
    <section className="mb-4">
      <SectionTitle>Ảnh hưởng kinh doanh (ước lượng)</SectionTitle>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="GMV ước mất" tone={d.gmv_lost_vnd > 0 ? 'danger' : 'success'}
          value={<span title={formatVND(d.gmv_lost_vnd)}><span className="md:hidden">{formatCompact(d.gmv_lost_vnd)} ₫</span><span className="hidden md:inline">{formatVND(d.gmv_lost_vnd)}</span></span>} />
        <Stat label="Đơn mất ròng" value={formatNumber(d.orders_lost)} />
        <Stat label="Thực tế / kỳ vọng" value={`${formatNumber(d.orders_actual)} / ${formatNumber(d.orders_expected)}`} />
        <Stat label="Khách mua bù" value={d.rebound_measured ? formatNumber(d.orders_rebound) : 'chưa đo'} />
      </div>
      <p className="mt-2 text-xs text-muted break-words">
        {d.ongoing && 'Sự cố chưa đóng — số còn tăng. '}Độ tin cậy {d.confidence === 'low' ? 'thấp' : 'trung bình'}: {d.note}. Ước lượng để ưu tiên đầu tư độ tin cậy, không ghi sổ kế toán.
      </p>
    </section>
  );
}

interface StatusUpdate { id: string; status: Phase; impact: StatusLevel | null; title: string | null; message: string; author: string; created_at: number }
const TEMPLATE: Record<Phase, string> = {
  investigating: 'Chúng tôi đang ghi nhận một số khách hàng gặp khó khăn khi sử dụng chức năng này và đang khẩn trương kiểm tra.',
  identified: 'Chúng tôi đã xác định được nguyên nhân và đang triển khai biện pháp khắc phục.',
  monitoring: 'Biện pháp khắc phục đã được áp dụng. Chúng tôi đang tiếp tục theo dõi để đảm bảo hệ thống ổn định.',
  resolved: 'Sự cố đã được khắc phục hoàn toàn. Xin lỗi quý khách vì sự bất tiện.',
};

/** Giao tiếp sự cố với khách (trang /status): người trực viết — không tự đẩy alert thô ra ngoài. */
function PublicComms({ incident }: { incident: Incident }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['aiops-status-updates', incident.id], queryFn: () => api.get<{ items: StatusUpdate[] }>(`/aiops/incidents/${incident.id}/status-updates`) });
  const [phase, setPhase] = useState<Phase>('investigating');
  const [impact, setImpact] = useState<StatusLevel>(incident.severity === 'critical' ? 'major_outage' : 'degraded_performance');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const items = q.data?.items ?? [];
  const first = items.length === 0;
  const [note, setNote] = useState<string[]>([]);
  const post = useMutation({
    mutationFn: () => api.post(`/aiops/incidents/${incident.id}/status-updates`, { status: phase, impact, message, ...(first ? { title } : {}) }, { silent: true }),
    onSuccess: () => { toast.success('Đã đăng lên trang trạng thái'); setMessage(''); setNote([]); void qc.invalidateQueries({ queryKey: ['aiops-status-updates', incident.id] }); },
    // bộ lọc phía server chặn thông tin nội bộ (tên service, pod, IP, alert…) — hiện rõ từng chỗ để viết lại
    onError: (e) => {
      const problems = e instanceof ApiError ? ((e.details as { problems?: string[] } | undefined)?.problems ?? []) : [];
      setNote(problems);
      toast.error(problems.length ? 'Thông báo chứa thông tin nội bộ — xem chi tiết bên dưới' : errorMessage(e));
    },
  });
  const draft = useMutation({
    mutationFn: () => api.get<{ title: string; message: string; impact: StatusLevel; provider: string; llm_rejected: string[] }>(`/aiops/incidents/${incident.id}/status-draft`, { phase }),
    onSuccess: (d) => {
      if (first) setTitle(d.title);
      setMessage(d.message); setImpact(d.impact);
      setNote(d.llm_rejected.length ? [`Bản LLM bị loại (${d.llm_rejected.join('; ')}) — dùng bản mẫu an toàn`] : []);
    },
  });
  return (
    <section className="mb-4">
      <SectionTitle action={<a href="/status" target="_blank" rel="noreferrer" className="text-sm text-primary underline">Xem /status</a>}>Thông báo công khai</SectionTitle>
      {items.length > 0 && (
        <ol className="mb-3 flex flex-col gap-2 border-l-2 border-border pl-3">
          {[...items].reverse().map((u) => (
            <li key={u.id} className="text-sm">
              <p className="break-words"><b>{PHASE[u.status]}</b>{u.impact && ` · ${STATUS_LEVEL[u.impact].label}`} — {u.message}</p>
              <p className="text-xs text-muted break-all">{u.author}</p>
            </li>
          ))}
        </ol>
      )}
      <Card className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Giai đoạn" htmlFor="pc-phase">
            <Select id="pc-phase" value={phase} onChange={(e) => setPhase(e.target.value as Phase)}>
              {(Object.keys(PHASE) as Phase[]).map((p) => <option key={p} value={p}>{PHASE[p]}</option>)}
            </Select>
          </Field>
          <Field label="Mức ảnh hưởng tới khách" htmlFor="pc-impact">
            <Select id="pc-impact" value={impact} onChange={(e) => setImpact(e.target.value as StatusLevel)}>
              {(['degraded_performance', 'partial_outage', 'major_outage'] as StatusLevel[]).map((l) => <option key={l} value={l}>{STATUS_LEVEL[l].label}</option>)}
            </Select>
          </Field>
        </div>
        {first && (
          <Field label="Tiêu đề công khai" htmlFor="pc-title" hint="Viết cho khách đọc — không dùng tên alert/service nội bộ">
            <Input id="pc-title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="vd: Thanh toán bằng thẻ đang gián đoạn" />
          </Field>
        )}
        {note.length > 0 && (
          <ul className="list-disc space-y-0.5 rounded-lg bg-warning-soft py-2 pl-6 pr-2 text-sm">{note.map((n) => <li key={n} className="break-words">{n}</li>)}</ul>
        )}
        <Field label="Nội dung" htmlFor="pc-msg" hint={`${message.length}/2000`}>
          <Textarea id="pc-msg" rows={3} value={message} maxLength={2000} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setMessage(TEMPLATE[phase])}>Dùng mẫu</Button>
          <Button variant="outline" onClick={() => draft.mutate()} disabled={draft.isPending}><Bot className="size-4" />Tác tử soạn nháp</Button>
          <Button onClick={() => post.mutate()} disabled={post.isPending || message.trim().length < 10 || (first && !title.trim())}>Đăng</Button>
        </div>
      </Card>
    </section>
  );
}

interface RunbookHit { runbook: string; title: string; section: string; file: string; score: number; text: string; fix: string }

/** Runbook-as-code gợi ý cho sự cố (khớp alert/service + TF-IDF) — người trực thấy ngay bước khắc phục đã được review. */
function SuggestedRunbooks({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['aiops-runbooks', id], retry: false, queryFn: () => api.get<{ items: RunbookHit[] }>(`/aiops/incidents/${id}/runbooks`) });
  const items = (q.data?.items ?? []).filter((r) => r.score >= 0.3);
  if (!items.length) return null;
  return (
    <section className="mb-4">
      <SectionTitle>Runbook gợi ý</SectionTitle>
      <ul className="flex flex-col gap-2">
        {items.map((r) => (
          <li key={r.runbook + r.section} className="rounded-xl border border-border p-3 text-sm">
            <div className="flex flex-wrap items-start gap-2">
              <span className="min-w-0 flex-1 break-words font-medium">{r.runbook} · {r.title}</span>
              <Badge tone={r.score >= 0.5 ? 'success' : 'neutral'}>khớp {Math.min(100, Math.round(r.score * 100))}%</Badge>
            </div>
            {r.fix && <p className="mt-1 break-words"><b>Khắc phục:</b> {r.fix}</p>}
            <p className="mt-1 break-all text-xs text-muted">{r.file} · mục “{r.section}”</p>
          </li>
        ))}
      </ul>
    </section>
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

interface SloItem { slo: string; objective?: number | null; burn_rate?: number | null; budget_remaining?: number | null; budget_eta_hours?: number | null; state: 'exhausted' | 'fast_burn' | 'at_risk' | 'healthy'; services: string[] }
const SLO_STATE: Record<SloItem['state'], { label: string; tone: Tone }> = {
  exhausted: { label: 'Hết error budget', tone: 'danger' }, fast_burn: { label: 'Đốt nhanh', tone: 'danger' },
  at_risk: { label: 'Có rủi ro', tone: 'warning' }, healthy: { label: 'Khoẻ', tone: 'success' },
};

interface SynStep { step: string; service: string | null; ok: boolean | null; p95_s: number | null }
interface SynLoc { location: string; ok: boolean | null; stale: boolean; stale_s: number | null; availability_24h: number | null; failed_step: string | null; steps: SynStep[] }
const STEP_LABEL: Record<string, string> = { home: 'Trang chủ', search: 'Tìm kiếm', product: 'Sản phẩm', cart_add: 'Thêm giỏ', cart_view: 'Xem giỏ', cart_remove: 'Xoá giỏ' };

/** Robot đi hành trình mua hàng mỗi phút ở từng cụm (dừng trước checkout để không sinh đơn/bút toán thật). */
function SyntheticJourney() {
  const q = useQuery({ queryKey: ['aiops-synthetic'], retry: false, refetchInterval: 60_000,
    queryFn: () => api.get<{ locations: SynLoc[]; diverged: boolean; hint: string | null }>('/aiops/synthetic/status') });
  if (!q.data?.locations.length) return null;
  const d = q.data;
  return (
    <section className="mb-4">
      <SectionTitle>Hành trình mua hàng tổng hợp</SectionTitle>
      {d.diverged && <Card className="mb-2 border-warning p-3 text-sm break-words">{d.hint}</Card>}
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {d.locations.map((l) => (
          <li key={l.location} className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{l.location}</span>
              {l.stale ? <Badge tone="warning">Robot im {Math.round((l.stale_s ?? 0) / 60)} phút</Badge>
                : <Badge tone={l.ok ? 'success' : 'danger'}>{l.ok ? 'Trót lọt' : `Hỏng ở ${STEP_LABEL[l.failed_step ?? ''] ?? l.failed_step}`}</Badge>}
            </div>
            <ol className="mt-2 flex flex-wrap gap-1.5">
              {l.steps.map((st) => (
                <li key={st.step} title={st.service ?? undefined}>
                  <Badge tone={st.ok == null ? 'neutral' : st.ok ? 'success' : 'danger'}>
                    {STEP_LABEL[st.step] ?? st.step}{st.p95_s != null && ` · ${Math.round(st.p95_s * 1000)}ms`}
                  </Badge>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-muted">Khả dụng 24h: {l.availability_24h == null ? '—' : (l.availability_24h * 100).toFixed(2) + '%'} · p95 tính trên 30 phút</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Trạng thái SLO (Sloth): hết budget → chính sách đóng băng thay đổi không khẩn cấp (chấm rủi ro thay đổi ép mức high). */
function Slo() {
  const q = useQuery({ queryKey: ['aiops-slo'], retry: false, refetchInterval: 60_000, queryFn: () => api.get<{ items: SloItem[] }>('/aiops/slo/status') });
  const pct = (v?: number | null) => (v == null ? '—' : (v * 100).toFixed(v >= 0.99 ? 1 : 0) + '%');
  return (
    <>
      <SyntheticJourney />
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Chưa có SLO" description="Sloth chưa sinh recording rule hoặc Prometheus chưa sẵn sàng." />}>
        {(d) => (
          <DataTable rows={d.items} rowKey={(i) => i.slo}
            columns={[
              { key: 'slo', header: 'SLO', primary: true, cell: (i) => <span className="font-mono text-sm break-all">{i.slo}</span> },
              { key: 'st', header: 'Trạng thái', badge: true, cell: (i) => <Badge tone={SLO_STATE[i.state].tone}>{SLO_STATE[i.state].label}</Badge> },
              { key: 'obj', header: 'Mục tiêu', align: 'right', cell: (i) => pct(i.objective) },
              { key: 'burn', header: 'Tốc độ đốt', align: 'right', cell: (i) => (i.burn_rate == null ? '—' : <span className={i.burn_rate > 1 ? 'text-danger' : ''}>{i.burn_rate.toFixed(2)}×</span>) },
              { key: 'rem', header: 'Budget còn lại', align: 'right', cell: (i) => <b className={(i.budget_remaining ?? 1) <= 0 ? 'text-danger' : ''}>{pct(i.budget_remaining)}</b> },
              // dự báo Theil–Sen 24h: còn bao lâu thì cạn budget (không giảm → không có dự báo)
              { key: 'eta', header: 'Cạn sau', align: 'right', cell: (i) => (i.budget_eta_hours == null ? <span className="text-muted">—</span>
                : <b className={i.budget_eta_hours < 48 ? 'text-danger' : i.budget_eta_hours < 168 ? 'text-warning' : ''}>
                  {i.budget_eta_hours < 48 ? `${Math.round(i.budget_eta_hours)} giờ` : `${(i.budget_eta_hours / 24).toFixed(1)} ngày`}</b>) },
              { key: 'svc', header: 'Service ràng buộc', hideOnMobile: true, cell: (i) => <span className="text-xs">{i.services.join(', ') || '—'}</span> },
            ]} />
        )}
      </QueryView>
      <SellerSla />
      <SloSuggestions />
    </>
  );
}

interface SlaItem { component: string; name: string; target: number; uptime: number; met: boolean; credit_pct: number; minutes_lost: number }

/** Cam kết SLA với người bán: uptime tháng vs hợp đồng → hoàn % phí hoa hồng, ghi sổ cái (5213/33311/331) khi tháng đã chốt. */
function SellerSla() {
  const qc = useQueryClient();
  const months = Array.from({ length: 3 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7); });
  const [period, setPeriod] = useState(months[1]);
  const q = useQuery({ queryKey: ['aiops-sla', period], retry: false, queryFn: () => api.get<{ period: string; final: boolean; items: SlaItem[] }>('/aiops/sla/report', { period }) });
  const apply = useMutation({
    mutationFn: () => api.post<{ applied: { component: string; total: number; entryNo: string | null; created: boolean }[] }>(`/aiops/sla/credits/${period}/apply`),
    onSuccess: (r) => {
      const total = r.applied.reduce((a, x) => a + x.total, 0);
      toast.success(r.applied.length ? `Đã ghi hoàn phí ${formatVND(total)} (${r.applied.map((x) => x.entryNo).join(', ')})` : 'Không có nhóm nào dưới cam kết');
      void qc.invalidateQueries({ queryKey: ['aiops-sla', period] });
    },
  });
  if (!q.data?.items.length) return null;
  const d = q.data;
  const due = d.items.some((i) => !i.met && i.credit_pct > 0);
  return (
    <section className="mt-6">
      <SectionTitle>Cam kết SLA với người bán</SectionTitle>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Tabs className="min-w-0 flex-1" value={period} onChange={setPeriod} items={months.map((m) => ({ value: m, label: `Tháng ${m.slice(5)}/${m.slice(0, 4)}` }))} />
        <Button onClick={() => apply.mutate()} disabled={!d.final || !due || apply.isPending}>{d.final ? 'Ghi hoàn phí vào sổ' : 'Tháng chưa chốt'}</Button>
      </div>
      <DataTable rows={d.items} rowKey={(i) => i.component}
        columns={[
          { key: 'name', header: 'Nhóm chức năng', primary: true, cell: (i) => <span className="break-words">{i.name}</span> },
          { key: 'st', header: 'Trạng thái', badge: true, cell: (i) => (i.met ? <Badge tone="success">Đạt cam kết</Badge> : <Badge tone="danger">Hoàn {Math.round(i.credit_pct * 100)}% hoa hồng</Badge>) },
          { key: 'up', header: 'Uptime', align: 'right', cell: (i) => <b className={i.met ? '' : 'text-danger'}>{(i.uptime * 100).toFixed(3)}%</b> },
          { key: 'tg', header: 'Cam kết', align: 'right', cell: (i) => (i.target * 100).toFixed(1) + '%' },
          { key: 'lost', header: 'Phút gián đoạn', align: 'right', hideOnMobile: true, cell: (i) => formatNumber(Math.round(i.minutes_lost)) },
        ]} />
      <p className="mt-2 text-xs text-muted">Uptime tính như trang trạng thái (gián đoạn 100%, một phần 30%). Hoàn phí = % × hoa hồng chưa thuế của từng shop trong kỳ; ghi Nợ 5213 + 33311 / Có 331 — gọi lại không ghi đôi.</p>
    </section>
  );
}

interface SloSuggestion { service: string; days: number; achieved: number | null; daily_p10: number | null; current: number | null; suggested: number | null; verdict: 'too_strict' | 'too_loose' | 'no_slo' | 'ok' | 'insufficient'; snippet: string | null }
const VERDICT: Record<SloSuggestion['verdict'], { label: string; tone: Tone }> = {
  too_strict: { label: 'Quá chặt', tone: 'danger' }, no_slo: { label: 'Chưa có SLO', tone: 'warning' }, too_loose: { label: 'Quá lỏng', tone: 'info' },
  ok: { label: 'Hợp lý', tone: 'success' }, insufficient: { label: 'Thiếu dữ liệu', tone: 'neutral' },
};

/** Gợi ý mục tiêu SLO từ 28 ngày dữ liệu: bậc số 9 cao nhất mà 90% số ngày đã đạt. */
function SloSuggestions() {
  const q = useQuery({ queryKey: ['aiops-slo-suggest'], retry: false, queryFn: () => api.get<{ items: SloSuggestion[] }>('/aiops/slo/suggest') });
  if (!q.data?.items.length) return null;
  const p = (v: number | null) => (v == null ? '—' : (v * 100).toFixed(v >= 0.999 ? 3 : 2) + '%');
  const copy = (txt: string) => { void navigator.clipboard?.writeText(txt).then(() => toast.success('Đã chép YAML Sloth'), () => toast.error('Không chép được')); };
  return (
    <section className="mt-6">
      <SectionTitle>Đề xuất mục tiêu SLO (28 ngày)</SectionTitle>
      <p className="-mt-2 mb-3 text-sm text-muted">Đề xuất = bậc số 9 cao nhất mà ≥ 90% số ngày đã đạt — mục tiêu theo năng lực thật, tránh SLO đốt budget liên tục hoặc không bao giờ dùng tới.</p>
      <DataTable rows={q.data.items} rowKey={(i) => i.service}
        columns={[
          { key: 'svc', header: 'Service', primary: true, cell: (i) => <span className="font-mono text-sm">{i.service}</span> },
          { key: 'v', header: 'Kết luận', badge: true, cell: (i) => <Badge tone={VERDICT[i.verdict].tone}>{VERDICT[i.verdict].label}</Badge> },
          { key: 'ach', header: 'Thực tế', align: 'right', cell: (i) => p(i.achieved) },
          { key: 'cur', header: 'Hiện tại → Đề xuất', align: 'right', cell: (i) => <span>{p(i.current)} → <b>{p(i.suggested)}</b></span> },
          { key: 'p10', header: 'Ngày xấu (p10)', align: 'right', hideOnMobile: true, cell: (i) => p(i.daily_p10) },
          { key: 'yaml', header: '', cell: (i) => (i.snippet ? <Button size="sm" variant="outline" onClick={() => copy(i.snippet!)}>Chép YAML</Button> : null) },
        ]} />
    </section>
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
      <RightSizing />
      <CostAllocation />
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

interface CloseCheck { key: string; title: string; status: 'ok' | 'warn' | 'fail' | 'unknown'; value: number | null; hint: string }
interface PeriodCloseStatus { period: string; services: string[]; close_days: number; active: boolean; ready: boolean; fail: number; warn: number; unknown: number;
  windows: { period: string; starts: number; ends: number; active: boolean }[]; checks: CloseCheck[] }

const CLOSE_TONE: Record<CloseCheck['status'], Tone> = { ok: 'success', warn: 'warning', fail: 'danger', unknown: 'neutral' };
const CLOSE_LABEL: Record<CloseCheck['status'], string> = { ok: 'Đạt', warn: 'Lưu ý', fail: 'Chặn', unknown: 'Chưa rõ' };

/** Khoá sổ cuối kỳ: khung đóng băng deploy chạm service tài chính + danh sách kiểm sẵn sàng khoá sổ từ số liệu vận hành. */
function PeriodClose() {
  const q = useQuery({ queryKey: ['aiops-period-close'], retry: false, refetchInterval: 300_000,
    queryFn: () => api.get<PeriodCloseStatus>('/aiops/period-close') });
  const d = q.data;
  if (!d) return null;
  const ts = (t: number) => formatDate(new Date(t * 1000).toISOString());
  return (
    <Card className={'flex flex-col gap-3 p-3 text-sm' + (d.active ? ' border-warning' : '')}>
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="size-4 shrink-0 text-info" />
        <b className="min-w-0 flex-1 break-words">Khoá sổ kỳ {d.period}{d.active ? ' — đang trong khung khoá sổ' : ''}</b>
        <Badge tone={d.ready ? 'success' : 'danger'}>{d.ready ? 'Sẵn sàng khoá' : 'Chưa sẵn sàng'}</Badge>
      </div>
      <ul className="flex flex-col gap-1 pl-6">
        {d.windows.map((w) => (
          <li key={w.period} className="break-words">
            {w.active ? <b>Đang đóng băng</b> : 'Sắp tới'}: {ts(w.starts)} → {ts(w.ends)} <span className="text-muted">· kỳ {w.period}</span>
          </li>
        ))}
      </ul>
      <p className="pl-6 text-xs text-muted break-words">Deploy chạm {d.services.join(', ')} trong khung (ngày cuối tháng → ngày {d.close_days} tháng sau, giờ VN) bị ép duyệt tay; khẩn cấp có ghi audit. Danh sách dưới kiểm đường ống dữ liệu vận hành, bổ sung checklist sổ sách ở trang Kế toán.</p>
      <ul className="flex flex-col divide-y divide-border">
        {d.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2 py-2">
            <Badge tone={CLOSE_TONE[c.status]} className="mt-0.5">{CLOSE_LABEL[c.status]}</Badge>
            <div className="min-w-0 flex-1">
              <div className="break-words">{c.title}{c.value != null && <b className="ml-1">{formatNumber(c.value)}{c.key === 'reconcile_fresh' ? ' giờ trước' : ''}</b>}</div>
              {c.status !== 'ok' && <div className="break-words text-xs text-muted">{c.hint}</div>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

type MaintStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
interface MaintWindow { id: string; title: string; message: string; services: string[]; starts: number; ends: number; status: MaintStatus; sla_excluded: boolean; silence_id: string | null; created_by: string }
const MAINT: Record<MaintStatus, { label: string; tone: Tone }> = {
  scheduled: { label: 'Sắp diễn ra', tone: 'info' }, in_progress: { label: 'Đang bảo trì', tone: 'warning' },
  completed: { label: 'Đã xong', tone: 'success' }, cancelled: { label: 'Đã huỷ', tone: 'neutral' },
};

/** Bảo trì có kế hoạch: báo trước trên trang trạng thái, silence Alertmanager, trừ khỏi SLA nếu báo trước đủ hạn. */
function MaintenanceWindows() {
  const qc = useQueryClient();
  const [form, setForm] = useState(false);
  const q = useQuery({ queryKey: ['aiops-maint'], retry: false,
    queryFn: () => api.get<{ items: MaintWindow[]; services: string[]; notice_hours: number; max_hours: number }>('/aiops/maintenance') });
  const op = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'complete' }) => api.post(`/aiops/maintenance/${id}/${action}`),
    onSuccess: () => { toast.success('Đã cập nhật, đã gỡ silence'); void qc.invalidateQueries({ queryKey: ['aiops-maint'] }); },
  });
  const d = q.data;
  if (!d) return null;
  const ts = (t: number) => formatDate(new Date(t * 1000).toISOString());
  const live = d.items.filter((w) => w.status === 'scheduled' || w.status === 'in_progress');
  return (
    <Card className="flex flex-col gap-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="size-4 shrink-0 text-info" />
        <b className="min-w-0 flex-1 break-words">Bảo trì có kế hoạch</b>
        <Button size="sm" onClick={() => setForm(true)}>Lên lịch</Button>
      </div>
      {live.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {live.map((w) => (
            <li key={w.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="min-w-0 break-words font-medium">{w.title}</span>
                  <Badge tone={MAINT[w.status].tone}>{MAINT[w.status].label}</Badge>
                  {!w.sla_excluded && <Badge tone="warning">Vẫn tính SLA</Badge>}
                  {!w.silence_id && <Badge tone="danger">Chưa có silence</Badge>}
                </div>
                <p className="break-words text-xs text-muted">{ts(w.starts)} → {ts(w.ends)} · <span className="font-mono">{w.services.join(', ')}</span></p>
              </div>
              {w.status === 'scheduled'
                ? <Button variant="outline" size="sm" className="self-start sm:self-auto" disabled={op.isPending} onClick={() => op.mutate({ id: w.id, action: 'cancel' })}>Huỷ</Button>
                : <Button variant="outline" size="sm" className="self-start sm:self-auto" disabled={op.isPending} onClick={() => op.mutate({ id: w.id, action: 'complete' })}>Kết thúc sớm</Button>}
            </li>
          ))}
        </ul>
      ) : <p className="text-muted">Không có khung bảo trì nào sắp tới.</p>}
      <p className="text-xs text-muted break-words">Báo trước ≥ {d.notice_hours} giờ thì thời gian bảo trì không tính vào uptime/SLA người bán; mỗi khung tối đa {d.max_hours} giờ; không được chồng khung khoá sổ hay đóng băng flash sale của chính service đó.</p>
      {form && <MaintenanceForm services={d.services} onClose={() => setForm(false)} />}
    </Card>
  );
}

function MaintenanceForm({ services, onClose }: { services: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const later = (h: number) => toDateTimeLocal(new Date(Date.now() + h * 3600_000).toISOString());
  const [f, setF] = useState({ title: '', message: '', starts: later(72), ends: later(74), services: [] as string[], emergency: false });
  const create = useMutation({
    mutationFn: () => api.post<{ warnings: string[] }>('/aiops/maintenance', {
      title: f.title, message: f.message, services: f.services, emergency: f.emergency,
      starts: new Date(f.starts).getTime() / 1000, ends: new Date(f.ends).getTime() / 1000,
    }),
    onSuccess: (r) => {
      toast.success('Đã lên lịch bảo trì');
      for (const w of r.warnings ?? []) toast(w);
      void qc.invalidateQueries({ queryKey: ['aiops-maint'] });
      onClose();
    },
  });
  const toggle = (s: string) => setF((x) => ({ ...x, services: x.services.includes(s) ? x.services.filter((y) => y !== s) : [...x.services, s] }));
  return (
    <Sheet open onClose={onClose} title="Lên lịch bảo trì"
      footer={<>
        <Button variant="outline" onClick={onClose}>Huỷ</Button>
        <Button onClick={() => create.mutate()} disabled={create.isPending || !f.title.trim() || f.message.trim().length < 10 || !f.services.length}>Lên lịch</Button>
      </>}>
      <div className="flex flex-col gap-3">
        <Field label="Tiêu đề công khai" htmlFor="mt-title" hint="Khách sẽ đọc — không dùng tên service nội bộ">
          <Input id="mt-title" value={f.title} maxLength={160} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="vd: Nâng cấp hệ thống thanh toán" />
        </Field>
        <Field label="Lời nhắn cho khách" htmlFor="mt-msg">
          <Textarea id="mt-msg" rows={3} value={f.message} maxLength={2000} onChange={(e) => setF({ ...f, message: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Bắt đầu" htmlFor="mt-start"><Input id="mt-start" type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></Field>
          <Field label="Kết thúc" htmlFor="mt-end"><Input id="mt-end" type="datetime-local" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></Field>
        </div>
        <Field label="Service bị ảnh hưởng">
          <div className="flex flex-wrap gap-2">
            {services.map((s) => (
              <button key={s} type="button" aria-pressed={f.services.includes(s)} onClick={() => toggle(s)}
                className={'min-h-11 rounded-full border px-3 font-mono text-sm ' + (f.services.includes(s) ? 'border-primary bg-primary-soft text-primary' : 'border-border')}>{s}</button>
            ))}
          </div>
        </Field>
        <Checkbox checked={f.emergency} onChange={(v) => setF({ ...f, emergency: v })} label="Khẩn cấp: cho phép chồng khung đóng băng (ghi audit, phải có postmortem)" />
      </div>
    </Sheet>
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
      <PeriodClose />
      <MaintenanceWindows />
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

interface RsItem {
  service: string; replicas: number; days_of_data: number; enough_data: boolean; direction: 'increase' | 'decrease' | 'keep';
  usage: { cpu_p95_m: number; mem_max_mi: number }; current: { cpu_m: number; mem_mi: number }; recommended: { cpu_m: number; mem_mi: number };
  monthly_saving_usd: number; staged: boolean; mem_capped_at_limit: boolean;
}
const RS_DIR: Record<RsItem['direction'], { label: string; tone: Tone }> = {
  decrease: { label: 'Giảm', tone: 'success' }, increase: { label: 'Tăng (đang thiếu)', tone: 'warning' }, keep: { label: 'Giữ', tone: 'neutral' },
};

/** Right-sizing: requests khai báo vs dùng thật 7 ngày → đề xuất + tiết kiệm; mở PR GitOps qua cổng xác minh (người duyệt). */
interface AllocItem { service: string; site: 'cloud' | 'onprem'; cost_center: 'sales' | 'admin'; direct_usd: number; shared_usd: number; total_usd: number; total_vnd: number }
interface AllocReport { period: string; final: boolean; hours: number; fx_vnd_per_usd: number; items: AllocItem[];
  totals: { cloud_usd: number; onprem_usd: number; sales_usd: number; admin_usd: number }; posted: { total_vnd: number; entry_no: number | null } | null }

/** Phân bổ chi phí hạ tầng theo service (OpenCost) → trích trước chi phí cloud vào sổ (Nợ 6417/6427 / Có 335). */
function CostAllocation() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['aiops-alloc'], retry: false, queryFn: () => api.get<AllocReport>('/aiops/finops/allocation') });
  const post = useMutation({
    mutationFn: (p: string) => api.post<{ total: number; entryNo: number | null }>(`/aiops/finops/allocation/${p}/post`),
    onSuccess: (r) => {
      toast.success(`Đã trích trước ${formatVND(r.total)}${r.entryNo ? ` (bút toán #${r.entryNo})` : ''}`);
      void qc.invalidateQueries({ queryKey: ['aiops-alloc'] });
    },
  });
  const d = q.data;
  if (!d) return null;
  const usd = (v: number) => `$${formatNumber(v)}`;
  const status = d.posted
    ? `Đã ghi sổ ${formatVND(d.posted.total_vnd)}${d.posted.entry_no ? ` (bút toán #${d.posted.entry_no})` : ''}.`
    : d.final ? 'Chưa ghi sổ.' : 'Kỳ chưa kết thúc — số liệu tạm tính.';
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle action={d.final && !d.posted && d.totals.cloud_usd > 0
        ? <Button size="sm" onClick={() => post.mutate(d.period)} disabled={post.isPending}>Ghi trích trước</Button> : undefined}>
        Phân bổ chi phí hạ tầng kỳ {d.period}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Cloud (ghi sổ)" value={usd(d.totals.cloud_usd)} />
        <Stat label="On-prem (showback)" value={usd(d.totals.onprem_usd)} />
        <Stat label="Bán hàng · TK 6417" value={usd(d.totals.sales_usd)} />
        <Stat label="Quản lý · TK 6427" value={usd(d.totals.admin_usd)} />
      </div>
      <p className="text-sm text-muted break-words">
        Chi phí trực tiếp = core-giờ, GiB-giờ cấp phát (OpenCost) × đơn giá; phần dùng chung (giám sát, GitOps, quét bảo mật) chia theo tỉ lệ chi phí trực tiếp.
        Chỉ phần cloud được trích trước (hoá đơn về sau khoá sổ); on-prem đã nằm trong khấu hao nên chỉ hiển thị. Tỉ giá {formatNumber(d.fx_vnd_per_usd)} VND/USD. {status}
      </p>
      <DataTable rows={d.items} rowKey={(i) => i.service + i.site}
        columns={[
          { key: 'svc', header: 'Service', primary: true, cell: (i) => <span className="font-mono text-sm">{i.service}</span> },
          { key: 'site', header: 'Vị trí', badge: true, cell: (i) => <Badge tone={i.site === 'cloud' ? 'info' : 'neutral'}>{i.site === 'cloud' ? 'Cloud' : 'On-prem'}</Badge> },
          { key: 'cc', header: 'Trung tâm chi phí', cell: (i) => (i.cost_center === 'sales' ? 'Bán hàng (6417)' : 'Quản lý (6427)') },
          { key: 'direct', header: 'Trực tiếp', align: 'right', hideOnMobile: true, cell: (i) => usd(i.direct_usd) },
          { key: 'shared', header: 'Dùng chung', align: 'right', hideOnMobile: true, cell: (i) => usd(i.shared_usd) },
          { key: 'total', header: 'Tổng', align: 'right', cell: (i) => <span><b>{usd(i.total_usd)}</b> <span className="text-xs text-muted">≈ {formatVND(i.total_vnd)}</span></span> },
        ]} />
    </section>
  );
}

function RightSizing() {
  const q = useQuery({ queryKey: ['aiops-rightsizing'], retry: false, queryFn: () => api.get<{ monthly_saving_usd: number; items: RsItem[] }>('/aiops/finops/rightsizing') });
  const pr = useMutation({
    mutationFn: (svc: string) => api.post<{ status: string; url?: string; dry_run?: boolean; problems?: string[] }>(`/aiops/finops/rightsizing/${svc}/propose-pr`),
    onSuccess: (r) => {
      if (r.status === 'proposed') toast.success(r.dry_run ? 'Đã tạo bản vá (dry-run, chưa có token GitHub)' : 'Đã mở PR GitOps — chờ duyệt');
      else toast.error(`Cổng xác minh chặn: ${(r.problems ?? []).join('; ')}`);
    },
  });
  const res = (cpu: number, mem: number) => `${cpu}m · ${mem}Mi`;
  if (!q.data?.items.length) return null;
  const d = q.data;
  return (
    <section className="mt-6">
      <SectionTitle>Right-sizing tài nguyên (7 ngày)</SectionTitle>
      <p className="-mt-2 mb-3 text-sm text-muted break-words">
        Tiết kiệm ước tính <b className="text-success">${d.monthly_saving_usd.toFixed(2)}/tháng</b> nếu áp dụng các đề xuất.
        Quy tắc: p95 CPU × 1,2 · đỉnh RAM × 1,15 · giảm tối đa 50%/lần · cần ≥ 3 ngày dữ liệu.
      </p>
      <DataTable rows={d.items} rowKey={(i) => i.service}
        columns={[
          { key: 'svc', header: 'Service', primary: true, cell: (i) => <span className="font-mono text-sm">{i.service}</span> },
          { key: 'dir', header: 'Đề xuất', badge: true, cell: (i) => <Badge tone={RS_DIR[i.direction].tone}>{RS_DIR[i.direction].label}{i.staged ? ' · nấc 1' : ''}</Badge> },
          { key: 'cur', header: 'Đang khai', cell: (i) => res(i.current.cpu_m, i.current.mem_mi) },
          { key: 'use', header: 'Dùng thật', hideOnMobile: true, cell: (i) => <span className="text-muted">{res(i.usage.cpu_p95_m, i.usage.mem_max_mi)}</span> },
          { key: 'rec', header: 'Mức mới', cell: (i) => (i.direction === 'keep' ? '—' : <b>{res(i.recommended.cpu_m, i.recommended.mem_mi)}</b>) },
          { key: 'save', header: 'USD/tháng', align: 'right', cell: (i) => (i.direction === 'keep'
            ? (i.enough_data ? '—' : <span className="text-xs text-muted">mới {i.days_of_data} ngày dữ liệu</span>)
            : <b className={i.monthly_saving_usd >= 0 ? 'text-success' : 'text-warning'}>{i.monthly_saving_usd >= 0 ? '−' : '+'}${Math.abs(i.monthly_saving_usd).toFixed(2)}</b>) },
          { key: 'pr', header: 'PR', cell: (i) => (i.direction === 'keep' ? null
            : <Button size="sm" variant="outline" onClick={() => pr.mutate(i.service)} disabled={pr.isPending}><GitPullRequest className="size-4" />Mở PR</Button>) },
        ]} />
    </section>
  );
}

interface DrillPlanItem { id: string; title: string; file: string; chaos: string | null; mode: 'chaos' | 'tabletop'; days_since: number | null; overdue: boolean; command: string | null }
interface Drill { id: string; runbook: string; chaos: string | null; mode: string; environment: string; status: 'running' | 'completed' | 'aborted'; started_by: string; started_at: number; detected_at: number | null; mitigated_at: number | null; resolved_at: number | null; followed_runbook: number | null; ttd_s: number | null; ttm_s: number | null; ttr_s: number | null }
interface DrillSummary { drills: number; ttd_median_s: number | null; ttr_median_s: number | null; real_mttr_median_s: number | null; runbook_followed_ratio: number | null }
const mins = (s: number | null | undefined) => (s == null ? '—' : s < 60 ? `${Math.round(s)} giây` : `${Math.round(s / 60)} phút`);

/** Diễn tập sự cố (game day): chống mất kỹ năng khi tự động hoá nhiều — mỗi runbook tập lại định kỳ, đo như sự cố thật. */
function Drills() {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['aiops-drill-plan'], queryFn: () => api.get<{ cadence_days: number; overdue: number; suggested: string[]; items: DrillPlanItem[] }>('/aiops/drills/plan') });
  const list = useQuery({ queryKey: ['aiops-drills'], refetchInterval: 15_000, queryFn: () => api.get<{ items: Drill[]; summary: DrillSummary }>('/aiops/drills') });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['aiops-drills'] }); void qc.invalidateQueries({ queryKey: ['aiops-drill-plan'] }); };
  const start = useMutation({ mutationFn: (runbook: string) => api.post('/aiops/drills', { runbook, environment: 'staging' }), onSuccess: () => { toast.success('Đã bắt đầu diễn tập (staging)'); refresh(); } });
  const mark = useMutation({ mutationFn: (a: { id: string; event: string }) => api.post(`/aiops/drills/${a.id}/mark`, { event: a.event }), onSuccess: refresh });
  const done = useMutation({ mutationFn: (a: { id: string; followed: boolean }) => api.post(`/aiops/drills/${a.id}/complete`, { followed_runbook: a.followed }), onSuccess: () => { toast.success('Đã kết thúc diễn tập'); refresh(); } });
  const running = list.data?.items.find((d) => d.status === 'running');
  const sm = list.data?.summary;
  const next = running ? (!running.detected_at ? 'detected' : !running.mitigated_at ? 'mitigated' : !running.resolved_at ? 'resolved' : null) : null;
  const LABEL: Record<string, string> = { detected: 'Đã phát hiện', mitigated: 'Đã giảm thiểu', resolved: 'Đã khôi phục' };
  return (
    <div className="flex flex-col gap-4">
      {sm && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Buổi đã tập" value={String(sm.drills)} />
          <Stat label="Phát hiện (trung vị)" value={mins(sm.ttd_median_s)} />
          <Stat label="Khôi phục diễn tập / thật" value={`${mins(sm.ttr_median_s)} / ${mins(sm.real_mttr_median_s)}`} />
          <Stat label="Làm đúng runbook" value={sm.runbook_followed_ratio == null ? '—' : Math.round(sm.runbook_followed_ratio * 100) + '%'} />
        </div>
      )}
      {running && (
        <Card className="flex flex-col gap-2 border-warning p-3 text-sm">
          <p className="break-words"><b>Đang diễn tập {running.runbook}</b> ({running.mode === 'chaos' ? `chaos ${running.chaos}` : 'trên bàn'}, {running.environment}) — bởi {running.started_by}</p>
          <p className="text-muted">Phát hiện {mins(running.ttd_s)} · giảm thiểu {mins(running.ttm_s)} · khôi phục {mins(running.ttr_s)}</p>
          <div className="flex flex-wrap gap-2">
            {next && <Button onClick={() => mark.mutate({ id: running.id, event: next })} disabled={mark.isPending}>{LABEL[next]}</Button>}
            {!next && <>
              <Button onClick={() => done.mutate({ id: running.id, followed: true })} disabled={done.isPending}>Kết thúc — làm đúng runbook</Button>
              <Button variant="outline" onClick={() => done.mutate({ id: running.id, followed: false })} disabled={done.isPending}>Kết thúc — lệch runbook</Button>
            </>}
          </div>
        </Card>
      )}
      <QueryView q={plan}>
        {(p) => (
          <section>
            <SectionTitle>Kế hoạch diễn tập (chu kỳ {p.cadence_days} ngày)</SectionTitle>
            <p className="-mt-2 mb-3 text-sm text-muted">{p.overdue} runbook chưa tập hoặc quá chu kỳ. Diễn tập chạy ở staging để không làm sai MTTR/DORA/SLA của prod.</p>
            <DataTable rows={p.items} rowKey={(i) => i.id}
              columns={[
                { key: 'rb', header: 'Runbook', primary: true, cell: (i) => <span className="break-words"><b>{i.id}</b> · {i.title}</span> },
                { key: 'st', header: 'Trạng thái', badge: true, cell: (i) => (i.overdue ? <Badge tone="warning">{i.days_since == null ? 'Chưa từng tập' : `Quá hạn (${Math.round(i.days_since)} ngày)`}</Badge> : <Badge tone="success">{Math.round(i.days_since ?? 0)} ngày trước</Badge>) },
                { key: 'how', header: 'Cách tập', hideOnMobile: true, cell: (i) => (i.command ? <code className="break-all text-xs">{i.command}</code> : <span className="text-muted">Diễn tập trên bàn</span>) },
                { key: 'go', header: '', cell: (i) => <Button size="sm" variant="outline" disabled={!!running || start.isPending} onClick={() => start.mutate(i.id)}>Bắt đầu</Button> },
              ]} />
          </section>
        )}
      </QueryView>
    </div>
  );
}

interface OnCallPerson { name: string; handle?: string }
interface OnCallShift { start: number; end: number; primary: OnCallPerson; secondary: OnCallPerson; override: boolean }

/** Lịch trực luân phiên: ai đang trực chính/phụ, khi nào đổi ca, sự cố chưa ai nhận (leo thang sau N phút). */
function OnCall() {
  const q = useQuery({ queryKey: ['aiops-oncall'], refetchInterval: 60_000, retry: false,
    queryFn: () => api.get<{ current: OnCallShift | null; schedule: OnCallShift[]; escalate_after_minutes: number; unacknowledged: number }>('/aiops/oncall') });
  const d = q.data;
  if (!d?.current) return null;
  const day = (t: number) => formatDate(new Date(t * 1000).toISOString());
  return (
    <Card className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-words">Đang trực: <b>{d.current.primary.name}</b> {d.current.primary.handle} · phụ <b>{d.current.secondary.name}</b>{d.current.override && <Badge className="ml-1" tone="info">đổi ca</Badge>}</span>
        <Badge tone={d.unacknowledged ? 'danger' : 'success'}>{d.unacknowledged} sự cố chưa ai nhận</Badge>
      </div>
      <p className="text-xs text-muted">Hết ca {day(d.current.end)} · chưa ai nhận quá {d.escalate_after_minutes} phút → tự báo người trực phụ.</p>
      <ol className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
        {d.schedule.map((s) => <li key={s.start} className="break-words"><span className="text-muted">{day(s.start)}:</span> {s.primary.name} / {s.secondary.name}</li>)}
      </ol>
    </Card>
  );
}

interface VulnItem { workload: string; container: string; image: string; vuln_id: string; severity: string; pkg: string; installed: string; fixed: string; title: string; age_days: number; sla_days: number | null; fixable: boolean; breach: boolean; due_in_days: number | null; priority: 'P1' | 'P2' | 'P3'; reasons: string[]; kev: boolean; kev_ransomware: boolean; epss: number | null; epss_percentile: number | null; needs_mitigation: boolean }

/** SLA vá lỗ hổng của workload ĐANG CHẠY (Trivy Operator): CVE công bố sau khi deploy thì chỉ quét liên tục mới thấy. */
function Security() {
  const q = useQuery({ queryKey: ['aiops-vulns'], retry: false, queryFn: () => api.get<{ sla_days: Record<string, number>; policy: { kev_days: number; epss_threshold: number; epss_days: number }; open_by_severity: Record<string, number>; open_by_priority: Record<string, number>; breaches: Record<string, number>; kev_open: number; needs_mitigation: number; threat_intel_updated_at: number | null; mttr_days: number | null; items: VulnItem[] }>('/aiops/security/vulns') });
  return (
    <QueryView q={q} isEmpty={(d) => !d.items.length}
      empty={<EmptyState icon={<ShieldAlert className="size-6" />} title="Chưa có lỗ hổng nào trên workload đang chạy" description="Trivy Operator quét liên tục namespace shopnow; CronJob vuln-sync đồng bộ mỗi giờ." />}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Đang bị khai thác (KEV)" value={d.needs_mitigation ? `${d.kev_open} · ${d.needs_mitigation} chưa vá được` : String(d.kev_open)} tone={d.kev_open ? 'danger' : 'success'} />
            <Stat label="Mở: CRITICAL / HIGH" value={`${d.open_by_severity.CRITICAL ?? 0} / ${d.open_by_severity.HIGH ?? 0}`} />
            <Stat label="Quá hạn SLA vá" value={String(Object.values(d.breaches).reduce((a, b) => a + b, 0))} tone={Object.keys(d.breaches).length ? 'danger' : 'success'} />
            <Stat label="Thời gian vá (trung vị)" value={d.mttr_days == null ? '—' : `${d.mttr_days} ngày`} />
          </div>
          <p className="text-sm text-muted">SLA vá: CRITICAL {d.sla_days.CRITICAL} ngày, HIGH {d.sla_days.HIGH} ngày; rút ngắn theo rủi ro thật: CISA KEV {d.policy.kev_days} ngày (từ lúc vào danh mục), EPSS ≥ {d.policy.epss_threshold} còn {d.policy.epss_days} ngày. Chỉ tính lỗ hổng đã có bản sửa; tuổi không bị reset khi deploy lại hay rollback. Tình báo cập nhật: {d.threat_intel_updated_at ? timeAgo(new Date(d.threat_intel_updated_at * 1000).toISOString()) : 'chưa có'}.</p>
          <DataTable rows={d.items} rowKey={(i) => i.workload + i.container + i.vuln_id + i.pkg}
            columns={[
              { key: 'id', header: 'Lỗ hổng', primary: true, cell: (i) => <span className="break-words"><b className="font-mono text-sm">{i.vuln_id}</b> · {i.pkg}</span> },
              { key: 'st', header: 'SLA', badge: true, cell: (i) => (!i.fixable ? <Badge tone="neutral">Chưa có bản sửa</Badge>
                : i.breach ? <Badge tone="danger">Quá hạn {Math.abs(i.due_in_days ?? 0)} ngày</Badge>
                : <Badge tone={(i.due_in_days ?? 99) <= 3 ? 'warning' : 'success'}>Còn {i.due_in_days} ngày</Badge>) },
              { key: 'prio', header: 'Ưu tiên', cell: (i) => (
                <span className="flex flex-wrap items-center gap-1" title={i.reasons.join(' · ')}>
                  <Badge tone={i.priority === 'P1' ? 'danger' : i.priority === 'P2' ? 'warning' : 'neutral'}>{i.priority}</Badge>
                  {i.kev && <Badge tone="danger">KEV{i.kev_ransomware ? ' · ransomware' : ''}</Badge>}
                  {i.needs_mitigation && <Badge tone="warning">Cần biện pháp tạm</Badge>}
                </span>) },
              { key: 'sev', header: 'Mức · EPSS', cell: (i) => <span className="flex items-center gap-1"><Badge tone={i.severity === 'CRITICAL' ? 'danger' : 'warning'}>{i.severity}</Badge>{i.epss != null && <span className="text-xs text-muted">EPSS {(i.epss * 100).toFixed(1)}%</span>}</span> },
              { key: 'svc', header: 'Service', cell: (i) => <span className="font-mono text-xs">{i.workload}</span> },
              { key: 'ver', header: 'Phiên bản → bản sửa', hideOnMobile: true, cell: (i) => <span className="font-mono text-xs break-all">{i.installed} → {i.fixed || '—'}</span> },
              { key: 'img', header: 'Image', hideOnMobile: true, cell: (i) => <span className="font-mono text-xs break-all">{i.image}</span> },
            ]} />
        </div>
      )}
    </QueryView>
  );
}

type ProblemStatus = 'open' | 'known_error' | 'resolved';
interface ProblemItem { id: string; code: string; title: string; status: ProblemStatus; root_service: string; workaround: string | null; fix_ref: string | null; owner: string | null; reopened: number; incidents: number; incidents_recent: number; outage_minutes_recent: number; last_seen: number | null }
interface ProblemCandidate { incident_ids: string[]; count: number; root_service: string; services: string[]; first_seen: number; last_seen: number; outage_minutes: number; title: string; tokens: string[] }
const PROBLEM_STATUS: Record<ProblemStatus, { label: string; tone: Tone }> = {
  open: { label: 'Đang điều tra', tone: 'warning' }, known_error: { label: 'Lỗi đã biết', tone: 'info' }, resolved: { label: 'Đã khắc phục', tone: 'success' },
};
const epochDate = (t: number | null) => (t == null ? '—' : formatDate(new Date(t * 1000).toISOString()));

/** Quản lý vấn đề (ITIL): sự cố lặp → vấn đề → lỗi đã biết (workaround gắn vào sự cố mới) → khắc phục tận gốc; tái phát tự mở lại. */
function Problems() {
  const qc = useQueryClient();
  const [sel, setSel] = useState<ProblemItem | null>(null);
  const q = useQuery({ queryKey: ['aiops-problems'], retry: false,
    queryFn: () => api.get<{ days: number; items: ProblemItem[]; candidates: ProblemCandidate[]; counts: Partial<Record<ProblemStatus, number>> }>('/aiops/problems', { days: 30 }) });
  const open = useMutation({
    mutationFn: (c: ProblemCandidate) => api.post<ProblemItem>('/aiops/problems', { incident_ids: c.incident_ids, title: c.title }),
    onSuccess: (p) => { toast.success(`Đã mở vấn đề ${p.code}`); void qc.invalidateQueries({ queryKey: ['aiops-problems'] }); },
  });
  return (
    <QueryView q={q}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Đang điều tra" value={String(d.counts.open ?? 0)} />
            <Stat label="Lỗi đã biết" value={String(d.counts.known_error ?? 0)} />
            <Stat label="Đã khắc phục" value={String(d.counts.resolved ?? 0)} tone="success" />
            <Stat label="Ứng viên mới" value={String(d.candidates.length)} tone={d.candidates.length ? 'danger' : undefined} />
          </div>
          <p className="text-sm text-muted">Sự cố khôi phục dịch vụ, vấn đề xoá nguyên nhân. Sự cố mới khớp lỗi đã biết sẽ kèm luôn cách xử lý tạm trong bản tin; khớp vấn đề đã khắc phục thì tự mở lại (tái phát).</p>
          {d.candidates.length > 0 && (
            <>
              <SectionTitle>Ứng viên: sự cố lặp {d.days} ngày qua</SectionTitle>
              <ul className="flex flex-col gap-2">
                {d.candidates.map((c) => (
                  <li key={c.incident_ids[0]}>
                    <Card className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-medium">{c.title}</p>
                        <p className="break-words text-xs text-muted">{c.count} sự cố · gián đoạn {formatNumber(c.outage_minutes)} phút · {c.services.join(', ')} · gần nhất {epochDate(c.last_seen)}</p>
                      </div>
                      <Button className="w-full sm:w-auto" onClick={() => open.mutate(c)} disabled={open.isPending}>Mở vấn đề</Button>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
          <SectionTitle>Vấn đề</SectionTitle>
          {d.items.length ? (
            <DataTable rows={d.items} rowKey={(p) => p.id} onRowClick={setSel}
              columns={[
                { key: 'title', header: 'Vấn đề', primary: true, cell: (p) => <span className="break-words"><b className="font-mono text-xs">{p.code}</b> {p.title}</span> },
                { key: 'st', header: 'Trạng thái', badge: true, cell: (p) => <span className="flex flex-wrap gap-1"><Badge tone={PROBLEM_STATUS[p.status].tone}>{PROBLEM_STATUS[p.status].label}</Badge>{p.reopened > 0 && <Badge tone="danger">Tái phát ×{p.reopened}</Badge>}</span> },
                { key: 'root', header: 'Service gốc', cell: (p) => <span className="font-mono text-xs">{p.root_service}</span> },
                { key: 'n', header: `Sự cố (${d.days} ngày / tổng)`, align: 'right', cell: (p) => `${p.incidents_recent} / ${p.incidents}` },
                { key: 'out', header: 'Gián đoạn', align: 'right', cell: (p) => `${formatNumber(p.outage_minutes_recent)} phút` },
                { key: 'own', header: 'Phụ trách', hideOnMobile: true, cell: (p) => p.owner || '—' },
              ]} />
          ) : <p className="text-sm text-muted">Chưa mở vấn đề nào.</p>}
          {sel && <ProblemSheet problem={sel} onClose={() => setSel(null)} />}
        </div>
      )}
    </QueryView>
  );
}

function ProblemSheet({ problem, onClose }: { problem: ProblemItem; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Record<'title' | 'status' | 'workaround' | 'fix_ref' | 'owner', string>>({ title: problem.title, status: problem.status, workaround: problem.workaround ?? '', fix_ref: problem.fix_ref ?? '', owner: problem.owner ?? '' });
  const save = useMutation({
    mutationFn: () => api<ProblemItem>(`/aiops/problems/${problem.id}`, { method: 'PATCH', body: f }),
    onSuccess: () => { toast.success('Đã lưu'); void qc.invalidateQueries({ queryKey: ['aiops-problems'] }); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const blocked = (f.status === 'known_error' && !f.workaround.trim()) || (f.status === 'resolved' && !f.fix_ref.trim());
  return (
    <Sheet open onClose={onClose} title={problem.code}
      footer={<>
        <Button variant="outline" onClick={onClose}>Huỷ</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || blocked || !f.title.trim()}>Lưu</Button>
      </>}>
      <div className="flex flex-col gap-3">
        <Field label="Tiêu đề" htmlFor="pb-title"><Input id="pb-title" value={f.title} maxLength={200} onChange={set('title')} /></Field>
        <Field label="Trạng thái" htmlFor="pb-status">
          <Select id="pb-status" value={f.status} onChange={set('status')}>
            {(Object.keys(PROBLEM_STATUS) as ProblemStatus[]).map((k) => <option key={k} value={k}>{PROBLEM_STATUS[k].label}</option>)}
          </Select>
        </Field>
        <Field label="Cách xử lý tạm (workaround)" htmlFor="pb-wa" hint="Bắt buộc với Lỗi đã biết — sẽ gắn vào bản tin của sự cố mới khớp vấn đề này">
          <Textarea id="pb-wa" rows={4} value={f.workaround} maxLength={4000} onChange={set('workaround')} />
        </Field>
        <Field label="Bản sửa tận gốc (PR/ticket)" htmlFor="pb-fix" hint="Bắt buộc khi đóng vấn đề">
          <Input id="pb-fix" value={f.fix_ref} maxLength={500} onChange={set('fix_ref')} placeholder="vd: shop-microservice#412" />
        </Field>
        <Field label="Phụ trách" htmlFor="pb-owner"><Input id="pb-owner" value={f.owner} maxLength={120} onChange={set('owner')} /></Field>
      </div>
    </Sheet>
  );
}

interface AutonomyRule { rule: string; action: string; approval: string; actions: number; decided: number; rejected: number; executed: number; failed: number; success_rate: number | null; recurrence_rate: number | null; median_wait_s: number | null; recommendation: 'auto' | 'required' | null; reasons: string[]; patch?: string }
interface AutonomyReport { days: number; rules: AutonomyRule[]; promote: string[]; demote: string[]; toil_hours: number; oncall_hours: number | null; toil_share: number | null; toil_over_budget: boolean; policy: { toil_budget: number; min_samples: number }; automation_candidates: { service: string; alertname: string; count: number; toil_minutes: number }[] }

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

/** Quyền tự động theo thành tích: luật runbook nào đủ tin để bỏ duyệt tay, luật auto nào phải trả về duyệt tay; toil và ứng viên tự động hoá. */
function Autonomy() {
  const q = useQuery({ queryKey: ['aiops-autonomy'], retry: false, queryFn: () => api.get<AutonomyReport>('/aiops/reports/autonomy', { days: 28 }) });
  return (
    <QueryView q={q}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Toil / giờ trực" value={pct(d.toil_share)} tone={d.toil_over_budget ? 'danger' : 'success'} />
            <Stat label={`Giờ toil (${d.days} ngày)`} value={`${d.toil_hours} giờ`} />
            <Stat label="Đề xuất bỏ duyệt tay" value={String(d.promote.length)} />
            <Stat label="Đề xuất trả về duyệt tay" value={String(d.demote.length)} tone={d.demote.length ? 'danger' : undefined} />
          </div>
          <p className="text-sm text-muted">Toil = phút chờ duyệt + phút người xử lý sự cố mà tự động hoá không xử lý được (mục tiêu SRE dưới {Math.round(d.policy.toil_budget * 100)}% giờ trực). Luật chỉ được đề xuất bỏ duyệt tay khi có ít nhất {d.policy.min_samples} lần quyết, không lần nào bị từ chối, thực thi thành công và sự cố không tái diễn; rollback và tắt tính năng luôn cần người duyệt. Đề xuất là bản vá runbook.yaml, đi qua PR như mọi thay đổi chính sách.</p>
          <SectionTitle>Thành tích từng luật runbook</SectionTitle>
          <DataTable rows={d.rules} rowKey={(r) => r.rule}
            columns={[
              { key: 'rule', header: 'Luật', primary: true, cell: (r) => <span className="break-all font-mono text-sm">{r.rule}</span> },
              { key: 'rec', header: 'Đề xuất', badge: true, cell: (r) => (r.recommendation === 'auto' ? <Badge tone="success">Bỏ duyệt tay</Badge>
                : r.recommendation === 'required' ? <Badge tone="danger">Trả về duyệt tay</Badge>
                : <Badge tone="neutral">{r.approval === 'auto' ? 'Tự động' : 'Duyệt tay'}</Badge>) },
              { key: 'act', header: 'Hành động', cell: (r) => <span className="font-mono text-xs">{r.action}</span> },
              { key: 'dec', header: 'Duyệt / từ chối', align: 'right', cell: (r) => `${r.decided - r.rejected} / ${r.rejected}` },
              { key: 'ok', header: 'Thành công', align: 'right', cell: (r) => pct(r.success_rate) },
              { key: 'rec2', header: 'Tái diễn 2h', align: 'right', cell: (r) => pct(r.recurrence_rate) },
              { key: 'wait', header: 'Chờ duyệt (trung vị)', align: 'right', hideOnMobile: true, cell: (r) => (r.median_wait_s == null ? '—' : `${Math.round(r.median_wait_s / 60)} phút`) },
              { key: 'why', header: 'Lý do', hideOnMobile: true, cell: (r) => <span className="text-xs text-muted">{r.reasons.join(' · ') || '—'}</span> },
            ]} />
          {d.rules.filter((r) => r.patch).map((r) => (
            <details key={r.rule} className="min-w-0 rounded-xl border border-border bg-surface p-3">
              <summary className="cursor-pointer text-sm font-medium">Bản vá đề xuất: <span className="font-mono">{r.rule}</span> → {r.recommendation}</summary>
              <p className="mt-2 text-xs text-muted">{r.reasons.join(' · ')}</p>
              <pre className="mt-2 max-w-full overflow-x-auto rounded-lg bg-surface-2 p-2 text-xs">{r.patch}</pre>
            </details>
          ))}
          <SectionTitle>Ứng viên tự động hoá (sự cố lặp, người xử lý tay)</SectionTitle>
          {d.automation_candidates.length ? (
            <DataTable rows={d.automation_candidates} rowKey={(c) => c.service + c.alertname}
              columns={[
                { key: 'a', header: 'Cảnh báo', primary: true, cell: (c) => <span className="break-all font-mono text-sm">{c.alertname}</span> },
                { key: 's', header: 'Service', cell: (c) => <span className="font-mono text-xs">{c.service}</span> },
                { key: 'n', header: 'Số lần', align: 'right', cell: (c) => String(c.count) },
                { key: 't', header: 'Phút toil', align: 'right', cell: (c) => formatNumber(c.toil_minutes) },
              ]} />
          ) : <p className="text-sm text-muted">Không có nhóm sự cố nào lặp từ 3 lần trở lên mà phải xử lý tay.</p>}
        </div>
      )}
    </QueryView>
  );
}

/** Bản tin bàn giao ca (cùng nội dung CronJob 8:30 gửi lên kênh trực) — xem trước hoặc gửi ngay. */
function Digest() {
  const q = useQuery({ queryKey: ['aiops-digest'], queryFn: () => api.get<{ markdown: string; attention: string[]; incidents: { new: number; open: number; resolved: number } }>('/aiops/reports/oncall-digest', { hours: 24 }) });
  return (
    <QueryView q={q}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <OnCall />
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
              { key: 'title', header: 'Sự cố', primary: true, cell: (i) => <span className="line-clamp-2">{i.drill_id && <Badge className="mr-1" tone="info">Diễn tập</Badge>}{i.title}</span> },
              { key: 'status', header: 'Trạng thái', badge: true, cell: (i) => <Badge tone={STATUS[i.status]?.tone}>{STATUS[i.status]?.label ?? i.status}</Badge> },
              { key: 'svc', header: 'Service', cell: (i) => <span className="font-mono text-xs">{i.service}</span> },
              { key: 'sev', header: 'Mức', cell: (i) => <Badge tone={SEV[i.severity] ?? 'neutral'}>{i.severity}</Badge> },
              { key: 'rc', header: 'Nguyên nhân gốc (RCA)', cell: (i) => i.root_causes?.[0]?.service ?? '—' },
              { key: 'who', header: 'Người trực', hideOnMobile: true, cell: (i) => <span className="text-xs">{i.assignee ?? '—'}</span> },
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
      <BusinessImpact id={incident.id} />
      <PublicComms incident={incident} />
      <SuggestedRunbooks id={incident.id} />
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
                <KV label="Hành động"><span className="inline-flex items-center gap-1 font-medium break-words"><Wrench className="size-4 shrink-0" />
                  {latest.remediation.action === 'toggle_flag'
                    ? `Tắt tính năng ${latest.remediation.params?.flag ?? ''} (kill switch, ${latest.remediation.service} quá tải)`
                    : `${latest.remediation.action} ${latest.remediation.service}`}</span></KV>
                <KV label="Lý do">{latest.remediation.reason}</KV>
                <KV label="SafetyInterlock">
                  {latest.remediation.allowed ? <Badge tone="success">cho phép</Badge>
                    : <span className="inline-flex items-center gap-1 text-danger"><ShieldAlert className="size-4" />{latest.remediation.interlock}</span>}
                </KV>
                {latest.pr?.url && <KV label="PR"><a className="text-primary underline break-all" href={latest.pr.url} target="_blank" rel="noreferrer">{latest.pr.url}</a></KV>}
                {latest.pr?.problems && <KV label="Cổng xác minh"><span className="text-danger">{latest.pr.problems.join('; ')}</span></KV>}
                {latest.pr?.diff && <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre">{latest.pr.diff}</pre>}
                {['rollback', 'scale_up', 'toggle_flag'].includes(latest.remediation.action) && latest.remediation.allowed && !latest.pr?.url && (
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
