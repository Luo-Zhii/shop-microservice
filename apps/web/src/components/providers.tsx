'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { dismissToast, subscribeToasts, type ToastItem } from '@/lib/toast';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Không thử lại lỗi 4xx; lỗi mạng/5xx thử 1 lần
        retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status >= 400 && e.status < 500),
      },
      mutations: { retry: false },
    },
  }));
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        {children}
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-4 pt-[calc(var(--safe-top)+12px)]"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className="pointer-events-auto flex w-full max-w-md animate-fade-in items-start gap-3 rounded-xl border border-border bg-surface p-3 text-sm shadow-lg"
        >
          {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
            : t.kind === 'error' ? <XCircle className="mt-0.5 size-5 shrink-0 text-danger" />
            : <Info className="mt-0.5 size-5 shrink-0 text-info" />}
          <p className="min-w-0 flex-1 break-words">{t.message}</p>
          <button type="button" aria-label="Đóng" onClick={() => dismissToast(t.id)} className="-m-2 grid size-9 shrink-0 place-items-center rounded-lg text-muted active:bg-surface-2">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
