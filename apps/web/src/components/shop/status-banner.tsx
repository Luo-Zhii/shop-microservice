'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LEVEL, usePublicStatus } from '@/lib/status';

/** Dải thông báo mảnh đầu trang khi có sự cố đã công bố — lối vào /status (footer bị ẩn trên điện thoại). */
export function StatusBanner() {
  const q = usePublicStatus();
  const path = usePathname();
  const d = q.data;
  if (!d || d.overall === 'operational' || path === '/status') return null;
  const inc = d.active_incidents[0];
  return (
    <Link href="/status" className="block bg-warning-soft px-4 py-2 text-center text-sm text-fg hover:underline">
      <span className="break-words">{inc ? `${inc.title} — ` : `${LEVEL[d.overall].label}. `}Xem trạng thái hệ thống</span>
    </Link>
  );
}
