'use client';

import { Bell, ClipboardList, Heart, KeyRound, LogOut, MapPin, ShieldCheck, Store, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { LoadingBlock, cn } from '@/components/ui';
import { useAuth, useRequireAuth } from '@/lib/auth';

const ACCOUNT_LINKS = [
  { href: '/account', label: 'Hồ sơ', icon: User },
  { href: '/account/addresses', label: 'Sổ địa chỉ', icon: MapPin },
  { href: '/account/wishlist', label: 'Yêu thích', icon: Heart },
  { href: '/account/security', label: 'Mật khẩu & 2FA', icon: KeyRound },
  { href: '/orders', label: 'Đơn mua', icon: ClipboardList },
  { href: '/notifications', label: 'Thông báo', icon: Bell },
];

export default function AccountLayout({ children }: { children: ReactNode }) {
  const { ready } = useRequireAuth();
  const { user, logout, hasRole } = useAuth();
  const pathname = usePathname();
  if (!ready) return <LoadingBlock />;
  return (
    <div className="md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-6">
      <aside className="hidden md:block">
        <div className="sticky top-24 rounded-xl border border-border bg-surface p-2">
          <div className="flex items-center gap-2 border-b border-border p-2 pb-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"><User className="size-5" /></span>
            <div className="min-w-0"><p className="truncate text-sm font-semibold">{user?.fullName || 'Tài khoản'}</p><p className="truncate text-xs text-muted">{user?.email}</p></div>
          </div>
          <nav className="mt-2 flex flex-col">
            {ACCOUNT_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className={cn('flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-sm', pathname === l.href ? 'bg-primary-soft font-medium text-primary' : 'hover:bg-surface-2')}>
                <l.icon className="size-4" /> {l.label}
              </Link>
            ))}
            <Link href="/seller" className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-sm hover:bg-surface-2"><Store className="size-4" /> {hasRole('seller') ? 'Kênh người bán' : 'Mở shop'}</Link>
            {hasRole('admin') && <Link href="/admin" className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-sm hover:bg-surface-2"><ShieldCheck className="size-4" /> Quản trị</Link>}
            <button type="button" onClick={() => void logout()} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-left text-sm text-danger hover:bg-surface-2"><LogOut className="size-4" /> Đăng xuất</button>
          </nav>
        </div>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
