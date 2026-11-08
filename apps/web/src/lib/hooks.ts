'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setGuestCartId, getAccessToken } from './api';
import { useAuth } from './auth';
import { asArray, pick } from './format';
import { toast } from './toast';
import type { AppNotification, Cart, CartItem, CartShopGroup, Category, ProductLike } from './types';

// ---------------- Giỏ hàng ----------------
function normItem(raw: Record<string, unknown>, oldPrices: Map<string, number>): CartItem {
  const price = pick<number>(raw, 'price', 'currentPrice', 'unitPrice') ?? 0;
  // cart service báo đổi giá qua warnings[PRICE_CHANGED] (oldPrice) thay vì trên từng dòng
  const added = pick<number>(raw, 'addedPrice', 'priceAtAdd', 'priceWhenAdded') ?? oldPrices.get(String(raw.skuId));
  return {
    ...(raw as unknown as CartItem),
    title: pick<string>(raw, 'title', 'productTitle', 'name') ?? 'Sản phẩm',
    image: pick<string>(raw, 'image', 'imageUrl') ?? (raw.images as string[] | undefined)?.[0] ?? null,
    qty: Number(raw.qty ?? raw.quantity ?? 1),
    price,
    addedPrice: added,
    priceChanged: Boolean(raw.priceChanged) || (added != null && added !== price),
    available: pick<number>(raw, 'available', 'stock', 'availableQty'),
    status: raw.purchasable === false ? 'INACTIVE' : (raw.status as string | undefined),
  };
}

export function normalizeCart(r: unknown): Cart {
  const warnings = asArray<{ code: string; message: string; skuId?: string; oldPrice?: number }>(pick(r, 'warnings'));
  const oldPrices = new Map(warnings.filter((w) => w.code === 'PRICE_CHANGED' && w.skuId && w.oldPrice != null).map((w) => [w.skuId!, w.oldPrice!]));
  const normItem_ = (raw: Record<string, unknown>) => normItem(raw, oldPrices);
  const groups = asArray<Record<string, unknown>>(r, 'shops', 'groups');
  let shops: CartShopGroup[];
  if (groups.length && Array.isArray(groups[0].items)) {
    shops = groups.map((g) => ({
      shopId: String(g.shopId ?? g.id ?? ''),
      shopName: pick<string>(g, 'shopName', 'name'),
      pickupProvince: pick<string>(g, 'pickupProvince'),
      items: (g.items as Record<string, unknown>[]).map(normItem_),
    }));
  } else {
    const map = new Map<string, CartShopGroup>();
    for (const raw of asArray<Record<string, unknown>>(r, 'items')) {
      const it = normItem_(raw);
      const id = it.shopId ?? 'unknown';
      if (!map.has(id)) map.set(id, { shopId: id, shopName: it.shopName, items: [] });
      map.get(id)!.items.push(it);
    }
    shops = [...map.values()];
  }
  return {
    cartId: pick<string>(r, 'cartId', 'id'),
    shops: shops.filter((s) => s.items.length),
    // Cảnh báo chung (dịch vụ phụ thuộc lỗi…) — cảnh báo theo dòng đã hiển thị tại dòng
    notices: warnings.filter((w) => !w.skuId && w.code !== 'PRICE_CHANGED').map((w) => w.message),
  };
}

export function useCart() {
  const { status, user } = useAuth();
  return useQuery({
    queryKey: ['cart', user?.id ?? 'guest'],
    enabled: status !== 'loading',
    queryFn: async () => {
      const r = await api.get<unknown>('/cart/cart', undefined, { cart: true });
      const cart = normalizeCart(r);
      // Server có thể cấp cartId mới cho khách
      if (!getAccessToken() && cart.cartId) setGuestCartId(cart.cartId);
      return cart;
    },
  });
}

export function cartCount(c: Cart | undefined) {
  return c?.shops.reduce((n, s) => n + s.items.length, 0) ?? 0;
}

export function useAddToCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { skuId: string; qty: number; silent?: boolean }) =>
      api.post('/cart/cart/items', { skuId: v.skuId, qty: v.qty }, { cart: true }),
    onSuccess: (_d, v) => {
      if (!v.silent) toast.success('Đã thêm vào giỏ hàng');
      void qc.invalidateQueries({ queryKey: ['cart'] });
    },
  });
}

// ---------------- Thông báo ----------------
export function useNotifications(enabled = true) {
  const { status, user } = useAuth();
  return useQuery({
    queryKey: ['notifications', user?.id],
    enabled: enabled && status === 'authenticated',
    queryFn: async () => {
      const r = await api.get<unknown>('/notification/notifications', { page: 1, pageSize: 30 });
      const items = asArray<AppNotification>(r).map((n) => ({ ...n, read: n.read ?? !!n.readAt }));
      const unread = pick<number>(r, 'unread', 'unreadCount') ?? items.filter((n) => !n.read).length;
      return { items, unread };
    },
  });
}

// ---------------- Danh mục ----------------
export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    staleTime: 5 * 60_000,
    queryFn: async () => asArray<Category>(await api.get('/catalog/categories')),
  });
}

export function flattenCategories(tree: Category[], depth = 0, out: (Category & { depth: number })[] = []) {
  for (const c of tree) {
    out.push({ ...c, depth });
    if (c.children?.length) flattenCategories(c.children, depth + 1, out);
  }
  return out;
}

// ---------------- Sản phẩm theo danh sách id ----------------
/** GET /catalog/products?ids=a,b — dùng để làm giàu wishlist / đã xem / flash sale (các API đó chỉ trả productId). */
export async function fetchProductsByIds(ids: string[]): Promise<Map<string, ProductLike>> {
  const uniq = [...new Set(ids.filter(Boolean))].slice(0, 60);
  const map = new Map<string, ProductLike>();
  if (!uniq.length) return map;
  try {
    const r = await api.get<unknown>('/catalog/products', { ids: uniq.join(','), pageSize: uniq.length });
    for (const p of asArray<ProductLike>(r)) map.set(p.id, p);
  } catch {
    /* thiếu thông tin vẫn hiển thị phần còn lại */
  }
  return map;
}
