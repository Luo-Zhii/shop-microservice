import Link from 'next/link';
import { Star } from 'lucide-react';
import { formatCompact, formatVND, productHref, productImage } from '@/lib/format';
import type { ProductLike } from '@/lib/types';
import { Img, Skeleton, cn } from './ui';

export function ProductCard({ p, className }: { p: ProductLike & { productId?: string }; className?: string }) {
  const price = p.salePrice ?? p.minPrice ?? p.price ?? 0;
  const compare = p.salePrice ? (p.minPrice ?? p.price) : p.compareAtPrice;
  const off = compare && compare > price ? Math.round((1 - price / compare) * 100) : 0;
  return (
    <Link href={productHref(p)} className={cn('group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface transition hover:shadow-md active:scale-[0.99]', className)}>
      <div className="relative">
        <Img src={productImage(p)} alt={p.title} rounded="rounded-none" />
        {off > 0 && <span className="absolute right-1.5 top-1.5 rounded-md bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-fg">-{off}%</span>}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <p className="line-clamp-2 min-h-10 text-sm leading-5">{p.title}</p>
        <div className="mt-auto flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-semibold text-primary">{formatVND(price)}</span>
          {p.maxPrice && p.maxPrice > price && !p.salePrice ? <span className="text-xs text-muted">+</span> : null}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted">
          {(p.ratingAvg ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5"><Star className="size-3 fill-amber-400 text-amber-400" />{p.ratingAvg!.toFixed(1)}</span>
          )}
          <span className="truncate">Đã bán {formatCompact(p.soldCount)}</span>
        </div>
      </div>
    </Link>
  );
}

export function ProductGrid({ items, className }: { items: (ProductLike & { productId?: string })[]; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6', className)}>
      {items.map((p, i) => <ProductCard key={`${p.id}-${i}`} p={p} />)}
    </div>
  );
}

export function ProductGridSkeleton({ n = 10 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-border bg-surface">
          <Skeleton className="aspect-square rounded-none" />
          <div className="space-y-2 p-2.5"><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>
        </div>
      ))}
    </div>
  );
}
