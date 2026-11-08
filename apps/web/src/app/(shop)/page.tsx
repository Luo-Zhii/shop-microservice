'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { ProductGrid, ProductGridSkeleton } from '@/components/product-card';
import { BannerCarousel, CategoryStrip, FlashSaleSection } from '@/components/shop/home-parts';
import { EmptyState, ErrorState, SectionTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray, pick } from '@/lib/format';
import { fetchProductsByIds } from '@/lib/hooks';
import type { Banner, Category, FlashSale, ProductLike } from '@/lib/types';

interface HomeData {
  degraded: string[];
  banners: Banner[];
  categories: Category[];
  flashSale: FlashSale | null;
  recommendations: ProductLike[];
  newProducts: ProductLike[];
}

function normFlash(v: unknown): FlashSale | null {
  const f = (Array.isArray(v) ? v[0] : v) as FlashSale | undefined;
  if (!f || !f.endsAt) return null;
  return { ...f, items: asArray(f.items ?? f) };
}

async function loadHome(): Promise<HomeData> {
  let data: HomeData;
  try {
    const r = await api.get<Record<string, unknown>>('/bff/home');
    data = {
      degraded: asArray<string>(r.degraded),
      banners: asArray<Banner>(r.banners),
      categories: asArray<Category>(r.categories),
      flashSale: normFlash(pick(r, 'flashSale', 'flashSales')),
      recommendations: asArray<ProductLike>(pick(r, 'recommendations', 'recommended', 'forYou', 'suggestions')),
      newProducts: asArray<ProductLike>(pick(r, 'newProducts', 'newest', 'latest', 'products')),
    };
  } catch (e) {
    // BFF chết → ghép từ từng service (mỗi nguồn lỗi vẫn hiển thị phần còn lại)
    const [b, c, f, n] = await Promise.allSettled([
      api.get('/catalog/banners'),
      api.get('/catalog/categories'),
      api.get('/promotion/flash-sales/active'),
      api.get('/catalog/products', { sort: 'newest', pageSize: 12 }),
    ]);
    if ([b, c, f, n].every((x) => x.status === 'rejected')) throw e;
    const val = (x: PromiseSettledResult<unknown>) => (x.status === 'fulfilled' ? x.value : null);
    data = {
      degraded: ['bff'],
      banners: asArray<Banner>(val(b)),
      categories: asArray<Category>(val(c)),
      flashSale: normFlash(asArray(val(f))[0] ?? val(f)),
      recommendations: [],
      newProducts: asArray<ProductLike>(val(n)),
    };
  }
  // Flash sale chỉ có productId/skuId/salePrice → lấy tiêu đề, ảnh, giá gốc từ catalog
  if (data.flashSale?.items.length) {
    const known = new Map([...data.newProducts, ...data.recommendations].map((p) => [p.id, p]));
    const missing = data.flashSale.items.map((i) => i.productId ?? '').filter((id) => id && !known.has(id));
    for (const [id, p] of await fetchProductsByIds(missing)) known.set(id, p);
    data.flashSale = {
      ...data.flashSale,
      items: data.flashSale.items
        .map((i) => ({ ...i, product: i.product ?? known.get(i.productId ?? '') }))
        .filter((i) => i.product || i.title),
    };
  }
  return data;
}

export default function HomePage() {
  const q = useQuery({ queryKey: ['home'], queryFn: loadHome });

  if (q.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="aspect-[16/7] w-full md:aspect-[16/5]" />
        <Skeleton className="h-28 w-full" />
        <ProductGridSkeleton />
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const nothing = !d.recommendations.length && !d.newProducts.length;

  return (
    <div className="space-y-4 md:space-y-6">
      {d.degraded.length > 0 && (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">Một số mục đang tạm thời không tải được ({d.degraded.length}). Trang vẫn hiển thị phần còn lại.</p>
      )}
      <BannerCarousel banners={d.banners} />
      <CategoryStrip categories={d.categories} />
      {d.flashSale && <FlashSaleSection sale={d.flashSale} />}
      {d.recommendations.length > 0 && (
        <section>
          <SectionTitle>Gợi ý hôm nay</SectionTitle>
          <ProductGrid items={d.recommendations} />
        </section>
      )}
      {d.newProducts.length > 0 && (
        <section>
          <SectionTitle action={<Link href="/search?sort=newest" className="inline-flex min-h-11 items-center gap-0.5 text-sm text-primary">Xem thêm <ChevronRight className="size-4" /></Link>}>
            Sản phẩm mới
          </SectionTitle>
          <ProductGrid items={d.newProducts} />
        </section>
      )}
      {nothing && <EmptyState title="Chưa có sản phẩm" description="Sàn đang cập nhật hàng hoá, vui lòng quay lại sau." />}
    </div>
  );
}
