'use client';

import type { ChangeEvent, FormEvent } from 'react';

import { MailCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Button, Field, Input, LoadingBlock } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toast } from '@/lib/toast';

function VerifyForm() {
  const sp = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState(sp.get('email') ?? '');
  const [code, setCode] = useState(sp.get('code') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const resend = async () => {
    if (!email.trim()) { setError('Nhập email để nhận mã'); return; }
    setSending(true);
    setError(null);
    try {
      const r = await api.post<{ devOtp?: string }>('/identity/auth/resend-otp', { email: email.trim() }, { silent: true });
      if (r?.devOtp) setCode(r.devOtp);
      toast.success('Đã gửi lại mã OTP');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };
  // Từ trang đăng nhập (EMAIL_NOT_VERIFIED) → gửi mã mới luôn
  const auto = useRef(false);
  useEffect(() => {
    if (sp.get('resend') && !auto.current) { auto.current = true; void resend(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/identity/auth/verify-email', { email: email.trim(), code: code.trim() }, { silent: true });
      toast.success('Xác thực email thành công, mời bạn đăng nhập');
      router.replace(`/login?email=${encodeURIComponent(email.trim())}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary"><MailCheck className="size-6" /></span>
        <h1 className="text-xl font-semibold">Xác thực email</h1>
        <p className="text-sm text-muted">Nhập mã OTP 6 số đã gửi tới email của bạn.</p>
      </div>
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>}
      <Field label="Email"><Input type="email" inputMode="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      <Field label="Mã OTP">
        <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} inputMode="numeric" autoComplete="one-time-code" maxLength={8} required className="text-center font-mono tracking-[0.4em]" />
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={busy}>Xác thực</Button>
      <Button variant="ghost" className="w-full" loading={sending} onClick={resend}>Gửi lại mã</Button>
    </form>
  );
}

export default function VerifyEmailPage() {
  return <Suspense fallback={<LoadingBlock />}><VerifyForm /></Suspense>;
}
