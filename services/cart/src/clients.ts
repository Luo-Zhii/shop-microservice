import { serviceClient } from '@shopnow/platform';

/** Thông tin SKU từ catalog POST /internal/skus. */
export interface SkuInfo {
  skuId: string;
  productId: string;
  shopId: string;
  shopName?: string | null;
  title: string;
  variantLabel: string;
  image: string | null;
  price: number;
  status: string;
  productStatus: string;
  purchasable: boolean;
}

export interface CatalogPort {
  getSkus(skuIds: string[]): Promise<SkuInfo[]>;
}

/** Tồn khả dụng theo SKU; ném lỗi khi inventory không trả lời được. */
export interface InventoryPort {
  getStock(skuIds: string[]): Promise<Map<string, number>>;
}

export function catalogClient(baseUrl: string, internalToken: string): CatalogPort {
  const http = serviceClient({ name: 'catalog', baseUrl, internalToken, timeoutMs: 1_500 });
  return {
    async getSkus(skuIds) {
      if (skuIds.length === 0) return [];
      const r = await http.post<{ items: SkuInfo[] }>('/internal/skus', { skuIds });
      return r.items ?? [];
    },
  };
}

export function inventoryClient(baseUrl: string, internalToken: string): InventoryPort {
  // inventory (Go) có thể chết → timeout ngắn, breaker mở nhanh để không làm chậm GET /cart.
  const http = serviceClient({ name: 'inventory', baseUrl, internalToken, timeoutMs: 800, retries: 0, breaker: { failureThreshold: 3, openMs: 15_000 } });
  return {
    async getStock(skuIds) {
      const out = new Map<string, number>();
      if (skuIds.length === 0) return out;
      const r = await http.get<unknown>(`/stock?skuIds=${skuIds.map(encodeURIComponent).join(',')}`);
      const rows = (Array.isArray(r) ? r : ((r as { items?: unknown[] })?.items ?? [])) as { skuId: string; available: number }[];
      for (const s of rows) out.set(s.skuId, Number(s.available));
      return out;
    },
  };
}
