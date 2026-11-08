'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { asArray, formatDate, pick, totalPages } from '@/lib/format';
import type { Review, ReviewSummary } from '@/lib/types';
import { EmptyState, ErrorState, Img, LoadingBlock, Pagination, Stars, cn } from '../ui';

export function RatingSummary({ summary, fallbackAvg = 0, fallbackCount = 0 }: { summary: ReviewSummary | null; fallbackAvg?: number; fallbackCount?: number }) {
  const avg = summary?.ratingAvg ?? summary?.avg ?? summary?.average ?? fallbackAvg ?? 0;
  const count = summary?.ratingCount ?? summary?.count ?? summary?.total ?? fallbackCount ?? 0;
  const dist = summary?.distribution ?? summary?.histogram ?? {};
  const max = Math.max(1, ...[1, 2, 3, 4, 5].map((s) => Number(dist[s] ?? 0)));
  return (
    <div className="mb-4 flex flex-col gap-4 rounded-lg bg-primary-soft/40 p-3 sm:flex-row sm:items-center sm:gap-8 md:p-4">
      <div className="text-center sm:min-w-32">
        <p className="text-3xl font-bold text-primary">{avg.toFixed(1)}<span className="text-base font-normal text-muted"> / 5</span></p>
        <Stars value={avg} size="md" />
        <p className="mt-1 text-xs text-muted">{count} đánh giá</p>
      </div>
      <ul className="flex-1 space-y-1">
        {[5, 4, 3, 2, 1].map((s) => {
          const n = Number(dist[s] ?? 0);
          return (
            <li key={s} className="flex items-center gap-2 text-xs">
              <span className="w-8 shrink-0 text-muted">{s} sao</span>
              <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                <span className="block h-full rounded-full bg-amber-400" style={{ width: `${(n / max) * 100}%` }} />
              </span>
              <span className="w-8 shrink-0 text-right text-muted">{n}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function replyText(r: Review): string | null {
  if (!r.reply) return r.sellerReply ?? null;
  return typeof r.reply === 'string' ? r.reply : r.reply.content;
}

export function ReviewItem({ r, actions }: { r: Review; actions?: ReactNode }) {
  const reply = replyText(r);
  return (
    <li className="border-b border-border py-3 last:border-0">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-medium">
          {(r.userName ?? r.authorName ?? 'K').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{r.userName ?? r.authorName ?? 'Khách hàng'}</p>
          <Stars value={r.rating} />
          <p className="text-xs text-muted">{formatDate(r.createdAt)}{r.variantLabel ? ` · ${r.variantLabel}` : ''}</p>
          <p className="mt-1.5 whitespace-pre-line break-words text-sm">{r.content}</p>
          {!!r.images?.length && (
            <div className="mt-2 flex flex-wrap gap-2">
              {r.images.map((src) => (
                <a key={src} href={src} target="_blank" rel="noreferrer" className="block w-16 sm:w-20"><Img src={src} alt="Ảnh đánh giá" /></a>
              ))}
            </div>
          )}
          {reply && (
            <div className="mt-2 rounded-lg bg-surface-2 p-2 text-sm">
              <p className="text-xs font-medium text-muted">Phản hồi của người bán</p>
              <p className="whitespace-pre-line break-words">{reply}</p>
            </div>
          )}
          {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
    </li>
  );
}

export function ReviewList({ productId, renderActions }: { productId: string; renderActions?: (r: Review) => ReactNode }) {
  const [rating, setRating] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const q = useQuery({
    queryKey: ['reviews', productId, rating, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>(`/review/products/${productId}/reviews`, { rating: rating ?? undefined, page, pageSize });
      return { items: asArray<Review>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  return (
    <div>
      <div className="scrollbar-none -mx-3 mb-2 overflow-x-auto px-3 md:mx-0 md:px-0">
        <div className="flex w-max gap-2">
          {[null, 5, 4, 3, 2, 1].map((s) => (
            <button key={s ?? 'all'} type="button" onClick={() => { setRating(s); setPage(1); }}
              className={cn('min-h-10 shrink-0 rounded-lg border px-3 text-sm', rating === s ? 'border-primary bg-primary-soft text-primary' : 'border-border')}>
              {s ? `${s} sao` : 'Tất cả'}
            </button>
          ))}
        </div>
      </div>
      {q.isPending ? <LoadingBlock />
        : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        : q.data.items.length === 0 ? <EmptyState title="Chưa có đánh giá" />
        : (
          <>
            <ul>{q.data.items.map((r) => <ReviewItem key={r.id} r={r} actions={renderActions?.(r)} />)}</ul>
            <Pagination className="mt-3" page={page} pages={totalPages(q.data.total, pageSize)} onChange={setPage} />
          </>
        )}
    </div>
  );
}
