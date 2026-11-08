'use client';

import { Store } from 'lucide-react';
import Link from 'next/link';
import { ORDER_STATUS, formatVND, statusOf } from '@/lib/format';
import type { OrderSnapshot } from '@/lib/types';
import { Badge, Card, Img } from '../ui';

export function OrderItems({ order, max }: { order: OrderSnapshot; max?: number }) {
  const items = max ? order.items.slice(0, max) : order.items;
  return (
    <ul className="divide-y divide-border">
      {items.map((it) => (
        <li key={it.skuId} className="flex gap-3 py-2.5">
          <Img src={it.image} alt={it.title} className="w-16 shrink-0" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="line-clamp-2">{it.title}</p>
            {it.variantLabel && <p className="truncate text-xs text-muted">{it.variantLabel}</p>}
            <div className="mt-0.5 flex justify-between gap-2"><span className="text-muted">x{it.qty}</span><span>{formatVND(it.unitPrice)}</span></div>
          </div>
        </li>
      ))}
      {max && order.items.length > max && <li className="py-2 text-center text-xs text-muted">+ {order.items.length - max} sản phẩm khác</li>}
    </ul>
  );
}

export function OrderCard({ order, href }: { order: OrderSnapshot; href: string }) {
  const st = statusOf(ORDER_STATUS, order.status);
  return (
    <Card as="article" className="overflow-hidden">
      <Link href={href} className="block px-3 md:px-4">
        <div className="flex items-center gap-2 border-b border-border py-2.5">
          <Store className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{order.shopName ?? `Đơn #${order.id.slice(-8).toUpperCase()}`}</span>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <OrderItems order={order} max={2} />
        <div className="flex items-center justify-end gap-2 border-t border-border py-2.5 text-sm">
          <span className="text-muted">Thành tiền:</span><span className="font-semibold text-primary">{formatVND(order.total)}</span>
        </div>
      </Link>
    </Card>
  );
}
