'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, Loader2, Minus, Plus, RotateCw, Star, X } from 'lucide-react';
import Link from 'next/link';
import {
  forwardRef, useEffect, useId, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { errorMessage } from '@/lib/api';
import { formatVND, type Tone } from '@/lib/format';

export function cn(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

// ---------------- Button ----------------
type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover active:brightness-95',
  secondary: 'bg-primary-soft text-primary hover:brightness-95',
  outline: 'border border-border bg-surface text-fg hover:bg-surface-2 active:bg-surface-2',
  ghost: 'text-fg hover:bg-surface-2 active:bg-surface-2',
  danger: 'bg-danger text-white hover:brightness-110 active:brightness-95',
};
// Mục tiêu chạm ≥ 44px trên điện thoại; desktop gọn hơn
const sizes: Record<Size, string> = {
  sm: 'min-h-11 md:min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-sm',
  lg: 'min-h-12 px-5 text-base',
  icon: 'size-11 md:size-10',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, className, children, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
});

export function LinkButton({ href, variant = 'primary', size = 'md', className, children }: {
  href: string; variant?: Variant; size?: Size; className?: string; children: ReactNode;
}) {
  return (
    <Link href={href} className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[0.98]', variants[variant], sizes[size], className)}>
      {children}
    </Link>
  );
}

// ---------------- Form ----------------
const control = 'w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-fg placeholder:text-muted/70 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(control, 'min-h-11 md:min-h-10', className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-24 py-2.5', className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={cn(control, 'min-h-11 md:min-h-10 pr-8', className)} {...p}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children, className, htmlFor }: {
  label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>}
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, className, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; className?: string; disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('inline-flex min-h-11 cursor-pointer items-center gap-2.5 md:min-h-9', disabled && 'opacity-50', className)}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-5 shrink-0 accent-[var(--app-primary)]" />
      {label && <span className="min-w-0 text-sm">{label}</span>}
    </label>
  );
}

// ---------------- Hiển thị ----------------
export function Card({ className, children, as: As = 'div' }: { className?: string; children: ReactNode; as?: 'div' | 'section' | 'article' }) {
  return <As className={cn('rounded-xl border border-border bg-surface', className)}>{children}</As>;
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center justify-between gap-3', className)}>
      <h2 className="min-w-0 truncate text-base font-semibold md:text-lg">{children}</h2>
      {action}
    </div>
  );
}

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-muted', className)} aria-label="Đang tải" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-surface-2', className)} />;
}

export function LoadingBlock({ label = 'Đang tải…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-muted', className)}>
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ title = 'Chưa có dữ liệu', description, action, icon }: {
  title?: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-surface-2 text-muted">{icon ?? <Inbox className="size-6" />}</div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-4 text-center', compact ? 'py-4' : 'py-10')}>
      <div className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger"><AlertTriangle className="size-6" /></div>
      <p className="font-medium">Không tải được dữ liệu</p>
      <p className="max-w-sm break-words text-sm text-muted">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-1"><RotateCw className="size-4" /> Thử lại</Button>
      )}
    </div>
  );
}

/** Hiển thị đang tải / lỗi / rỗng thống nhất cho một query. */
export function QueryView<T>({ q, children, loading, isEmpty, empty }: {
  q: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
}) {
  if (q.isPending) return <>{loading ?? <LoadingBlock />}</>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (isEmpty?.(q.data)) return <>{empty ?? <EmptyState />}</>;
  return <>{children(q.data)}</>;
}

export function Price({ value, compareAt, className, size = 'md' }: { value?: number; compareAt?: number | null; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'lg' ? 'text-2xl md:text-3xl' : size === 'sm' ? 'text-sm' : 'text-base';
  const off = compareAt && value && compareAt > value ? Math.round((1 - value / compareAt) * 100) : 0;
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-2', className)}>
      <span className={cn('font-semibold text-primary', sz)}>{formatVND(value)}</span>
      {off > 0 && (
        <>
          <span className="text-xs text-muted line-through">{formatVND(compareAt)}</span>
          <span className="text-xs font-medium text-primary">-{off}%</span>
        </>
      )}
    </span>
  );
}

export function Stars({ value = 0, size = 'sm', className }: { value?: number; size?: 'sm' | 'md'; className?: string }) {
  const s = size === 'md' ? 'size-5' : 'size-3.5';
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={`${value.toFixed(1)} trên 5 sao`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn(s, i <= Math.round(value) ? 'fill-amber-400 text-amber-400' : 'text-border')} />
      ))}
    </span>
  );
}

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Chọn số sao">
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${i} sao`} onClick={() => onChange(i)}
          className="grid size-11 place-items-center rounded-lg active:bg-surface-2">
          <Star className={cn('size-7', i <= value ? 'fill-amber-400 text-amber-400' : 'text-border')} />
        </button>
      ))}
    </div>
  );
}

export function QtyStepper({ value, onChange, min = 1, max = 999, disabled }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (n: number) => {
    const v = Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min));
    setDraft(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <div className={cn('inline-flex h-11 items-stretch overflow-hidden rounded-lg border border-border md:h-9', disabled && 'opacity-50')}>
      <button type="button" aria-label="Giảm" disabled={disabled || value <= min} onClick={() => commit(value - 1)} className="grid w-11 place-items-center active:bg-surface-2 disabled:opacity-40 md:w-9">
        <Minus className="size-4" />
      </button>
      <input
        aria-label="Số lượng"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={() => commit(Number(draft))}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(Number(draft)); }}
        className="w-12 border-x border-border bg-surface text-center outline-none"
      />
      <button type="button" aria-label="Tăng" disabled={disabled || value >= max} onClick={() => commit(value + 1)} className="grid w-11 place-items-center active:bg-surface-2 disabled:opacity-40 md:w-9">
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/** Tab cuộn ngang (không tràn trang). */
export function Tabs<T extends string>({ value, onChange, items, className }: {
  value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[]; className?: string;
}) {
  return (
    <div className={cn('scrollbar-none -mx-4 overflow-x-auto px-4 md:mx-0 md:px-0', className)} role="tablist">
      <div className="flex w-max min-w-full gap-1 border-b border-border">
        {items.map((it) => (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={value === it.value}
            onClick={() => onChange(it.value)}
            className={cn(
              'relative min-h-11 shrink-0 whitespace-nowrap px-3 text-sm font-medium transition',
              value === it.value ? 'text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary' : 'text-muted hover:text-fg',
            )}
          >
            {it.label}
            {it.count != null && it.count > 0 && <span className="ml-1 text-xs">({it.count})</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Pagination({ page, pages, onChange, className }: { page: number; pages: number; onChange: (p: number) => void; className?: string }) {
  if (pages <= 1) return null;
  const nums: (number | '…')[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return (
    <nav aria-label="Phân trang" className={cn('flex items-center justify-center gap-1', className)}>
      <Button variant="ghost" size="icon" aria-label="Trang trước" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft className="size-5" /></Button>
      {/* Điện thoại: chỉ hiện "3 / 10" để không tràn */}
      <span className="px-2 text-sm text-muted sm:hidden">{page} / {pages}</span>
      <div className="hidden items-center gap-1 sm:flex">
        {nums.map((n, i) => n === '…'
          ? <span key={`e${i}`} className="px-1 text-muted">…</span>
          : (
            <button key={n} type="button" onClick={() => onChange(n)} aria-current={n === page ? 'page' : undefined}
              className={cn('min-h-10 min-w-10 rounded-lg px-2 text-sm', n === page ? 'bg-primary text-primary-fg' : 'hover:bg-surface-2')}>
              {n}
            </button>
          ))}
      </div>
      <Button variant="ghost" size="icon" aria-label="Trang sau" disabled={page >= pages} onClick={() => onChange(page + 1)}><ChevronRight className="size-5" /></Button>
    </nav>
  );
}

// ---------------- Sheet / Dialog ----------------
/** Điện thoại: bottom sheet; từ sm: hộp thoại giữa màn hình. Nội dung tự cuộn, nút luôn trong màn hình. */
export function Sheet({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Đóng" onClick={onClose} className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-[1px]" />
      <div className={cn(
        'relative flex max-h-[92dvh] w-full animate-sheet-in flex-col rounded-t-2xl bg-surface shadow-xl sm:max-h-[calc(100dvh-2rem)] sm:animate-fade-in sm:rounded-2xl',
        wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
      )}>
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border sm:hidden" aria-hidden />
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <h3 className="min-w-0 flex-1 truncate font-semibold">{title}</h3>
          <Button variant="ghost" size="icon" aria-label="Đóng" onClick={onClose}><X className="size-5" /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 pt-3 pb-[calc(12px+var(--safe-bottom))] sm:pb-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Hộp nhập lý do (từ chối, huỷ, trả hàng…). */
export function ReasonSheet({ open, onClose, title, label = 'Lý do', confirmText = 'Xác nhận', onConfirm, loading, danger, minLength = 3, presets }: {
  open: boolean; onClose: () => void; title: string; label?: string; confirmText?: string;
  onConfirm: (reason: string) => void; loading?: boolean; danger?: boolean; minLength?: number; presets?: string[];
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const ok = reason.trim().length >= minLength;
  return (
    <Sheet open={open} onClose={onClose} title={title} footer={(
      <>
        <Button variant="outline" onClick={onClose}>Đóng</Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={!ok} loading={loading} onClick={() => onConfirm(reason.trim())}>{confirmText}</Button>
      </>
    )}>
      {presets && (
        <div className="mb-3 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p} type="button" onClick={() => setReason(p)}
              className={cn('min-h-9 rounded-full border px-3 text-sm', reason === p ? 'border-primary bg-primary-soft text-primary' : 'border-border')}>
              {p}
            </button>
          ))}
        </div>
      )}
      <Field label={label} hint={`Tối thiểu ${minLength} ký tự`}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
      </Field>
    </Sheet>
  );
}

export function ConfirmSheet({ open, onClose, title, message, confirmText = 'Đồng ý', onConfirm, loading, danger }: {
  open: boolean; onClose: () => void; title: string; message: ReactNode; confirmText?: string; onConfirm: () => void; loading?: boolean; danger?: boolean;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} footer={(
      <>
        <Button variant="outline" onClick={onClose}>Đóng</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmText}</Button>
      </>
    )}>
      <div className="text-sm text-muted">{message}</div>
    </Sheet>
  );
}

/** Ảnh có khung tỉ lệ cố định (tránh layout shift), có ảnh thay thế khi lỗi. */
export function Img({ src, alt, className, ratio = 'square', rounded = 'rounded-lg' }: {
  src?: string | null; alt: string; className?: string; ratio?: 'square' | 'video' | 'banner' | 'none'; rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  const r = ratio === 'square' ? 'aspect-square' : ratio === 'video' ? 'aspect-video' : ratio === 'banner' ? 'aspect-[16/7] md:aspect-[16/5]' : '';
  return (
    <div className={cn('relative overflow-hidden bg-surface-2', r, rounded, className)}>
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" decoding="async" width={600} height={600} onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-xs text-muted">ShopNow</div>
      )}
    </div>
  );
}

export function PageTitle({ children, actions, back }: { children: ReactNode; actions?: ReactNode; back?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      {back && (
        <Link href={back} aria-label="Quay lại" className="-ml-2 grid size-11 place-items-center rounded-lg hover:bg-surface-2"><ChevronLeft className="size-5" /></Link>
      )}
      <h1 className="min-w-0 flex-1 text-xl font-semibold md:text-2xl">{children}</h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function KV({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-start justify-between gap-3 text-sm', className)}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 break-words text-right">{children}</span>
    </div>
  );
}
