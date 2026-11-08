'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Search, Unlock, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmSheet, EmptyState, PageTitle, Pagination, QueryView } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray, formatDate, pick, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { Role } from '@/lib/types';

interface AdminUser { id: string; email: string; fullName?: string; roles?: Role[]; disabled?: boolean; lockedUntil?: string | null; emailVerified?: boolean; totpEnabled?: boolean; lastLoginAt?: string | null; createdAt: string }

const ROLE_LABEL: Record<string, string> = { buyer: 'Người mua', seller: 'Người bán', admin: 'Admin' };
const isLocked = (u: AdminUser) => !!u.disabled;

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<AdminUser | null>(null);
  const pageSize = 20;
  useEffect(() => { const t = setTimeout(() => { setDq(term.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [term]);
  const q = useQuery({
    queryKey: ['admin-users', dq, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/identity/admin/users', { q: dq || undefined, page, pageSize });
      return { items: asArray<AdminUser>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  const lock = useMutation({
    mutationFn: (u: AdminUser) => api.post(`/identity/admin/users/${u.id}/${isLocked(u) ? 'unlock' : 'lock'}`),
    onSuccess: (_d, u) => { toast.success(isLocked(u) ? 'Đã mở khoá tài khoản' : 'Đã khoá tài khoản'); setTarget(null); void qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });

  return (
    <div>
      <PageTitle>Người dùng</PageTitle>
      <div className="mb-3 flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-3 md:max-w-sm">
        <Search className="size-4 shrink-0 text-muted" />
        <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Tìm theo email hoặc tên" aria-label="Tìm người dùng" className="h-full min-w-0 flex-1 bg-transparent outline-none" />
      </div>
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<Users className="size-6" />} title="Không có người dùng" />}>
        {(d) => (
          <>
            <DataTable
              rows={d.items}
              rowKey={(u) => u.id}
              columns={[
                { key: 'email', header: 'Tài khoản', primary: true, cell: (u) => <span className="block min-w-0"><span className="block break-all">{u.email}</span>{u.fullName && <span className="block truncate text-xs font-normal text-muted">{u.fullName}</span>}</span> },
                { key: 'state', header: 'Trạng thái', badge: true, cell: (u) => (isLocked(u) ? <Badge tone="danger">Đã khoá</Badge> : u.lockedUntil ? <Badge tone="warning">Tạm khoá đăng nhập</Badge> : <Badge tone="success">Hoạt động</Badge>) },
                { key: 'roles', header: 'Vai trò', cell: (u) => <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">{(u.roles ?? ['buyer']).map((r) => <Badge key={r} tone={r === 'admin' ? 'primary' : r === 'seller' ? 'info' : 'neutral'}>{ROLE_LABEL[r] ?? r}</Badge>)}</span> },
                { key: 'verified', header: 'Email', cell: (u) => (u.emailVerified === false ? 'Chưa xác thực' : 'Đã xác thực') },
                { key: 'login', header: 'Đăng nhập gần nhất', cell: (u) => formatDate(u.lastLoginAt) },
                { key: 'created', header: 'Ngày tạo', cell: (u) => formatDate(u.createdAt, false) },
              ]}
              actions={(u) => !(u.roles ?? []).includes('admin') && (
                <Button size="sm" variant={isLocked(u) ? 'outline' : 'danger'} onClick={() => setTarget(u)}>
                  {isLocked(u) ? <><Unlock className="size-4" /> Mở khoá</> : <><Lock className="size-4" /> Khoá</>}
                </Button>
              )}
            />
            <Pagination className="mt-4" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} />
          </>
        )}
      </QueryView>
      <ConfirmSheet open={!!target} onClose={() => setTarget(null)} danger={!!target && !isLocked(target)}
        title={target && isLocked(target) ? 'Mở khoá tài khoản' : 'Khoá tài khoản'}
        message={target && (isLocked(target) ? `Cho phép ${target.email} đăng nhập trở lại?` : `${target.email} sẽ bị đăng xuất và không thể đăng nhập.`)}
        confirmText={target && isLocked(target) ? 'Mở khoá' : 'Khoá'} loading={lock.isPending} onConfirm={() => target && lock.mutate(target)} />
    </div>
  );
}
