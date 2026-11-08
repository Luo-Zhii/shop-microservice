import { serviceClient } from '@shopnow/platform';

export interface UserInfo {
  id: string;
  email: string;
  fullName?: string | null;
}
export interface UserPort {
  getUser(userId: string): Promise<UserInfo | null>;
}
export interface ShopOwnerPort {
  getOwnerId(shopId: string): Promise<string | null>;
}

export function identityClient(baseUrl: string, internalToken: string): UserPort {
  const http = serviceClient({ name: 'identity', baseUrl, internalToken, timeoutMs: 1_500 });
  return {
    async getUser(userId) {
      const r = await http.get<UserInfo & { user?: UserInfo }>(`/internal/users/${encodeURIComponent(userId)}`);
      const u = r?.user ?? r;
      return u?.email ? { id: u.id ?? userId, email: u.email, fullName: u.fullName ?? null } : null;
    },
  };
}

export function sellerClient(baseUrl: string, internalToken: string): ShopOwnerPort {
  const http = serviceClient({ name: 'seller', baseUrl, internalToken, timeoutMs: 1_500 });
  return {
    async getOwnerId(shopId) {
      const r = await http.get<{ ownerId?: string; shop?: { ownerId?: string } }>(`/internal/shops/${encodeURIComponent(shopId)}`);
      return r?.ownerId ?? r?.shop?.ownerId ?? null;
    },
  };
}

/** Cache chủ shop 5 phút (sự kiện seller.shop.v1 cũng cập nhật cache). */
export function cachedShopOwners(inner: ShopOwnerPort, ttlMs = 5 * 60_000) {
  const cache = new Map<string, { ownerId: string; exp: number }>();
  return {
    set(shopId: string, ownerId: string) {
      cache.set(shopId, { ownerId, exp: Date.now() + ttlMs });
    },
    async getOwnerId(shopId: string) {
      const hit = cache.get(shopId);
      if (hit && hit.exp > Date.now()) return hit.ownerId;
      const ownerId = await inner.getOwnerId(shopId);
      if (ownerId) cache.set(shopId, { ownerId, exp: Date.now() + ttlMs });
      return ownerId;
    },
  };
}
export type ShopOwners = ReturnType<typeof cachedShopOwners>;
