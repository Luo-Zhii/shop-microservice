'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Bell, ClipboardList, Heart, Home, LayoutGrid, LogOut, Package, ShieldCheck, ShoppingCart, Store, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cartCount, useCart, useNotifications } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { cn } from '../ui';
import { SearchBox } from './search-box';

function CountBadge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-primary px-1 text-center text-[11px] font-semibold leading-[18px] text-primary-fg ring-2 ring-surface">
      {n > 99 ? '99+' : n}
    </span>
  );
}

export function Logo({ suffix }: { suffix?: string }) {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-1.5 font-bold text-primary">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-sm text-primary-fg">S</span>
      <span className="text-lg tracking-tight">ShopNow</span>
      {suffix && <span className="text-sm font-medium text-muted">{suffix}</span>}
    </Link>
  );
}

function AccountMenu() {
  const { user, status, logout, hasRole } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  if (status !== 'authenticated') {
    return (
      <div className="hidden items-center gap-1 md:flex">
        <Link href="/login" className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium hover:bg-surface-2">Đăng nhập</Link>
        <Link href="/register" className="inline-flex min-h-10 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-fg">Đăng ký</Link>
      </div>
    );
  }
  const item = 'flex min-h-11 items-center gap-2.5 px-3 text-sm hover:bg-surface-2';
  return (
    <div ref={ref} className="relative hidden md:block">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex min-h-10 max-w-48 items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"><User className="size-4" /></span>
        <span className="truncate">{user?.fullName || user?.email}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg" onClick={() => setOpen(false)}>
          <Link href="/account" className={item}><User className="size-4" /> Tài khoản của tôi</Link>
          <Link href="/orders" className={item}><Package className="size-4" /> Đơn mua</Link>
          <Link href="/account/wishlist" className={item}><Heart className="size-4" /> Yêu thích</Link>
          <Link href="/seller" className={item}><Store className="size-4" /> {hasRole('seller') ? 'Kênh người bán' : 'Mở shop'}</Link>
          {hasRole('admin') && <Link href="/admin" className={item}><ShieldCheck className="size-4" /> Quản trị</Link>}
          <button type="button" onClick={() => { void logout(); }} className={cn(item, 'w-full border-t border-border text-danger')}><LogOut className="size-4" /> Đăng xuất</button>
        </div>
      )}
    </div>
  );
}

/** Nghe SSE thông báo realtime; cập nhật số chưa đọc và hiện toast. */
export function NotificationStream() {
  const { token } = useAuth();
  const qc = useQueryClient();
  useEffect(() => {
    if (!token || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const connect = () => {
      es = new EventSource(`${API_URL}/notification/notifications/stream?token=${encodeURIComponent(token)}`);
      es.onopen = () => { tries = 0; };
      // notification service gửi sự kiện có tên: `notification` (thông báo mới) và `unread` (số chưa đọc)
      es.addEventListener('notification', (ev) => {
        try {
          const n = JSON.parse((ev as MessageEvent).data) as { title?: string };
          if (n.title) toast(n.title, 'info');
        } catch {
          /* bỏ qua */
        }
        void qc.invalidateQueries({ queryKey: ['notifications'] });
      });
      es.addEventListener('unread', () => { void qc.invalidateQueries({ queryKey: ['notifications'] }); });
      es.onerror = () => {
        es?.close();
        // Thử lại có giãn cách; token hết hạn thì AuthProvider refresh → effect chạy lại với token mới
        if (tries < 5) retry = setTimeout(connect, Math.min(30_000, 2000 * 2 ** tries++));
      };
    };
    connect();
    return () => { es?.close(); if (retry) clearTimeout(retry); };
  }, [token, qc]);
  return null;
}

export function ShopHeader() {
  const { status } = useAuth();
  const cart = useCart();
  const notis = useNotifications();
  const n = cartCount(cart.data);
  const unread = notis.data?.unread ?? 0;
  const icon = 'relative grid size-11 shrink-0 place-items-center rounded-lg hover:bg-surface-2 md:size-10';
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/95 pt-safe backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 md:gap-4 md:py-3">
        <div className="hidden md:block"><Logo /></div>
        <Link href="/" aria-label="ShopNow" className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-fg md:hidden">S</Link>
        <Suspense fallback={<div className="h-11 min-w-0 flex-1 rounded-lg border border-border md:h-10" />}>
          <SearchBox className="flex-1" />
        </Suspense>
        <nav className="flex items-center gap-0.5">
          <Link href="/categories" aria-label="Danh mục" className={cn(icon, 'hidden md:grid')}><LayoutGrid className="size-5" /></Link>
          {status === 'authenticated' && (
            <Link href="/notifications" aria-label={`Thông báo${unread ? `, ${unread} chưa đọc` : ''}`} className={icon}>
              <Bell className="size-5" /><CountBadge n={unread} />
            </Link>
          )}
          <Link href="/cart" aria-label={`Giỏ hàng${n ? `, ${n} sản phẩm` : ''}`} className={icon}>
            <ShoppingCart className="size-5" /><CountBadge n={n} />
          </Link>
          <AccountMenu />
        </nav>
      </div>
    </header>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const { status } = useAuth();
  const cart = useCart();
  const n = cartCount(cart.data);
  const items = [
    { href: '/', label: 'Trang chủ', icon: Home, match: (p: string) => p === '/' },
    { href: '/categories', label: 'Danh mục', icon: LayoutGrid, match: (p: string) => p.startsWith('/categories') || p.startsWith('/search') },
    { href: '/orders', label: 'Đơn mua', icon: ClipboardList, match: (p: string) => p.startsWith('/orders') },
    { href: '/cart', label: 'Giỏ hàng', icon: ShoppingCart, match: (p: string) => p.startsWith('/cart'), badge: n },
    { href: status === 'authenticated' ? '/account' : '/login', label: status === 'authenticated' ? 'Tôi' : 'Đăng nhập', icon: User, match: (p: string) => p.startsWith('/account') || p === '/login' },
  ];
  return (
    <nav aria-label="Điều hướng chính" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-safe backdrop-blur md:hidden">
      <ul className="grid h-[var(--bottom-nav-h)] grid-cols-5">
        {items.map((it) => {
          const on = it.match(pathname);
          return (
            <li key={it.label} className="min-w-0">
              <Link href={it.href} aria-current={on ? 'page' : undefined}
                className={cn('relative flex h-full flex-col items-center justify-center gap-0.5 text-[11px]', on ? 'text-primary' : 'text-muted')}>
                <span className="relative">
                  <it.icon className="size-5" />
                  {!!it.badge && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-fg">
                      {it.badge > 99 ? '99+' : it.badge}
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate px-1">{it.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function ShopFooter() {
  return (
    <footer className="mt-10 hidden border-t border-border bg-surface md:block">
      <div className="mx-auto grid max-w-7xl grid-cols-4 gap-6 px-4 py-8 text-sm text-muted">
        <div className="space-y-2"><Logo /><p>Sàn thương mại điện tử nhiều người bán.</p></div>
        <div className="space-y-2"><p className="font-medium text-fg">Chăm sóc khách hàng</p><p>Trung tâm trợ giúp</p><p>Chính sách đổi trả</p></div>
        <div className="space-y-2"><p className="font-medium text-fg">Bán hàng</p><Link href="/seller" className="block hover:text-primary">Kênh người bán</Link></div>
        <div className="space-y-2"><p className="font-medium text-fg">Thanh toán</p><p>COD · VNPay</p></div>
      </div>
    </footer>
  );
}
