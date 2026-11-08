'use client';

import type { ChangeEvent, FormEvent } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pwErr = !form.password ? null : form.password.length < 8 ? 'Tối thiểu 8 ký tự'
    : !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password) ? 'Mật khẩu phải có cả chữ cái và chữ số' : null;
  const cfErr = form.confirm && form.confirm !== form.password ? 'Mật khẩu nhập lại không khớp' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pwErr || cfErr) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ userId: string; devOtp?: string }>('/identity/auth/register', {
        email: form.email.trim(), password: form.password, fullName: form.fullName.trim(),
      }, { silent: true });
      const qs = new URLSearchParams({ email: form.email.trim() });
      if (r?.devOtp) qs.set('code', r.devOtp);
      router.push(`/verify-email?${qs.toString()}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <form onSubmit={submit} className="space-y-4">
      <div><h1 className="text-xl font-semibold">Tạo tài khoản</h1><p className="text-sm text-muted">Mua sắm và mở shop trên ShopNow</p></div>
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>}
      <Field label="Họ tên"><Input value={form.fullName} onChange={set('fullName')} autoComplete="name" required minLength={2} /></Field>
      <Field label="Email"><Input type="email" inputMode="email" autoCapitalize="off" autoComplete="email" value={form.email} onChange={set('email')} required /></Field>
      <Field label="Mật khẩu" error={pwErr} hint="Tối thiểu 8 ký tự, gồm cả chữ cái và chữ số"><Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required /></Field>
      <Field label="Nhập lại mật khẩu" error={cfErr}><Input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required /></Field>
      <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!!pwErr || !!cfErr}>Đăng ký</Button>
      <p className="text-center text-sm">Đã có tài khoản? <Link href="/login" className="inline-flex min-h-11 items-center font-medium text-primary">Đăng nhập</Link></p>
    </form>
  );
}
