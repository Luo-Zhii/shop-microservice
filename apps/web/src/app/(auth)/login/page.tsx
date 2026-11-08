'use client';

import type { ChangeEvent, FormEvent } from 'react';

import { Eye, EyeOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, Field, Input, LoadingBlock } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';

function needsTotp(e: unknown) {
  if (!(e instanceof ApiError)) return false;
  return e.reason === 'TOTP_REQUIRED' || (!e.reason && /2FA|TOTP/i.test(e.message));
}

function safeNext(n: string | null) {
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

function LoginForm() {
  const { login, status } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const next = safeNext(sp.get('next'));
  const [email, setEmail] = useState(sp.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [totp, setTotp] = useState('');
  const [askTotp, setAskTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (status === 'authenticated' && !busy) router.replace(next); }, [status, busy, next, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const u = await login(email.trim(), password, askTotp ? totp.trim() : undefined);
      toast.success(`Xin chào ${u.fullName ?? u.email}!`);
      router.replace(next);
    } catch (err) {
      if (needsTotp(err) && !askTotp) {
        setAskTotp(true);
        setError('Tài khoản đã bật xác thực 2 lớp. Nhập mã 6 số từ ứng dụng xác thực.');
      } else if (err instanceof ApiError && err.reason === 'EMAIL_NOT_VERIFIED') {
        toast('Email chưa được xác thực — nhập mã OTP để kích hoạt tài khoản', 'info');
        router.push(`/verify-email?email=${encodeURIComponent(email.trim())}&resend=1`);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div><h1 className="text-xl font-semibold">Đăng nhập</h1><p className="text-sm text-muted">Chào mừng bạn quay lại ShopNow</p></div>
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>}
      <Field label="Email"><Input type="email" inputMode="email" autoComplete="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      <Field label="Mật khẩu">
        <div className="relative">
          <Input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="pr-12" />
          <button type="button" aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted">
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Field>
      {askTotp ? (
        <Field label="Mã xác thực 2 lớp">
          <Input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus placeholder="6 chữ số" />
        </Field>
      ) : (
        <button type="button" onClick={() => setAskTotp(true)} className="min-h-9 text-xs text-muted underline">Tôi đã bật xác thực 2 lớp</button>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy}>Đăng nhập</Button>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center text-primary">Quên mật khẩu?</Link>
        <Link href={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} className="inline-flex min-h-11 items-center">Chưa có tài khoản? <span className="ml-1 font-medium text-primary">Đăng ký</span></Link>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<LoadingBlock />}><LoginForm /></Suspense>;
}
