'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Reply } from 'lucide-react';
import { useState } from 'react';
import { ReviewList, replyText } from '@/components/shop/reviews';
import { Button, Card, EmptyState, Field, PageTitle, QueryView, Select, Sheet, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { ProductSnapshot, Review } from '@/lib/types';

export default function SellerReviewsPage() {
  const qc = useQueryClient();
  // review service chưa có API liệt kê đánh giá theo shop → chọn sản phẩm rồi xem đánh giá của sản phẩm đó
  const products = useQuery({
    queryKey: ['seller-products', 'approved-for-reviews'],
    queryFn: async () => asArray<ProductSnapshot>(await api.get('/catalog/seller/products', { status: 'APPROVED', pageSize: 100 })),
  });
  const [productId, setProductId] = useState('');
  const [replying, setReplying] = useState<Review | null>(null);
  const [content, setContent] = useState('');
  const reply = useMutation({
    mutationFn: () => api.post(`/review/seller/reviews/${replying!.id}/reply`, { content: content.trim() }),
    onSuccess: () => { toast.success('Đã gửi phản hồi'); setReplying(null); setContent(''); void qc.invalidateQueries({ queryKey: ['reviews'] }); },
  });
  const pid = productId || products.data?.[0]?.id || '';

  return (
    <div>
      <PageTitle>Đánh giá</PageTitle>
      <QueryView q={products} isEmpty={(d) => !d.length} empty={<EmptyState icon={<MessageSquare className="size-6" />} title="Chưa có sản phẩm đang bán" />}>
        {(list) => (
          <Card className="p-3 md:p-4">
            <Field label="Sản phẩm" className="mb-3 md:max-w-lg">
              <Select value={pid} onChange={(e) => setProductId(e.target.value)}>
                {list.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.ratingCount ?? 0} đánh giá)</option>)}
              </Select>
            </Field>
            {pid && (
              <ReviewList key={pid} productId={pid} renderActions={(r) => (
                <Button size="sm" variant="outline" onClick={() => { setReplying(r); setContent(replyText(r) ?? ''); }}>
                  <Reply className="size-4" /> {replyText(r) ? 'Sửa phản hồi' : 'Trả lời'}
                </Button>
              )} />
            )}
          </Card>
        )}
      </QueryView>
      <Sheet open={!!replying} onClose={() => setReplying(null)} title="Phản hồi đánh giá" footer={(
        <><Button variant="outline" onClick={() => setReplying(null)}>Huỷ</Button><Button disabled={content.trim().length < 2} loading={reply.isPending} onClick={() => reply.mutate()}>Gửi</Button></>
      )}>
        {replying && (
          <div className="space-y-3">
            <p className="rounded-lg bg-surface-2 p-3 text-sm">“{replying.content}”</p>
            <Field label="Nội dung phản hồi"><Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} autoFocus /></Field>
          </div>
        )}
      </Sheet>
    </div>
  );
}
