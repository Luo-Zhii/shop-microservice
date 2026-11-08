'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Trash2 } from 'lucide-react';
import { ProductCard } from '@/components/product-card';
import { Button, EmptyState, LinkButton, PageTitle, QueryView } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray } from '@/lib/format';
import { fetchProductsByIds } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import type { ProductLike } from '@/lib/types';

type WishItem = ProductLike & { productId?: string; product?: ProductLike };

export default function WishlistPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['wishlist', 'full'],
    queryFn: async () => {
      const list = asArray<WishItem>(await api.get('/user-profile/me/wishlist', { pageSize: 60 }));
      const map = await fetchProductsByIds(list.map((w) => w.productId ?? w.id));
      return list.map((w) => ({ ...w, product: map.get(w.productId ?? w.id) }));
    },
  });
  // recently-viewed trả mảng productId (chuỗi)
  const recent = useQuery({
    queryKey: ['recently-viewed'],
    queryFn: async () => {
      const ids = asArray<string | { productId: string }>(await api.get('/user-profile/me/recently-viewed', { limit: 12 })).map((x) => (typeof x === 'string' ? x : x.productId));
      const map = await fetchProductsByIds(ids);
      return ids.map((id) => map.get(id)).filter((p): p is ProductLike => !!p) as WishItem[];
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/user-profile/me/wishlist/${id}`),
    onSuccess: () => { toast.success('Đã bỏ khỏi yêu thích'); void qc.invalidateQueries({ queryKey: ['wishlist'] }); },
  });
  const norm = (w: WishItem) => ({ ...(w.product ?? {}), ...w, id: w.productId ?? w.product?.id ?? w.id, title: w.title ?? w.product?.title ?? 'Sản phẩm' });

  return (
    <div className="space-y-6">
      <section>
        <PageTitle>Sản phẩm yêu thích</PageTitle>
        <QueryView q={q} isEmpty={(d) => !d.length}
          empty={<EmptyState icon={<Heart className="size-6" />} title="Chưa có sản phẩm yêu thích" action={<LinkButton href="/">Khám phá</LinkButton>} />}>
          {(list) => (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
              {list.map(norm).map((p) => (
                <div key={p.id} className="relative min-w-0">
                  <ProductCard p={p} />
                  <Button variant="outline" size="icon" aria-label="Bỏ yêu thích" className="absolute left-1.5 top-1.5 bg-surface/90" onClick={() => remove.mutate(p.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </QueryView>
      </section>
      {!!recent.data?.length && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Đã xem gần đây</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
            {recent.data.slice(0, 12).map(norm).map((p) => <ProductCard key={p.id} p={p} />)}
          </div>
        </section>
      )}
    </div>
  );
}
