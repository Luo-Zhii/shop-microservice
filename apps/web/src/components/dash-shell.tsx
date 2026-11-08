'use client';

import { ArrowLeft, LogOut, Menu, X, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { cn } from './ui';

export interface NavItem { href: string; label: string; icon: LucideIcon; exact?: boolean }

/** Khung trang Seller/Admin: sidebar cố định từ lg, drawer trượt trên điện thoại/máy tính bảng. */
export function DashShell({ title, nav, children, disabledNav }: { title: string; nav: NavItem[]; children: ReactNode; disabledNav?: boolean }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const isOn = (n: NavItem) => (n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(`${n.href}/`));
  const current = nav.find(isOn);

  const panel = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Link href="/" className="grid size-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-fg">S</Link>
        <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
        <button type="button" aria-label="Đóng menu" onClick={() => setOpen(false)} className="grid size-11 place-items-center rounded-lg hover:bg-surface-2 lg:hidden"><X className="size-5" /></button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={title}>
        {nav.map((n) => (
          <Link key={n.href} href={disabledNav ? '#' : n.href} aria-current={isOn(n) ? 'page' : undefined} aria-disabled={disabledNav}
            className={cn('flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm',
              isOn(n) ? 'bg-primary-soft font-medium text-primary' : 'text-fg hover:bg-surface-2',
              disabledNav && !isOn(n) && 'pointer-events-none opacity-40')}>
            <n.icon className="size-5 shrink-0" /> <span className="truncate">{n.label}</span>
          </Link>
        ))}
      </nav>
      <div className="border-t border-border p-2 pb-[calc(var(--safe-bottom)+8px)]">
        <div className="truncate px-3 py-1 text-xs text-muted">{user?.email}</div>
        <Link href="/" className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm hover:bg-surface-2"><ArrowLeft className="size-5" /> Về trang mua sắm</Link>
        <button type="button" onClick={() => void logout()} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-danger hover:bg-surface-2"><LogOut className="size-5" /> Đăng xuất</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface lg:block">{panel}</aside>

      {/* Drawer điện thoại: luôn mount để trượt cả 2 chiều */}
      <div className={cn('fixed inset-0 z-50 lg:hidden', open ? 'visible' : 'invisible')} aria-hidden={!open}>
        <button type="button" aria-label="Đóng menu" tabIndex={open ? 0 : -1} onClick={() => setOpen(false)}
          className={cn('absolute inset-0 bg-black/50 transition-opacity', open ? 'opacity-100' : 'opacity-0')} />
        <div className={cn('absolute inset-y-0 left-0 w-[85vw] max-w-xs bg-surface pt-safe shadow-xl transition-transform duration-200', open ? 'translate-x-0' : '-translate-x-full')}>
          {panel}
        </div>
      </div>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-border bg-surface/95 pt-safe backdrop-blur lg:hidden">
          <div className="flex h-14 items-center gap-2 px-2">
            <button type="button" aria-label="Mở menu" aria-expanded={open} onClick={() => setOpen(true)} className="grid size-11 place-items-center rounded-lg hover:bg-surface-2"><Menu className="size-5" /></button>
            <span className="min-w-0 flex-1 truncate font-semibold">{current?.label ?? title}</span>
          </div>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-7xl px-4 py-4 pb-[calc(var(--safe-bottom)+24px)] md:px-6 md:py-6">{children}</main>
      </div>
    </div>
  );
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'primary' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info' }) {
  const toneCls = { primary: 'bg-primary-soft text-primary', success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger', info: 'bg-info-soft text-info' }[tone];
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-surface p-3 md:p-4">
      {Icon && <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg', toneCls)}><Icon className="size-5" /></span>}
      <div className="min-w-0">
        <p className="truncate text-xs text-muted md:text-sm">{label}</p>
        <p className="truncate text-lg font-semibold md:text-2xl">{value}</p>
        {hint && <p className="truncate text-xs text-muted">{hint}</p>}
      </div>
    </div>
  );
}
