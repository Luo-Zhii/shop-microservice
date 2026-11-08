import type { ReactNode } from 'react';
import { Logo } from '@/components/shop/header';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-primary-soft to-bg">
      <header className="px-4 pt-[calc(var(--safe-top)+16px)] pb-2 sm:px-8"><Logo /></header>
      <main className="flex flex-1 items-start justify-center px-4 py-6 pb-[calc(var(--safe-bottom)+24px)] sm:items-center">
        <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-8">{children}</div>
      </main>
    </div>
  );
}
