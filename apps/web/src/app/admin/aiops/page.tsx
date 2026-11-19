'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, GitPullRequest, ShieldAlert, Siren, Wrench } from 'lucide-react';
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
      <PageTitle>Sự cố & tác tử AIOps</PageTitle>
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
  const latest = inv.data?.items[0];
  return (
    <Sheet open onClose={onClose} wide title={<span className="flex items-center gap-2"><Siren className="size-4 text-danger" />{incident.service}</span>}
      footer={<>
        {incident.status === 'open' && <Button variant="outline" onClick={() => ack.mutate('ack')} disabled={ack.isPending}>Nhận xử lý</Button>}
        {incident.status !== 'resolved' && <Button variant="outline" onClick={() => ack.mutate('resolve')} disabled={ack.isPending}>Đóng sự cố</Button>}
        <Button onClick={() => run.mutate()} disabled={run.isPending}><Bot className="size-4" />{run.isPending ? 'Đang điều tra…' : 'Tác tử điều tra'}</Button>
      </>}>
      <p className="mb-3 break-words text-sm">{incident.title}</p>
      {incident.summary && <Card className="mb-4 p-3 text-sm whitespace-pre-line">{incident.summary}</Card>}
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
