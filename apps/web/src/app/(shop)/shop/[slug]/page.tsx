'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Store, UserPlus, UserCheck } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ProductGrid, ProductGridSkeleton } from '@/components/product-card';
import { Button, Card, EmptyState, ErrorState, Pagination, QueryView, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { asArray, formatCompact, formatDate, pick, totalPages } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { ProductLike, Shop } from '@/lib/types';

export default function ShopPage() {
  const { slug } = useParams<{ slug: string }>();
  const { status } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('best_selling');
  const pageSize = 24;
  const shop = useQuery({ queryKey: ['shop', slug], queryFn: () => api.get<Shop>(`/seller/shops/${encodeURIComponent(slug)}`) });
  const products = useQuery({
    queryKey: ['shop-products', shop.data?.id, page, sort],
    enabled: !!shop.data?.id,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await api.get<unknown>('/search/search', { shopId: shop.data!.id, sort, page, pageSize });
      return { items: asArray<ProductLike>(r), total: pick<number>(r, 'total') ?? 0 };
    },
  });
  const following = !!(shop.data?.isFollowing ?? shop.data?.following);
  const follow = useMutation({
    mutationFn: () => (following ? api.del(`/seller/shops/${shop.data!.id}/follow`) : api.post(`/seller/shops/${shop.data!.id}/follow`)),
    onSuccess: () => { toast.success(following ? 'Đã bỏ theo dõi' : 'Đã theo dõi shop'); void qc.invalidateQueries({ queryKey: ['shop', slug] }); },
  });

  if (shop.isPending) return <div className="space-y-4"><Skeleton className="h-28" /><ProductGridSkeleton /></div>;
  if (shop.isError) return <ErrorState error={shop.error} onRetry={() => shop.refetch()} />;
  const s = shop.data;
  const logo = s.logoUrl ?? s.logo;
  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-4 bg-gradient-to-br from-primary-soft to-surface p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-surface bg-surface text-primary">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {logo ? <img src={logo} alt={s.name} width={64} height={64} className="size-16 object-cover" /> : <Store className="size-7" />}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold md:text-xl">{s.name}</h1>
            <p className="flex flex-wrap gap-x-3 text-xs text-muted">
              {s.pickupProvince && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{s.pickupProvince}</span>}
              <span>{formatCompact(s.followerCount ?? s.followers)} người theo dõi</span>
              <span>Tham gia {formatDate(s.createdAt, false)}</span>
            </p>
          </div>
        </div>
        <Button variant={following ? 'outline' : 'primary'} loading={follow.isPending} className="sm:w-auto"
          onClick={() => (status === 'authenticated' ? follow.mutate() : router.push(`/login?next=/shop/${slug}`))}>
          {following ? <><UserCheck className="size-4" /> Đang theo dõi</> : <><UserPlus className="size-4" /> Theo dõi</>}
        </Button>
      </Card>
      {s.description && <p className="max-w-prose whitespace-pre-line break-words text-sm text-muted">{s.description}</p>}
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Sản phẩm của shop</h2>
        <Select aria-label="Sắp xếp" className="w-auto" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
          <option value="best_selling">Bán chạy</option><option value="newest">Mới nhất</option><option value="price_asc">Giá thấp</option><option value="price_desc">Giá cao</option>
        </Select>
      </div>
      <QueryView q={products} loading={<ProductGridSkeleton />} isEmpty={(d) => !d.items.length} empty={<EmptyState title="Shop chưa có sản phẩm" />}>
        {(d) => <><ProductGrid items={d.items} /><Pagination className="mt-6" page={page} pages={totalPages(d.total, pageSize)} onChange={setPage} /></>}
      </QueryView>
    </div>
  );
}
