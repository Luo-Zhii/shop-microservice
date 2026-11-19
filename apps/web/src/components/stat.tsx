import type { ReactNode } from 'react';
import { cn } from './ui';

/** Ô chỉ số nhỏ (KPI) — dùng trong lưới 2 cột trên điện thoại, 4 cột từ sm. */
export function Stat({ label, value, tone, className }: { label: string; value: ReactNode; tone?: 'danger' | 'success'; className?: string }) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-border bg-surface p-3', className)}>
      <div className="truncate text-xs text-muted">{label}</div>
      <div className={cn('truncate font-semibold', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success')}>{value}</div>
    </div>
  );
}
