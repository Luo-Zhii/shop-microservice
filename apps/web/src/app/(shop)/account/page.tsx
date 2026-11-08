'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ChevronRight, ClipboardList, Heart, KeyRound, LogOut, MapPin, ShieldCheck, Store } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorState, Field, Input, LoadingBlock, PageTitle, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';
import type { Profile } from '@/lib/types';

const MOBILE_LINKS = [
  { href: '/orders', label: 'Đơn mua', icon: ClipboardList },
  { href: '/account/addresses', label: 'Sổ địa chỉ', icon: MapPin },
  { href: '/account/wishlist', label: 'Sản phẩm yêu thích', icon: Heart },
  { href: '/account/security', label: 'Mật khẩu & xác thực 2 lớp', icon: KeyRound },
  { href: '/notifications', label: 'Thông báo', icon: Bell },
];

export default function AccountPage() {
  const { user, logout, hasRole, reloadMe } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api.get<Profile>('/user-profile/me/profile') });
  const [form, setForm] = useState<Profile>({});
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put('/user-profile/me/profile', {
      fullName: form.fullName?.trim() || undefined, phone: form.phone || null, gender: form.gender || null, birthday: form.birthday || null, avatarUrl: form.avatarUrl || null,
    }),
    onSuccess: () => { toast.success('Đã lưu hồ sơ'); void qc.invalidateQueries({ queryKey: ['profile'] }); void reloadMe(); },
  });

  return (
    <div className="space-y-4">
      <PageTitle>Hồ sơ của tôi</PageTitle>
      <Card className="p-4">
        {q.isPending ? <LoadingBlock /> : q.isError && q.error && (q.error as { status?: number }).status !== 404 ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Email" className="sm:col-span-2"><Input value={user?.email ?? ''} disabled /></Field>
            <Field label="Họ tên"><Input value={form.fullName ?? user?.fullName ?? ''} onChange={(e) => setForm({ ...form, fullName: e.target.value })} autoComplete="name" /></Field>
            <Field label="Số điện thoại"><Input type="tel" inputMode="tel" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" /></Field>
            <Field label="Giới tính">
              <Select value={form.gender ?? ''} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                <option value="">Không muốn nêu</option><option value="male">Nam</option><option value="female">Nữ</option><option value="other">Khác</option>
              </Select>
            </Field>
            <Field label="Ngày sinh"><Input type="date" value={form.birthday?.slice(0, 10) ?? ''} onChange={(e) => setForm({ ...form, birthday: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Button type="submit" loading={save.isPending}>Lưu thay đổi</Button></div>
          </form>
        )}
      </Card>

      <Card className="divide-y divide-border md:hidden">
        {MOBILE_LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="flex min-h-12 items-center gap-3 px-4 text-sm">
            <l.icon className="size-5 text-muted" /><span className="flex-1">{l.label}</span><ChevronRight className="size-4 text-muted" />
          </Link>
        ))}
        <Link href="/seller" className="flex min-h-12 items-center gap-3 px-4 text-sm"><Store className="size-5 text-muted" /><span className="flex-1">{hasRole('seller') ? 'Kênh người bán' : 'Mở shop trên ShopNow'}</span><ChevronRight className="size-4 text-muted" /></Link>
        {hasRole('admin') && <Link href="/admin" className="flex min-h-12 items-center gap-3 px-4 text-sm"><ShieldCheck className="size-5 text-muted" /><span className="flex-1">Trang quản trị</span><ChevronRight className="size-4 text-muted" /></Link>}
        <button type="button" onClick={() => void logout()} className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm text-danger"><LogOut className="size-5" /> Đăng xuất</button>
      </Card>
    </div>
  );
}
