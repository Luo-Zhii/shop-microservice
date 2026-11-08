'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, ShoppingCart, Store, Zap } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ProductGrid } from '@/components/product-card';
import { Countdown } from '@/components/shop/home-parts';
import { ReviewList, RatingSummary } from '@/components/shop/reviews';
import { Badge, Button, Card, ErrorState, Img, QtyStepper, SectionTitle, Skeleton, Stars, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { asArray, formatCompact, formatVND, pick } from '@/lib/format';
import { useAddToCart } from '@/lib/hooks';
import { writeSelection } from '@/lib/cart';
import { toast } from '@/lib/toast';
import type { ProductLike, ProductSnapshot, ReviewSummary, Shop } from '@/lib/types';

interface FlashInfo { endsAt: string; bySku: Map<string, { salePrice: number; quota?: number; sold?: number }> }
interface Detail {
  product: ProductSnapshot;
  stock: Map<string, number>;
  summary: ReviewSummary | null;
  flash: FlashInfo | null;
  recommendations: ProductLike[];
  shop: Partial<Shop> | null;
}

function normDetail(r: Record<string, unknown>): Detail {
  const product = (r.product ?? (r.title ? r : null)) as ProductSnapshot | null;
  if (!product) throw new Error('Không tìm thấy sản phẩm');
  product.variants = asArray(product.variants);
  product.images = asArray(product.images);
  const stock = new Map<string, number>();
  const rawStock = pick<unknown>(r, 'stock', 'inventory');
  if (Array.isArray(rawStock)) {
    for (const s of rawStock as { skuId: string; available?: number; onHand?: number }[]) stock.set(s.skuId, s.available ?? s.onHand ?? 0);
  } else if (rawStock && typeof rawStock === 'object') {
    for (const [k, v] of Object.entries(rawStock as Record<string, unknown>)) stock.set(k, typeof v === 'number' ? v : Number((v as { available?: number })?.available ?? 0));
  }
  let flash: FlashInfo | null = null;
  const f = pick<Record<string, unknown>>(r, 'flashSale', 'flash');
  if (f) {
    const bySku = new Map<string, { salePrice: number; quota?: number; sold?: number }>();
    const items = asArray<{ skuId?: string; salePrice: number; quota?: number; sold?: number }>(f.items ?? (f.skuId ? [f] : []));
    for (const it of items) if (it.skuId) bySku.set(it.skuId, it);
    if (bySku.size && f.endsAt) flash = { endsAt: String(f.endsAt), bySku };
  }
  return {
    product,
    stock,
    summary: (pick<ReviewSummary>(r, 'reviewSummary', 'reviews', 'summary', 'rating') as ReviewSummary) ?? null,
    flash,
    recommendations: asArray<ProductLike>(pick(r, 'recommendations', 'related', 'similar')),
    shop: pick<Partial<Shop>>(r, 'shop') ?? null,
  };
}

function Gallery({ images, title }: { images: string[]; title: string }) {
  const [i, setI] = useState(0);
  const list = images.length ? images : [''];
  return (
    <div className="min-w-0">
      <div className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto rounded-xl md:hidden"
        onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}>
        {list.map((src, k) => <div key={k} className="w-full shrink-0 snap-start"><Img src={src} alt={`${title} ${k + 1}`} rounded="rounded-none" /></div>)}
      </div>
      <p className="mt-1 text-center text-xs text-muted md:hidden">{i + 1} / {list.length}</p>
      <div className="hidden md:block">
        <Img src={list[i]} alt={title} rounded="rounded-xl" />
        {list.length > 1 && (
          <div className="mt-2 grid grid-cols-5 gap-2">
            {list.map((src, k) => (
              <button key={k} type="button" onClick={() => setI(k)} aria-label={`Ảnh ${k + 1}`}
                className={cn('rounded-lg border-2', k === i ? 'border-primary' : 'border-transparent')}>
                <Img src={src} alt="" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { status } = useAuth();
  const add = useAddToCart();
  const q = useQuery({
    queryKey: ['product', slug],
    queryFn: async () => normDetail(await api.get<Record<string, unknown>>(`/bff/products/${encodeURIComponent(slug)}`)),
  });
  const product = q.data?.product;
  const active = useMemo(() => product?.variants.filter((v) => v.status !== 'INACTIVE') ?? [], [product]);
  const optionNames = useMemo(() => [...new Set(active.flatMap((v) => Object.keys(v.options ?? {})))], [active]);
  const [sel, setSel] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);

  useEffect(() => {
    if (active.length === 1) setSel({ ...active[0].options });
  }, [active]);

  // Ghi "đã xem gần đây"
  useEffect(() => {
    if (product?.id && status === 'authenticated') {
      api.post('/user-profile/me/recently-viewed', { productId: product.id }, { silent: true }).catch(() => undefined);
    }
  }, [product?.id, status]);

  const wish = useQuery({
    queryKey: ['wishlist'],
    enabled: status === 'authenticated',
    queryFn: async () => asArray<{ productId?: string; id?: string }>(await api.get('/user-profile/me/wishlist')),
  });
  const inWish = !!product && !!wish.data?.some((w) => (w.productId ?? w.id) === product.id);
  const toggleWish = useMutation({
    mutationFn: () => (inWish ? api.del(`/user-profile/me/wishlist/${product!.id}`) : api.post('/user-profile/me/wishlist', { productId: product!.id })),
    onSuccess: () => { toast.success(inWish ? 'Đã bỏ khỏi yêu thích' : 'Đã thêm vào yêu thích'); void qc.invalidateQueries({ queryKey: ['wishlist'] }); },
  });

  if (q.isPending) {
    return (
      <div className="grid gap-4 md:grid-cols-2 md:gap-8">
        <Skeleton className="aspect-square w-full" />
        <div className="space-y-3"><Skeleton className="h-7 w-3/4" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-12 w-1/3" /><Skeleton className="h-32" /></div>
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { stock, flash, summary, recommendations, shop } = q.data;
  const p = q.data.product;

  const variant = active.find((v) => optionNames.every((k) => v.options?.[k] === sel[k])) ?? (optionNames.length === 0 ? active[0] : undefined);
  const avail = variant ? stock.get(variant.id) : undefined;
  const totalAvail = active.reduce((n, v) => n + (stock.get(v.id) ?? 0), 0);
  const flashFor = variant && flash?.bySku.get(variant.id);
  const anyFlash = flash && [...flash.bySku.values()][0];
  const price = flashFor ? flashFor.salePrice : variant?.price ?? p.minPrice;
  const compareAt = flashFor ? variant?.price : variant?.compareAtPrice;
  const outOfStock = variant ? (avail !== undefined && avail <= 0) : stock.size > 0 && totalAvail <= 0;
  const maxQty = avail !== undefined ? Math.max(1, avail) : 99;
  const unavailable = p.status !== 'APPROVED' && p.status !== undefined;

  const isValueAvailable = (name: string, value: string) =>
    active.some((v) => v.options?.[name] === value
      && optionNames.every((k) => k === name || !sel[k] || v.options?.[k] === sel[k])
      && (stock.size === 0 || (stock.get(v.id) ?? 0) > 0));

  const doAdd = async (buyNow: boolean) => {
    if (!variant) { toast.error('Vui lòng chọn phân loại hàng'); return; }
    await add.mutateAsync({ skuId: variant.id, qty, silent: buyNow });
    if (buyNow) {
      writeSelection([variant.id]);
      router.push('/checkout');
    }
  };

  const rAvg = summary?.ratingAvg ?? summary?.avg ?? summary?.average ?? p.ratingAvg;
  const rCount = summary?.ratingCount ?? summary?.count ?? summary?.total ?? p.ratingCount;

  return (
    <div className="space-y-4 md:space-y-6">
      <nav aria-label="Đường dẫn" className="scrollbar-none overflow-x-auto whitespace-nowrap text-xs text-muted">
        <Link href="/" className="hover:text-primary">Trang chủ</Link>
        {p.categoryPath?.map((c) => <span key={c}> / {c}</span>)}
      </nav>

      <Card className="grid gap-4 p-3 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-8 md:p-6">
        <Gallery images={p.images} title={p.title} />
        <div className="min-w-0 space-y-4">
          <div>
            <h1 className="break-words text-lg font-semibold leading-snug md:text-2xl">{p.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {!!rCount && <span className="inline-flex items-center gap-1"><span className="font-medium text-fg">{(rAvg ?? 0).toFixed(1)}</span><Stars value={rAvg} /></span>}
              <span>{formatCompact(rCount)} đánh giá</span>
              <span>Đã bán {formatCompact(p.soldCount)}</span>
              {p.brand && <span>Thương hiệu: <span className="text-fg">{p.brand}</span></span>}
            </div>
          </div>

          {(flashFor || anyFlash) && flash && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gradient-to-r from-primary to-orange-400 px-3 py-2 text-white">
              <span className="inline-flex items-center gap-1 font-bold uppercase"><Zap className="size-4 fill-white" /> Flash sale</span>
              <span className="inline-flex items-center gap-2 text-xs">Kết thúc sau <Countdown endsAt={flash.endsAt} /></span>
            </div>
          )}

          <div className="rounded-lg bg-surface-2 px-3 py-3">
            {variant ? (
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-semibold text-primary md:text-3xl">{formatVND(price)}</span>
                {compareAt && compareAt > price && <span className="text-sm text-muted line-through">{formatVND(compareAt)}</span>}
              </span>
            ) : (
              <span className="text-2xl font-semibold text-primary md:text-3xl">
                {formatVND(p.minPrice)}{p.maxPrice > p.minPrice && <> – {formatVND(p.maxPrice)}</>}
              </span>
            )}
          </div>

          {optionNames.map((name) => {
            const values = [...new Set(active.map((v) => v.options?.[name]).filter(Boolean) as string[])];
            return (
              <div key={name}>
                <p className="mb-2 text-sm text-muted">{name}</p>
                <div className="flex flex-wrap gap-2">
                  {values.map((val) => {
                    const on = sel[name] === val;
                    const ok = isValueAvailable(name, val);
                    return (
                      <button key={val} type="button" aria-pressed={on} disabled={!ok && !on}
                        onClick={() => setSel((s) => ({ ...s, [name]: on ? '' : val }))}
                        className={cn('min-h-11 min-w-11 rounded-lg border px-3 text-sm transition md:min-h-10',
                          on ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:border-primary',
                          !ok && 'cursor-not-allowed opacity-40 line-through')}>
                        {val}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">Số lượng</span>
            <QtyStepper value={qty} onChange={setQty} max={maxQty} disabled={outOfStock} />
            <span className="text-sm text-muted">
              {variant
                ? (avail === undefined ? '' : avail > 0 ? `${avail} sản phẩm có sẵn` : 'Hết hàng')
                : stock.size ? `${totalAvail} sản phẩm có sẵn` : ''}
            </span>
          </div>

          {unavailable && <Badge tone="warning">Sản phẩm hiện không mở bán</Badge>}

          {/* Desktop: nút trong luồng; điện thoại: thanh dính phía dưới */}
          <div className="hidden gap-3 md:flex">
            <Button variant="secondary" size="lg" disabled={outOfStock || unavailable} loading={add.isPending && !add.variables?.silent} onClick={() => doAdd(false)}>
              <ShoppingCart className="size-5" /> Thêm vào giỏ
            </Button>
            <Button size="lg" disabled={outOfStock || unavailable} onClick={() => doAdd(true)} className="min-w-40">Mua ngay</Button>
            {status === 'authenticated' && (
              <Button variant="outline" size="lg" aria-pressed={inWish} onClick={() => toggleWish.mutate()} loading={toggleWish.isPending}>
                <Heart className={cn('size-5', inWish && 'fill-primary text-primary')} /> {inWish ? 'Đã thích' : 'Yêu thích'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {(shop || p.shopName) && (
        <Card className="flex flex-wrap items-center gap-3 p-3 md:p-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"><Store className="size-6" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{shop?.name ?? p.shopName}</p>
            <p className="text-xs text-muted">{shop?.pickupProvince ?? ''}</p>
          </div>
          <Link href={`/shop/${encodeURIComponent(shop?.slug ?? p.shopId)}`} className="inline-flex min-h-11 items-center rounded-lg border border-primary px-4 text-sm font-medium text-primary md:min-h-10">Xem shop</Link>
        </Card>
      )}

      <Card className="p-3 md:p-6">
        <SectionTitle>Chi tiết sản phẩm</SectionTitle>
        {Object.keys(p.attributes ?? {}).length > 0 && (
          <dl className="mb-4 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm md:max-w-2xl">
            {Object.entries(p.attributes).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-words">{v}</dd></div>
            ))}
          </dl>
        )}
        <p className="max-w-prose whitespace-pre-line break-words text-sm leading-6">{p.description || 'Người bán chưa cập nhật mô tả.'}</p>
      </Card>

      <Card className="p-3 md:p-6">
        <SectionTitle>Đánh giá sản phẩm</SectionTitle>
        <RatingSummary summary={summary} fallbackAvg={p.ratingAvg} fallbackCount={p.ratingCount} />
        <ReviewList productId={p.id} />
      </Card>

      {recommendations.length > 0 && (
        <section>
          <SectionTitle>Có thể bạn cũng thích</SectionTitle>
          <ProductGrid items={recommendations} />
        </section>
      )}

      <div className="fixed inset-x-0 bottom-[calc(var(--bottom-nav-h)+var(--safe-bottom))] z-30 flex gap-2 border-t border-border bg-surface px-4 py-2 md:hidden">
        {status === 'authenticated' && (
          <Button variant="outline" size="icon" aria-label={inWish ? 'Bỏ yêu thích' : 'Yêu thích'} onClick={() => toggleWish.mutate()}>
            <Heart className={cn('size-5', inWish && 'fill-primary text-primary')} />
          </Button>
        )}
        <Button variant="secondary" className="flex-1" disabled={outOfStock || unavailable} onClick={() => doAdd(false)}>
          <ShoppingCart className="size-5" /> Thêm giỏ
        </Button>
        <Button className="flex-1" disabled={outOfStock || unavailable} onClick={() => doAdd(true)}>{outOfStock ? 'Hết hàng' : 'Mua ngay'}</Button>
      </div>
      <div className="h-16 md:hidden" aria-hidden />
    </div>
  );
}
