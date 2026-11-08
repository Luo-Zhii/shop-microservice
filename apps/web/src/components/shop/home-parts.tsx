'use client';

import { ChevronRight, Zap } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatVND, productHref, productImage } from '@/lib/format';
import type { Banner, Category, FlashSale, FlashSaleItem, ProductLike } from '@/lib/types';
import { Img, cn } from '../ui';

export function BannerCarousel({ banners }: { banners: Banner[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (banners.length < 2) return;
    const t = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % banners.length;
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    }, 5000);
    return () => clearInterval(t);
  }, [banners.length]);
  if (!banners.length) {
    return (
      <div className="flex aspect-[16/7] flex-col justify-center rounded-xl bg-gradient-to-br from-primary to-orange-400 px-6 text-white md:aspect-[16/5] md:px-12">
        <p className="text-sm opacity-90">ShopNow</p>
        <p className="text-xl font-bold md:text-4xl">Mua sắm thông minh mỗi ngày</p>
        <p className="mt-1 text-sm opacity-90 md:text-base">Hàng nghìn shop · Giao nhanh · Đổi trả dễ</p>
      </div>
    );
  }
  return (
    <div className="relative">
      <div ref={ref} onScroll={(e) => setIdx(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
        className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto rounded-xl">
        {banners.map((b) => {
          const inner = <Img src={b.imageUrl} alt={b.title} ratio="banner" rounded="rounded-none" />;
          return (
            <div key={b.id} className="w-full shrink-0 snap-start">
              {b.linkUrl ? <Link href={b.linkUrl} aria-label={b.title}>{inner}</Link> : inner}
            </div>
          );
        })}
      </div>
      {banners.length > 1 && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
          {banners.map((b, i) => <span key={b.id} className={cn('h-1.5 rounded-full bg-white/70 transition-all', i === idx ? 'w-5 bg-white' : 'w-1.5')} />)}
        </div>
      )}
    </div>
  );
}

export function CategoryStrip({ categories }: { categories: Category[] }) {
  if (!categories.length) return null;
  return (
    <section className="rounded-xl border border-border bg-surface p-3 md:p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">Danh mục</h2>
        <Link href="/categories" className="inline-flex min-h-11 items-center gap-0.5 text-sm text-primary md:min-h-0">Xem tất cả <ChevronRight className="size-4" /></Link>
      </div>
      <div className="scrollbar-none -mx-3 overflow-x-auto px-3 md:mx-0 md:px-0">
        <ul className="grid w-max auto-cols-[76px] grid-flow-col grid-rows-2 gap-2 md:w-full md:auto-cols-auto md:grid-flow-row md:grid-cols-8 md:grid-rows-none lg:grid-cols-10">
          {categories.map((c) => (
            <li key={c.id}>
              <Link href={`/search?categoryId=${c.id}`} className="flex flex-col items-center gap-1.5 rounded-lg p-1.5 text-center hover:bg-surface-2">
                <span className="grid size-12 place-items-center overflow-hidden rounded-full bg-primary-soft text-lg font-semibold text-primary">
                  {c.icon && /^https?:/.test(c.icon)
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={c.icon} alt="" width={48} height={48} className="size-12 object-cover" />
                    : (c.icon || c.name.charAt(0))}
                </span>
                <span className="line-clamp-2 text-xs leading-4">{c.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function useCountdown(target?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = target ? Math.max(0, new Date(target).getTime() - now) : 0;
  const s = Math.floor(ms / 1000);
  return { done: ms <= 0, h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

export function Countdown({ endsAt, className }: { endsAt: string; className?: string }) {
  const { h, m, s, done } = useCountdown(endsAt);
  const box = 'grid min-w-7 place-items-center rounded bg-fg px-1 py-0.5 text-xs font-bold tabular-nums text-bg';
  if (done) return <span className={cn('text-xs text-muted', className)}>Đã kết thúc</span>;
  return (
    <span className={cn('inline-flex items-center gap-1', className)} aria-label={`Còn ${h} giờ ${m} phút ${s} giây`}>
      <span className={box}>{String(h).padStart(2, '0')}</span>:<span className={box}>{String(m).padStart(2, '0')}</span>:<span className={box}>{String(s).padStart(2, '0')}</span>
    </span>
  );
}

export function flashItemToProduct(it: FlashSaleItem) {
  const p: Partial<ProductLike> = it.product ?? {};
  return {
    ...p,
    ...it,
    id: it.productId ?? p.id ?? it.id,
    title: it.title ?? p.title ?? 'Sản phẩm',
    slug: it.slug ?? p.slug,
    image: productImage(it) ?? productImage(p),
    minPrice: it.originalPrice ?? it.minPrice ?? p.minPrice ?? it.price,
    salePrice: it.salePrice,
  };
}

export function FlashSaleSection({ sale }: { sale: FlashSale }) {
  const items = sale.items.map(flashItemToProduct);
  if (!items.length) return null;
  return (
    <section className="rounded-xl border border-border bg-surface p-3 md:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="inline-flex items-center gap-1 font-bold uppercase text-primary"><Zap className="size-5 fill-primary" /> Flash sale</h2>
        <Countdown endsAt={sale.endsAt} />
      </div>
      <div className="scrollbar-none -mx-3 overflow-x-auto px-3 md:mx-0 md:px-0">
        <ul className="flex w-max gap-2 md:grid md:w-full md:grid-cols-6 md:gap-3">
          {items.map((p, i) => {
            const raw = sale.items[i];
            const pct = raw.quota ? Math.min(100, Math.round(((raw.sold ?? 0) / raw.quota) * 100)) : 0;
            return (
              <li key={`${p.id}-${raw.skuId ?? i}`} className="w-32 shrink-0 md:w-auto">
                <Link href={productHref(p)} className="block">
                  <Img src={p.image} alt={p.title} />
                  <p className="mt-1.5 text-center font-semibold text-primary">{formatVND(p.salePrice ?? p.minPrice)}</p>
                  {raw.quota ? (
                    <div className="relative mt-1 h-4 overflow-hidden rounded-full bg-primary-soft">
                      <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${pct}%` }} />
                      <span className="relative block text-center text-[10px] font-semibold leading-4 text-fg">
                        {pct >= 100 ? 'Đã hết' : `Đã bán ${raw.sold ?? 0}`}
                      </span>
                    </div>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
