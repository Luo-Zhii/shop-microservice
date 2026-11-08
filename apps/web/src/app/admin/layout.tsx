'use client';

import { ClipboardList, FolderTree, Image as ImageIcon, LayoutDashboard, MessageSquareOff, Package, ShieldAlert, Store, Ticket, Users, Wallet, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { DashShell, type NavItem } from '@/components/dash-shell';
import { LinkButton, LoadingBlock } from '@/components/ui';
import { useAuth, useRequireAuth } from '@/lib/auth';

const NAV: NavItem[] = [
  { href: '/admin', label: 'Tổng quan', icon: LayoutDashboard, exact: true },
  { href: '/admin/shops', label: 'Duyệt shop', icon: Store },
  { href: '/admin/products', label: 'Duyệt sản phẩm', icon: Package },
  { href: '/admin/categories', label: 'Danh mục', icon: FolderTree },
  { href: '/admin/vouchers', label: 'Voucher sàn', icon: Ticket },
  { href: '/admin/flash-sales', label: 'Flash sale', icon: Zap },
  { href: '/admin/banners', label: 'Banner', icon: ImageIcon },
  { href: '/admin/orders', label: 'Đơn hàng & trả hàng', icon: ClipboardList },
  { href: '/admin/users', label: 'Người dùng', icon: Users },
  { href: '/admin/payouts', label: 'Yêu cầu rút tiền', icon: Wallet },
  { href: '/admin/reviews', label: 'Kiểm duyệt đánh giá', icon: MessageSquareOff },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { ready } = useRequireAuth();
  const { hasRole } = useAuth();
  if (!ready) return <LoadingBlock className="min-h-dvh" />;
  if (!hasRole('admin')) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <ShieldAlert className="size-12 text-danger" />
        <h1 className="text-xl font-semibold">Không có quyền truy cập</h1>
        <p className="text-sm text-muted">Trang quản trị chỉ dành cho tài khoản admin.</p>
        <LinkButton href="/" variant="outline">Về trang chủ</LinkButton>
      </div>
    );
  }
  return <DashShell title="Quản trị ShopNow" nav={NAV}>{children}</DashShell>;
}

