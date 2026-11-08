'use client';

import { useState } from 'react';
import { formatCompact } from '@/lib/format';

export interface BarDatum { label: string; value: number; sub?: string }

/** Biểu đồ cột SVG tự vẽ: co giãn theo khung (viewBox), chạm vào cột để xem số liệu (không phụ thuộc hover). */
export function BarChart({ data, format = (v) => String(v), height = 220 }: {
  data: BarDatum[]; format?: (v: number) => string; height?: number;
}) {
  const [sel, setSel] = useState<number | null>(null);
  if (!data.length) return <p className="py-10 text-center text-sm text-muted">Chưa có dữ liệu</p>;
  const W = 640;
  const H = height;
  const pad = { l: 44, r: 8, t: 12, b: 26 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    const m = Math.ceil(max / p);
    return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  })();
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bw = iw / data.length;
  const gap = Math.min(6, bw * 0.25);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * nice);
  const labelEvery = Math.ceil(data.length / 8);
  const cur = sel != null ? data[sel] : data[data.length - 1];

  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-h-10 items-baseline justify-between gap-2 text-sm">
        <span className="truncate text-muted">{cur.sub ?? cur.label}</span>
        <span className="shrink-0 font-semibold">{format(cur.value)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Biểu đồ cột">
        {ticks.map((t) => {
          const y = pad.t + ih - (t / nice) * ih;
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="var(--app-border)" strokeDasharray={t ? '3 3' : undefined} />
              <text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize="11" fill="var(--app-muted)">{formatCompact(t)}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.value / nice) * ih;
          const x = pad.l + i * bw + gap / 2;
          const active = sel === i || (sel == null && i === data.length - 1);
          return (
            <g key={`${d.label}-${i}`} onClick={() => setSel(i)} className="cursor-pointer">
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={ih} fill="transparent" />
              <rect x={x} y={pad.t + ih - h} width={Math.max(1, bw - gap)} height={Math.max(0, h)} rx={Math.min(3, (bw - gap) / 2)}
                fill="var(--app-primary)" opacity={active ? 1 : 0.55}>
                <title>{`${d.sub ?? d.label}: ${format(d.value)}`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={pad.l + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--app-muted)">{d.label}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
