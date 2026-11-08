import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-5xl font-bold text-primary">404</p>
      <h1 className="text-lg font-semibold">Không tìm thấy trang</h1>
      <p className="text-sm text-muted">Trang bạn tìm có thể đã bị xoá hoặc đường dẫn chưa đúng.</p>
      <Link href="/" className="mt-2 inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg">Về trang chủ</Link>
    </main>
  );
}
