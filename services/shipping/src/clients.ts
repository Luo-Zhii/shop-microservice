import { serviceClient } from '@shopnow/platform';

export interface ShopPort {
  /** Tỉnh lấy hàng của shop (null nếu shop chưa khai báo). Ném lỗi khi seller không trả lời. */
  getPickupProvince(shopId: string): Promise<string | null>;
}
export interface SkuWeightPort {
  getWeights(skuIds: string[]): Promise<Map<string, number>>;
}

export function sellerClient(baseUrl: string, internalToken: string): ShopPort {
  const http = serviceClient({ name: 'seller', baseUrl, internalToken, timeoutMs: 1_500 });
  return {
    async getPickupProvince(shopId) {
      const r = await http.get<{ pickupProvince?: string | null; shop?: { pickupProvince?: string | null } }>(`/internal/shops/${encodeURIComponent(shopId)}`);
      return r?.pickupProvince ?? r?.shop?.pickupProvince ?? null;
    },
  };
}

export function catalogWeights(baseUrl: string, internalToken: string): SkuWeightPort {
  const http = serviceClient({ name: 'catalog', baseUrl, internalToken, timeoutMs: 1_500 });
  return {
    async getWeights(skuIds) {
      const r = await http.post<{ items: { skuId: string; weightGrams: number }[] }>('/internal/skus', { skuIds });
      return new Map((r.items ?? []).map((s) => [s.skuId, Number(s.weightGrams)]));
    },
  };
}
