'use client';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold">Đã có lỗi xảy ra</h1>
      <p className="break-words text-sm text-muted">{error.message || 'Vui lòng thử lại.'}</p>
      <button type="button" onClick={reset} className="mt-2 inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg">Thử lại</button>
    </main>
  );
}
