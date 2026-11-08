'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeOff, Search } from 'lucide-react';
import { useState } from 'react';
import { RatingSummary, ReviewList } from '@/components/shop/reviews';
import { Badge, Button, Card, EmptyState, Input, PageTitle, ReasonSheet } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { ProductSnapshot, Review } from '@/lib/types';

export default function AdminReviewsPage() {
  const qc = useQueryClient();
  // Chưa có API admin liệt kê toàn bộ review → tra theo sản phẩm (ID/slug) rồi ẩn review vi phạm
  const [lookup, setLookup] = useState('');
  const [product, setProduct] = useState<ProductSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [hiding, setHiding] = useState<Review | null>(null);
  const find = async () => {
    if (!lookup.trim()) return;
    setBusy(true);
    try {
      const r = await api.get<ProductSnapshot | { product: ProductSnapshot }>(`/catalog/products/${encodeURIComponent(lookup.trim())}`);
      setProduct('product' in r ? r.product : r);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const hide = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.post(`/review/admin/reviews/${v.id}/hide`, { reason: v.reason }),
    onSuccess: () => { toast.success('Đã ẩn đánh giá'); setHiding(null); void qc.invalidateQueries({ queryKey: ['reviews'] }); },
  });
  return (
    <div>
      <PageTitle>Kiểm duyệt đánh giá</PageTitle>
      <form className="mb-4 flex gap-2 md:max-w-lg" onSubmit={(e) => { e.preventDefault(); void find(); }}>
        <Input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="ID hoặc slug sản phẩm" aria-label="ID hoặc slug sản phẩm" />
        <Button type="submit" className="shrink-0" loading={busy}><Search className="size-4" /> Tra cứu</Button>
      </form>
      {!product ? <EmptyState title="Nhập sản phẩm để xem đánh giá" description="Có thể lấy slug từ đường dẫn /product/<slug>." /> : (
        <Card className="p-3 md:p-4">
          <h2 className="mb-3 break-words font-semibold">{product.title}</h2>
          <RatingSummary summary={null} fallbackAvg={product.ratingAvg} fallbackCount={product.ratingCount} />
          <ReviewList key={product.id} productId={product.id} renderActions={(r) => (r.hidden
            ? <Badge>Đã ẩn</Badge>
            : <Button size="sm" variant="outline" className="text-danger" onClick={() => setHiding(r)}><EyeOff className="size-4" /> Ẩn đánh giá</Button>)} />
        </Card>
      )}
      <ReasonSheet open={!!hiding} onClose={() => setHiding(null)} title="Ẩn đánh giá" confirmText="Ẩn" danger
        presets={['Ngôn từ thô tục', 'Spam / quảng cáo', 'Thông tin cá nhân', 'Không liên quan sản phẩm']}
        loading={hide.isPending} onConfirm={(reason) => hiding && hide.mutate({ id: hiding.id, reason })} />
    </div>
  );
}
