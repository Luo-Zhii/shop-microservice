'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SlidersHorizontal, Star } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ProductGrid, ProductGridSkeleton } from '@/components/product-card';
import { Button, EmptyState, ErrorState, Input, Pagination, Select, Sheet, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray, formatNumber, formatVND, pick, totalPages } from '@/lib/format';
import { flattenCategories, useCategories } from '@/lib/hooks';
import type { ProductLike } from '@/lib/types';

const PAGE_SIZE = 24;
const SORTS = [
  { value: 'relevance', label: 'Liên quan' },
  { value: 'best_selling', label: 'Bán chạy' },
  { value: 'newest', label: 'Mới nhất' },
  { value: 'price_asc', label: 'Giá thấp → cao' },
  { value: 'price_desc', label: 'Giá cao → thấp' },
];
const PRICE_PRESETS = [
  { label: 'Dưới 100k', min: '', max: '100000' },
  { label: '100k – 300k', min: '100000', max: '300000' },
  { label: '300k – 1tr', min: '300000', max: '1000000' },
  { label: 'Trên 1tr', min: '1000000', max: '' },
];

interface Facet { id: string; name: string; count: number }
interface SearchResult { items: ProductLike[]; total: number; facets: { categories: Facet[] } }

function Filters({ params, apply, facets }: {
  params: URLSearchParams; apply: (p: Record<string, string | null>) => void; facets: Facet[];
}) {
  const cats = useCategories();
  const [min, setMin] = useState(params.get('minPrice') ?? '');
  const [max, setMax] = useState(params.get('maxPrice') ?? '');
  useEffect(() => { setMin(params.get('minPrice') ?? ''); setMax(params.get('maxPrice') ?? ''); }, [params]);
  const rating = params.get('rating');
  const categoryId = params.get('categoryId');
  const catOptions = facets.length ? facets : flattenCategories(cats.data ?? []).filter((c) => c.depth === 0).map((c) => ({ id: c.id, name: c.name, count: -1 }));
  const chip = (on: boolean) => cn('min-h-10 rounded-lg border px-3 text-left text-sm', on ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-2');

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Danh mục</h3>
        <div className="flex flex-col gap-1">
          <button type="button" className={chip(!categoryId)} onClick={() => apply({ categoryId: null })}>Tất cả</button>
          {catOptions.map((c) => (
            <button key={c.id} type="button" className={chip(categoryId === c.id)} onClick={() => apply({ categoryId: c.id })}>
              {c.name}{c.count >= 0 && <span className="ml-1 text-xs text-muted">({formatNumber(c.count)})</span>}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Khoảng giá (₫)</h3>
        <div className="flex items-center gap-2">
          <Input inputMode="numeric" placeholder="Từ" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} aria-label="Giá từ" />
          <span className="text-muted">–</span>
          <Input inputMode="numeric" placeholder="Đến" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} aria-label="Giá đến" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {PRICE_PRESETS.map((p) => (
            <button key={p.label} type="button" className={chip(params.get('minPrice') === (p.min || null) && params.get('maxPrice') === (p.max || null))}
              onClick={() => apply({ minPrice: p.min || null, maxPrice: p.max || null })}>{p.label}</button>
          ))}
        </div>
        <Button variant="outline" className="mt-2 w-full" onClick={() => apply({ minPrice: min || null, maxPrice: max || null })}>Áp dụng giá</Button>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Đánh giá</h3>
        <div className="flex flex-col gap-1">
          {[5, 4, 3].map((r) => (
            <button key={r} type="button" className={cn(chip(rating === String(r)), 'inline-flex items-center gap-1')} onClick={() => apply({ rating: rating === String(r) ? null : String(r) })}>
              {Array.from({ length: 5 }, (_, i) => <Star key={i} className={cn('size-4', i < r ? 'fill-amber-400 text-amber-400' : 'text-border')} />)}
              {r < 5 && <span className="ml-1">trở lên</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function SearchView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);
  const page = Math.max(1, Number(params.get('page') ?? 1));
  const sort = params.get('sort') ?? 'relevance';
  const query = Object.fromEntries(params.entries());

  const apply = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch)) next.delete('page');
    router.push(`${pathname}?${next.toString()}`, { scroll: !('page' in patch) ? false : true });
    setSheet(false);
  };

  const q = useQuery({
    queryKey: ['search', query],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const r = await api.get<unknown>('/search/search', { ...query, sort, page, pageSize: PAGE_SIZE }, { signal });
      return {
        items: asArray<ProductLike>(r),
        total: pick<number>(r, 'total') ?? 0,
        facets: { categories: asArray<Facet>(pick(pick(r, 'facets'), 'categories')) },
      } satisfies SearchResult;
    },
  });

  const activeFilters = ['categoryId', 'minPrice', 'maxPrice', 'rating'].filter((k) => params.get(k)).length;
  const priceLabel = params.get('minPrice') || params.get('maxPrice')
    ? `${params.get('minPrice') ? formatVND(Number(params.get('minPrice'))) : '0 ₫'} – ${params.get('maxPrice') ? formatVND(Number(params.get('maxPrice'))) : '∞'}` : null;

  return (
    <div className="md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="hidden md:block">
        <div className="sticky top-24 rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-3 flex items-center gap-2 font-semibold"><SlidersHorizontal className="size-4" /> Bộ lọc</h2>
          <Filters params={params} apply={apply} facets={q.data?.facets.categories ?? []} />
        </div>
      </aside>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 text-base font-semibold md:text-lg">
            {params.get('q') ? <>Kết quả cho “<span className="break-words text-primary">{params.get('q')}</span>”</> : 'Tất cả sản phẩm'}
            {q.data && <span className="ml-2 text-sm font-normal text-muted">{formatNumber(q.data.total)} sản phẩm</span>}
          </h1>
        </div>
        <div className="mb-3 flex items-center gap-2">
          <Button variant="outline" className="md:hidden" onClick={() => setSheet(true)}>
            <SlidersHorizontal className="size-4" /> Lọc{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
          <Select aria-label="Sắp xếp" value={sort} onChange={(e) => apply({ sort: e.target.value })} className="w-auto min-w-0 flex-1 md:max-w-56 md:flex-none">
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
          {priceLabel && <span className="hidden truncate text-sm text-muted lg:inline">Giá: {priceLabel}</span>}
        </div>
        {q.isPending ? <ProductGridSkeleton n={12} />
          : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
          : q.data.items.length === 0 ? (
            <EmptyState title="Không tìm thấy sản phẩm" description="Thử từ khoá khác hoặc bỏ bớt bộ lọc."
              action={activeFilters ? <Button variant="outline" onClick={() => apply({ categoryId: null, minPrice: null, maxPrice: null, rating: null })}>Xoá bộ lọc</Button> : undefined} />
          ) : (
            <div className={cn('transition-opacity', q.isFetching && 'opacity-60')}>
              <ProductGrid items={q.data.items} className="md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" />
              <Pagination className="mt-6" page={page} pages={totalPages(q.data.total, PAGE_SIZE)} onChange={(p) => apply({ page: String(p) })} />
            </div>
          )}
      </div>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Bộ lọc" footer={(
        <Button variant="outline" className="w-full" onClick={() => apply({ categoryId: null, minPrice: null, maxPrice: null, rating: null })}>Xoá tất cả bộ lọc</Button>
      )}>
        <Filters params={params} apply={apply} facets={q.data?.facets.categories ?? []} />
      </Sheet>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<ProductGridSkeleton n={12} />}>
      <SearchView />
    </Suspense>
  );
}
