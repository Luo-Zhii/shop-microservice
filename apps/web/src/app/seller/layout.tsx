'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, ClipboardList, Clock, LayoutDashboard, MessageSquare, Package, RefreshCw, Settings, Store, Ticket, Wallet, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DashShell, type NavItem } from '@/components/dash-shell';
import { ShopForm } from '@/components/seller/shop-form';
import { Button, Card, ErrorState, LinkButton, LoadingBlock } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useAuth, useRequireAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';
import type { Shop } from '@/lib/types';

const NAV: NavItem[] = [
  { href: '/seller', label: 'Tổng quan', icon: LayoutDashboard, exact: true },
  { href: '/seller/products', label: 'Sản phẩm', icon: Package },
  { href: '/seller/inventory', label: 'Tồn kho', icon: Boxes },
  { href: '/seller/orders', label: 'Đơn hàng', icon: ClipboardList },
  { href: '/seller/vouchers', label: 'Voucher của shop', icon: Ticket },
  { href: '/seller/reviews', label: 'Đánh giá', icon: MessageSquare },
  { href: '/seller/wallet', label: 'Ví & rút tiền', icon: Wallet },
  { href: '/seller/shop', label: 'Hồ sơ shop', icon: Settings },
];

function Center({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-4 py-8 pb-[calc(var(--safe-bottom)+32px)]">{children}</div>;
}

export default function SellerLayout({ children }: { children: ReactNode }) {
  const { ready } = useRequireAuth();
  const { hasRole, user, refresh } = useAuth();
  const qc = useQueryClient();
  const shop = useQuery({
    queryKey: ['my-shop', user?.id],
    enabled: ready,
    retry: false,
    queryFn: async () => {
      try {
        return await api.get<Shop>('/seller/shops/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  const tried = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const approvedNoRole = shop.data?.status === 'APPROVED' && (!hasRole('seller') || !user?.shopId);
  const doRefresh = async () => {
    setRefreshing(true);
    const ok = await refresh();
    setRefreshing(false);
    if (!ok) toast.error('Chưa làm mới được phiên đăng nhập, vui lòng đăng nhập lại');
  };
  // Shop vừa được duyệt → refresh token để nhận role seller + shopId
  useEffect(() => {
    if (approvedNoRole && !tried.current) { tried.current = true; void doRefresh(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvedNoRole]);
  const reload = () => qc.invalidateQueries({ queryKey: ['my-shop'] });

  if (!ready || shop.isPending) return <LoadingBlock className="min-h-dvh" />;
  if (shop.isError) return <Center><ErrorState error={shop.error} onRetry={() => shop.refetch()} /></Center>;

  const s = shop.data;
  if (!s) {
    return (
      <Center>
        <Card className="p-5 sm:p-8">
          <div className="mb-4 flex items-center gap-3">
            <span className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary"><Store className="size-6" /></span>
            <div><h1 className="text-xl font-semibold">Mở shop trên ShopNow</h1><p className="text-sm text-muted">Hồ sơ sẽ được quản trị viên duyệt trong 24 giờ.</p></div>
          </div>
          <ShopForm mode="create" onDone={reload} />
          <LinkButton href="/" variant="ghost" className="mt-3 w-full">Về trang mua sắm</LinkButton>
        </Card>
      </Center>
    );
  }
  if (s.status === 'PENDING') {
    return (
      <Center>
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <Clock className="size-12 text-warning" />
          <h1 className="text-xl font-semibold">Hồ sơ “{s.name}” đang chờ duyệt</h1>
          <p className="text-sm text-muted">Bạn sẽ nhận thông báo khi shop được duyệt. Sau đó tải lại trang này để vào Kênh người bán.</p>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
            <Button variant="outline" onClick={reload} loading={shop.isFetching}><RefreshCw className="size-4" /> Kiểm tra lại</Button>
            <LinkButton href="/" variant="ghost">Về trang mua sắm</LinkButton>
          </div>
        </Card>
      </Center>
    );
  }
  if (s.status === 'REJECTED') {
    return (
      <Center>
        <Card className="p-5 sm:p-8">
          <div className="mb-4 flex items-start gap-3">
            <XCircle className="size-8 shrink-0 text-danger" />
            <div className="min-w-0"><h1 className="text-lg font-semibold">Hồ sơ shop bị từ chối</h1><p className="break-words text-sm text-muted">{s.rejectReason ? `Lý do: ${s.rejectReason}` : 'Vui lòng cập nhật thông tin và gửi lại.'}</p></div>
          </div>
          <ShopForm mode="resubmit" initial={s} onDone={reload} />
        </Card>
      </Center>
    );
  }
  if (s.status === 'SUSPENDED') {
    return (
      <Center>
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <XCircle className="size-12 text-danger" />
          <h1 className="text-xl font-semibold">Shop đang bị tạm khoá</h1>
          <p className="text-sm text-muted">Sản phẩm của shop tạm ẩn khỏi sàn.{s.suspendReason ? ` Lý do: ${s.suspendReason}.` : ''} Liên hệ bộ phận hỗ trợ người bán để được giải quyết.</p>
          <LinkButton href="/" variant="outline">Về trang mua sắm</LinkButton>
        </Card>
      </Center>
    );
  }
  if (approvedNoRole) {
    return (
      <Center>
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <Store className="size-12 text-success" />
          <h1 className="text-xl font-semibold">Shop đã được duyệt!</h1>
          <p className="text-sm text-muted">Đang cập nhật quyền người bán cho tài khoản của bạn…</p>
          <Button loading={refreshing} onClick={doRefresh}><RefreshCw className="size-4" /> Làm mới phiên</Button>
        </Card>
      </Center>
    );
  }
  return <DashShell title={`Kênh người bán · ${s.name}`} nav={NAV}>{children}</DashShell>;
}
