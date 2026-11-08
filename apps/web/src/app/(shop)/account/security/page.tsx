'use client';

import { useMutation } from '@tanstack/react-query';
import { KeyRound, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Field, Input, PageTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';

function ChangePassword() {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/identity/auth/change-password', { currentPassword: cur, newPassword: pw }),
    onSuccess: () => { toast.success('Đã đổi mật khẩu'); setCur(''); setPw(''); setPw2(''); },
  });
  const err = !pw ? null : pw.length < 8 ? 'Mật khẩu tối thiểu 8 ký tự'
    : !/[A-Za-z]/.test(pw) || !/\d/.test(pw) ? 'Cần có cả chữ cái và chữ số'
    : pw2 && pw !== pw2 ? 'Mật khẩu nhập lại không khớp' : null;
  return (
    <Card className="p-4">
      <h2 className="mb-1 flex items-center gap-2 font-semibold"><KeyRound className="size-5 text-primary" /> Đổi mật khẩu</h2>
      <p className="mb-4 text-sm text-muted">Quên mật khẩu hiện tại? <Link href="/forgot-password" className="text-primary underline">Đặt lại qua email</Link></p>
      <form className="grid gap-3 sm:max-w-md" onSubmit={(e) => { e.preventDefault(); if (!err) m.mutate(); }}>
        <Field label="Mật khẩu hiện tại"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="Mật khẩu mới" hint="Tối thiểu 8 ký tự, gồm chữ cái và chữ số"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Nhập lại mật khẩu mới" error={err}><Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
        <div><Button type="submit" loading={m.isPending} disabled={!cur || !pw || !!err || pw !== pw2}>Đổi mật khẩu</Button></div>
      </form>
    </Card>
  );
}

function TwoFactor({ enabled }: { enabled?: boolean }) {
  const { reloadMe } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const start = useMutation({ mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/identity/auth/2fa/setup'), onSuccess: setSetup });
  const [offCode, setOffCode] = useState('');
  const disable = useMutation({
    mutationFn: () => api.post('/identity/auth/2fa/disable', { code: offCode.trim() }),
    onSuccess: () => { toast.success('Đã tắt xác thực 2 lớp'); setOffCode(''); void reloadMe(); },
  });
  const enable = useMutation({
    mutationFn: () => api.post('/identity/auth/2fa/enable', { code: code.trim() }),
    onSuccess: () => { toast.success('Đã bật xác thực 2 lớp'); setSetup(null); setCode(''); void reloadMe(); },
  });
  return (
    <Card className="p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-5 text-primary" /> Xác thực 2 lớp (TOTP)</h2>
        {enabled && <Badge tone="success">Đang bật</Badge>}
      </div>
      <p className="mb-4 text-sm text-muted">Dùng Google Authenticator, Authy… để tạo mã 6 số khi đăng nhập.</p>
      {enabled ? (
        <form className="flex gap-2 sm:max-w-md" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
          <Input value={offCode} onChange={(e) => setOffCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="Mã 6 số để tắt" aria-label="Mã xác thực để tắt 2FA" />
          <Button type="submit" variant="outline" className="shrink-0" loading={disable.isPending} disabled={offCode.length !== 6}>Tắt 2FA</Button>
        </form>
      ) : !setup ? (
        <Button loading={start.isPending} onClick={() => start.mutate()}>Bật xác thực 2 lớp</Button>
      ) : (
        <div className="space-y-3 sm:max-w-md">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Mở ứng dụng xác thực, chọn thêm tài khoản bằng khoá thiết lập.</li>
            <li>Nhập khoá bên dưới (hoặc bấm “Mở ứng dụng” trên điện thoại).</li>
            <li>Nhập mã 6 số ứng dụng hiển thị để xác nhận.</li>
          </ol>
          <div className="rounded-lg bg-surface-2 p-3">
            <p className="text-xs text-muted">Khoá thiết lập</p>
            <p className="select-all break-all font-mono text-sm">{setup.secret}</p>
          </div>
          <a href={setup.otpauthUrl} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline">Mở ứng dụng xác thực</a>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="Mã 6 số" aria-label="Mã xác thực" />
            <Button type="submit" className="shrink-0" loading={enable.isPending} disabled={code.length !== 6}>Xác nhận</Button>
          </form>
        </div>
      )}
    </Card>
  );
}

export default function SecurityPage() {
  const { user } = useAuth();
  return (
    <div className="space-y-4">
      <PageTitle back="/account">Mật khẩu & bảo mật</PageTitle>
      {user && <ChangePassword />}
      <TwoFactor enabled={user?.twoFactorEnabled} />
    </div>
  );
}
