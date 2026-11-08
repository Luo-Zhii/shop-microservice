'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ProductForm } from '@/components/seller/product-form';
import { Badge, PageTitle, QueryView } from '@/components/ui';
import { api } from '@/lib/api';
import { PRODUCT_STATUS, statusOf } from '@/lib/format';
import type { ProductSnapshot } from '@/lib/types';

export default function EditProductPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['seller-product', id],
    gcTime: 0,
    queryFn: async () => {
      const r = await api.get<ProductSnapshot | { product: ProductSnapshot }>(`/catalog/products/${id}`);
      return 'product' in r ? r.product : r;
    },
  });
  return (
    <div>
      <PageTitle back="/seller/products" actions={q.data && <Badge tone={statusOf(PRODUCT_STATUS, q.data.status).tone}>{statusOf(PRODUCT_STATUS, q.data.status).label}</Badge>}>
        Sửa sản phẩm
      </PageTitle>
      {q.data?.status === 'REJECTED' && q.data.rejectReason && (
        <p className="mb-3 rounded-lg bg-danger-soft p-3 text-sm text-danger">Bị từ chối: {q.data.rejectReason}. Sửa rồi gửi duyệt lại.</p>
      )}
      <QueryView q={q}>{(p) => <ProductForm key={p.id} product={p} />}</QueryView>
    </div>
  );
}
