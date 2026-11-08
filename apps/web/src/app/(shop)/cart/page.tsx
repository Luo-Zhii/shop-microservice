'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ShoppingCart, Store, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Checkbox, EmptyState, ErrorState, Img, LinkButton, LoadingBlock, PageTitle, QtyStepper } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatVND, productHref } from '@/lib/format';
import { useCart } from '@/lib/hooks';
import { itemProblem, readSelection, writeSelection } from '@/lib/cart';

export default function CartPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { status } = useAuth();
  const q = useCart();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inited, setInited] = useState(false);

  const all = useMemo(() => q.data?.shops.flatMap((s) => s.items) ?? [], [q.data]);
  const buyable = useMemo(() => all.filter((i) => !itemProblem(i) || itemProblem(i) === 'short'), [all]);

  useEffect(() => {
    if (!q.data || inited) return;
    const prev = readSelection();
    setSelected(new Set((prev ?? buyable.map((b) => b.skuId)).filter((id) => buyable.some((b) => b.skuId === id))));
    setInited(true);
  }, [q.data, inited, buyable]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cart'] });
  const setQty = useMutation({
    mutationFn: (v: { skuId: string; qty: number }) => api.put(`/cart/cart/items/${v.skuId}`, { qty: v.qty }, { cart: true }),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (skuIds: string[]) => Promise.all(skuIds.map((id) => api.del(`/cart/cart/items/${id}`, { cart: true }))),
    onSuccess: (_d, ids) => setSelected((s) => { const n = new Set(s); ids.forEach((i) => n.delete(i)); return n; }),
    onSettled: invalidate,
  });

  const toggle = (ids: string[], on: boolean) => setSelected((s) => {
    const n = new Set(s);
    ids.forEach((i) => (on ? n.add(i) : n.delete(i)));
    return n;
  });

  const chosen = all.filter((i) => selected.has(i.skuId));
  const total = chosen.reduce((n, i) => n + i.price * i.qty, 0);
  const hasPriceChange = all.some((i) => i.priceChanged);

  const checkout = () => {
    writeSelection([...selected]);
    if (status !== 'authenticated') router.push('/login?next=/checkout');
    else router.push('/checkout');
  };

  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!all.length) {
    return (
      <EmptyState icon={<ShoppingCart className="size-6" />} title="Giỏ hàng trống" description="Hãy chọn thêm sản phẩm để mua sắm nhé."
        action={<LinkButton href="/">Mua sắm ngay</LinkButton>} />
    );
  }

  return (
    <div>
      <PageTitle>Giỏ hàng ({all.length})</PageTitle>
      {q.data.notices?.map((n) => (
        <div key={n} className="mb-3 flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {n}</div>
      ))}
      {hasPriceChange && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Một số sản phẩm đã thay đổi giá so với lúc bạn thêm vào giỏ.
        </div>
      )}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-6">
        <div className="space-y-3">
          {q.data.shops.map((shop) => {
            const ids = shop.items.filter((i) => buyable.includes(i)).map((i) => i.skuId);
            const allOn = ids.length > 0 && ids.every((i) => selected.has(i));
            return (
              <Card key={shop.shopId} as="section" className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-border px-3 py-1">
                  <Checkbox checked={allOn} disabled={!ids.length} onChange={(v) => toggle(ids, v)} />
                  <Store className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{shop.shopName ?? 'Shop'}</span>
                </div>
                <ul>
                  {shop.items.map((it) => {
                    const prob = itemProblem(it);
                    const disabled = prob === 'out' || prob === 'inactive';
                    return (
                      <li key={it.skuId} className="flex gap-2 border-b border-border px-3 py-3 last:border-0 sm:gap-3">
                        <div className="pt-6"><Checkbox checked={selected.has(it.skuId)} disabled={disabled} onChange={(v) => toggle([it.skuId], v)} /></div>
                        <Link href={productHref({ id: it.productId ?? '', slug: it.slug, title: it.title })} className="w-20 shrink-0 sm:w-24">
                          <Img src={it.image} alt={it.title} className={disabled ? 'opacity-50' : ''} />
                        </Link>
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="line-clamp-2 text-sm">{it.title}</p>
                          {it.variantLabel && <p className="truncate text-xs text-muted">Phân loại: {it.variantLabel}</p>}
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-semibold text-primary">{formatVND(it.price)}</span>
                            {it.priceChanged && it.addedPrice != null && (
                              <span className="text-xs text-warning">Giá cũ <span className="line-through">{formatVND(it.addedPrice)}</span></span>
                            )}
                          </div>
                          {prob && (
                            <p className="flex items-center gap-1 text-xs text-danger">
                              <AlertTriangle className="size-3.5" />
                              {prob === 'out' ? 'Hết hàng' : prob === 'inactive' ? 'Sản phẩm ngừng bán' : `Chỉ còn ${it.available} sản phẩm`}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            <QtyStepper value={it.qty} disabled={disabled || setQty.isPending} max={it.available && it.available > 0 ? it.available : 999}
                              onChange={(qty) => setQty.mutate({ skuId: it.skuId, qty })} />
                            <Button variant="ghost" size="icon" aria-label="Xoá" onClick={() => remove.mutate([it.skuId])}><Trash2 className="size-4 text-muted" /></Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}
        </div>

        <aside className="sticky bottom-[calc(var(--bottom-nav-h)+var(--safe-bottom))] z-20 -mx-4 mt-3 border-t border-border bg-surface px-4 py-3 md:bottom-0 lg:top-24 lg:mx-0 lg:mt-0 lg:self-start lg:rounded-xl lg:border">
          <div className="flex items-center gap-2 lg:flex-col lg:items-stretch lg:gap-3">
            <Checkbox
              checked={buyable.length > 0 && buyable.every((i) => selected.has(i.skuId))}
              onChange={(v) => toggle(buyable.map((i) => i.skuId), v)}
              label={<span className="whitespace-nowrap">Tất cả</span>}
            />
            {selected.size > 0 && (
              <button type="button" className="hidden min-h-9 text-left text-sm text-danger lg:block" onClick={() => remove.mutate([...selected])}>Xoá đã chọn ({selected.size})</button>
            )}
            <div className="min-w-0 flex-1 text-right lg:text-left">
              <p className="text-xs text-muted">Tổng thanh toán</p>
              <p className="truncate text-lg font-semibold text-primary">{formatVND(total)}</p>
            </div>
            <Button className="shrink-0 lg:w-full" size="lg" disabled={!selected.size} onClick={checkout}>Mua hàng ({selected.size})</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
