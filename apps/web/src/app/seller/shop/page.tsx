'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { ShopForm } from '@/components/seller/shop-form';
import { Badge, Card, LinkButton, PageTitle, QueryView } from '@/components/ui';
import { api } from '@/lib/api';
import { SHOP_STATUS, statusOf } from '@/lib/format';
import type { Shop } from '@/lib/types';

export default function ShopSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-shop-settings'], queryFn: () => api.get<Shop>('/seller/shops/me') });
  return (
    <div>
      <PageTitle actions={q.data && <LinkButton href={`/shop/${q.data.slug}`} variant="outline" size="sm"><ExternalLink className="size-4" /> Xem shop</LinkButton>}>Hồ sơ shop</PageTitle>
      <QueryView q={q}>
        {(s) => (
          <Card className="p-4 md:max-w-3xl md:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">Trạng thái:</span>
              <Badge tone={statusOf(SHOP_STATUS, s.status).tone}>{statusOf(SHOP_STATUS, s.status).label}</Badge>
              <span className="text-xs text-muted">Đổi tên hoặc tỉnh lấy hàng sẽ cập nhật cho toàn bộ sản phẩm.</span>
            </div>
            <ShopForm key={s.id} mode="edit" initial={s} onDone={() => {
              void qc.invalidateQueries({ queryKey: ['my-shop'] });
              void qc.invalidateQueries({ queryKey: ['my-shop-settings'] });
            }} />
          </Card>
        )}
      </QueryView>
    </div>
  );
}
