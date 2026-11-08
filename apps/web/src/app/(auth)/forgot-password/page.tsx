'use client';

import type { ChangeEvent, FormEvent } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toast } from '@/lib/toast';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'reset'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ devOtp?: string }>('/identity/auth/forgot-password', { email: email.trim() }, { silent: true });
      if (r?.devOtp) setCode(r.devOtp);
      setStep('reset');
      toast.success('Nếu email tồn tại, mã đặt lại đã được gửi');
    });
  };
  const reset = (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) { setError('Mật khẩu tối thiểu 8 ký tự'); return; }
    void run(async () => {
      await api.post('/identity/auth/reset-password', { email: email.trim(), code: code.trim(), newPassword: pw }, { silent: true });
      toast.success('Đặt lại mật khẩu thành công');
      router.replace(`/login?email=${encodeURIComponent(email.trim())}`);
    });
  };

  return (
    <div className="space-y-4">
      <div><h1 className="text-xl font-semibold">Quên mật khẩu</h1><p className="text-sm text-muted">{step === 'email' ? 'Nhập email để nhận mã đặt lại mật khẩu.' : `Nhập mã đã gửi tới ${email}.`}</p></div>
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>}
      {step === 'email' ? (
        <form onSubmit={sendCode} className="space-y-4">
          <Field label="Email"><Input type="email" inputMode="email" autoCapitalize="off" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Button type="submit" size="lg" className="w-full" loading={busy}>Gửi mã</Button>
        </form>
      ) : (
        <form onSubmit={reset} className="space-y-4">
          <Field label="Mã OTP"><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required /></Field>
          <Field label="Mật khẩu mới" hint="Tối thiểu 8 ký tự"><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
          <Button type="submit" size="lg" className="w-full" loading={busy}>Đặt lại mật khẩu</Button>
          <button type="button" className="min-h-11 w-full text-sm text-muted" onClick={() => setStep('email')}>Đổi email</button>
        </form>
      )}
      <p className="text-center text-sm"><Link href="/login" className="inline-flex min-h-11 items-center text-primary">Quay lại đăng nhập</Link></p>
    </div>
  );
}
