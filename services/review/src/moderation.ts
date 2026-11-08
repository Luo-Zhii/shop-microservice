import { counter, serviceClient, type Logger } from '@shopnow/platform';

export interface ModerationResult {
  allowed: boolean;
  labels: string[];
  score: number;
  /** ai = có kết quả từ ai-service; fail_open = ai lỗi/timeout nên cho qua */
  source: 'ai' | 'fail_open' | 'skipped';
}
export type Moderator = (text: string) => Promise<{ allowed: boolean; labels?: string[]; score?: number }>;

export const moderationTotal = () => counter('review_moderation_total', 'Kết quả kiểm duyệt review', ['result']);

export function aiModerator(baseUrl: string, timeoutMs: number): Moderator {
  const http = serviceClient({ name: 'ai-service', baseUrl, timeoutMs, retries: 0, breaker: { failureThreshold: 5, openMs: 30_000 } });
  return (text) => http.post('/moderate', { text });
}

/** Kiểm duyệt fail-open: AI chặn → ẩn chờ admin; AI lỗi/timeout → vẫn đăng (đếm metric để cảnh báo). */
export async function moderate(moderator: Moderator, text: string, log: Logger): Promise<ModerationResult> {
  if (!text.trim()) return { allowed: true, labels: [], score: 0, source: 'skipped' };
  try {
    const r = await moderator(text);
    const allowed = r.allowed !== false;
    moderationTotal().inc({ result: allowed ? 'allowed' : 'blocked' });
    return { allowed, labels: r.labels ?? [], score: Number(r.score ?? 0), source: 'ai' };
  } catch (err) {
    log.warn({ err }, 'ai-service kiểm duyệt lỗi — fail-open');
    moderationTotal().inc({ result: 'fail_open' });
    return { allowed: true, labels: [], score: 0, source: 'fail_open' };
  }
}
