'use client';

import { Activity, BookOpenCheck, ClipboardList, FolderTree, Image as ImageIcon, LayoutDashboard, MessageSquareOff, Package, ShieldAlert, Store, Ticket, Truck, Users, Wallet, Warehouse, Zap } from 'lucide-react';
import { usePathname } from 'next/navigation';
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
  { href: '/admin/accounting', label: 'Kế toán', icon: BookOpenCheck },
  { href: '/admin/warehouse', label: 'Kho sàn', icon: Warehouse },
  { href: '/admin/shipping', label: 'Vận chuyển', icon: Truck },
  { href: '/admin/aiops', label: 'AIOps', icon: Activity },
];
/** Vai trò nghiệp vụ chỉ thấy đúng phân hệ của mình (phân quyền chi tiết vẫn do backend kiểm). */
const SCOPED: Record<'accountant' | 'warehouse', string> = { accountant: '/admin/accounting', warehouse: '/admin/warehouse' };

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { ready } = useRequireAuth();
  const { hasRole } = useAuth();
  const pathname = usePathname();
  if (!ready) return <LoadingBlock className="min-h-dvh" />;
  const isAdmin = hasRole('admin');
  const scoped = (['accountant', 'warehouse'] as const).filter((r) => hasRole(r)).map((r) => SCOPED[r]);
  const allowed = isAdmin || scoped.some((p) => pathname.startsWith(p));
  if (!allowed) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <ShieldAlert className="size-12 text-danger" />
        <h1 className="text-xl font-semibold">Không có quyền truy cập</h1>
        <p className="text-sm text-muted">Trang này không thuộc quyền của tài khoản bạn.</p>
        <LinkButton href="/" variant="outline">Về trang chủ</LinkButton>
      </div>
    );
  }
  const nav = isAdmin ? NAV : NAV.filter((n) => scoped.includes(n.href));
  return <DashShell title={isAdmin ? 'Quản trị ShopNow' : 'Vận hành ShopNow'} nav={nav}>{children}</DashShell>;
}

