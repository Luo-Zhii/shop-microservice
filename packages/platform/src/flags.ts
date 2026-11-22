// Feature flag vận hành (kill switch) — đọc file theo lược đồ flagd của OpenFeature (tập con: không targeting):
//   {"flags": {"recommendations": {"state": "ENABLED", "variants": {"on": true, "off": false}, "defaultVariant": "on"}}}
// File do Helm render từ environments/<env>/flags.yaml (GitOps) và mount dạng thư mục ConfigMap → kubelet cập nhật tại chỗ,
// service đọc lại sau ≤ RELOAD_MS mà KHÔNG phải redeploy/restart. Đó là điểm khác với rollback: tắt một tính năng phụ
// (gợi ý sản phẩm, gợi ý từ khoá) để giữ luồng mua hàng khi phụ thuộc của nó quá tải.
// Lỗi đọc/parse → giữ bản tốt gần nhất; chưa từng đọc được → trả giá trị mặc định do code truyền (fail-safe).
import { readFileSync, statSync } from 'node:fs';
import { counter } from './metrics';

export interface FlagDef {
  state: 'ENABLED' | 'DISABLED';
  variants: Record<string, unknown>;
  defaultVariant: string;
}
type Reason = 'STATIC' | 'DISABLED' | 'DEFAULT' | 'ERROR';

const RELOAD_MS = 5_000;
let state: { path: string; checkedAt: number; mtimeMs: number; flags: Record<string, FlagDef> | null } = {
  path: '', checkedAt: 0, mtimeMs: -1, flags: null,
};

// hook quan sát theo tinh thần OpenFeature: mỗi lần đánh giá → metric (flag, variant, reason) để Grafana/AIOps thấy flag đang tắt
const evaluations = () =>
  counter('feature_flag_evaluations_total', 'Số lần đánh giá feature flag (OpenFeature hook)', ['flag', 'variant', 'reason']);

function load(now: number): Record<string, FlagDef> | null {
  const path = process.env.FLAGS_FILE ?? '/etc/shopnow/flags/flags.json';
  if (path !== state.path) state = { path, checkedAt: 0, mtimeMs: -1, flags: null };
  if (now - state.checkedAt < RELOAD_MS && state.flags) return state.flags;
  state.checkedAt = now;
  try {
    const m = statSync(path).mtimeMs;
    if (m !== state.mtimeMs || !state.flags) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { flags?: Record<string, FlagDef> };
      if (!parsed || typeof parsed.flags !== 'object') throw new Error('thiếu khoá "flags"');
      state.flags = parsed.flags;
      state.mtimeMs = m;
    }
  } catch {
    // giữ bản tốt gần nhất (state.flags) — file đang được kubelet thay (symlink ..data) hoặc chưa mount
  }
  return state.flags;
}

/** Giá trị flag; không có file/flag/variant hợp lệ → `fallback`. Flag DISABLED → `fallback` (như flagd). */
export function flagValue<T>(key: string, fallback: T, now = Date.now()): T {
  const flags = load(now);
  const def = flags?.[key];
  let value = fallback;
  let variant = 'fallback';
  let reason: Reason = flags ? 'DEFAULT' : 'ERROR';
  if (def && def.state === 'DISABLED') reason = 'DISABLED';
  else if (def && def.variants && def.defaultVariant in def.variants && typeof def.variants[def.defaultVariant] === typeof fallback) {
    value = def.variants[def.defaultVariant] as T;
    variant = def.defaultVariant;
    reason = 'STATIC';
  }
  evaluations().inc({ flag: key, variant, reason });
  return value;
}

export const isEnabled = (key: string, fallback = true, now?: number): boolean => flagValue(key, fallback, now);

/** Ảnh chụp các flag đang hiệu lực (cho trang quản trị / chẩn đoán). */
export function flagsSnapshot(now = Date.now()): Record<string, { enabled: boolean | null; variant: string; state: string }> {
  const out: Record<string, { enabled: boolean | null; variant: string; state: string }> = {};
  for (const [k, d] of Object.entries(load(now) ?? {})) {
    const v = d.variants?.[d.defaultVariant];
    out[k] = { enabled: typeof v === 'boolean' && d.state === 'ENABLED' ? v : null, variant: d.defaultVariant, state: d.state };
  }
  return out;
}
