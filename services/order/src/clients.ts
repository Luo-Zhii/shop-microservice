import { serviceClient } from '@shopnow/platform';
import type { Address } from '@shopnow/contracts';

/** Kết quả catalog POST /internal/skus (mỗi phần tử). */
export interface SkuInfo {
  skuId: string;
  productId: string;
  shopId: string;
  shopName?: string;
  title: string;
  variantLabel: string;
  image?: string | null;
  price: number;
  weightGrams: number;
  status: string;
  productStatus: string;
  purchasable: boolean;
}

export interface ShippingQuote {
  carrier: string;
  fee: number;
  etaDays: number;
}

export interface PromotionQuoteRequest {
  checkoutId: string;
  buyerId: string;
  shops: { shopId: string; items: { skuId: string; productId: string; price: number; qty: number }[]; shippingFee: number }[];
  voucherCodes: string[];
  commit: boolean;
}

export interface PromotionQuote {
  shops: {
    shopId: string;
    /** Giảm giá tiền hàng của shop (voucher shop + phần voucher sàn được chia). */
    discount: number;
    shippingDiscount: number;
    appliedVouchers: unknown[];
    items: { skuId: string; unitPrice: number }[];
  }[];
  platformDiscount: number;
  totalDiscount: number;
}

/** Mọi lời gọi đồng bộ sang service khác — inject để test mock được. */
export interface OrderDeps {
  catalog: { skus(skuIds: string[]): Promise<SkuInfo[]> };
  profile: { address(addressId: string, userId: string): Promise<Address> };
  seller: { shop(shopId: string): Promise<{ id: string; status?: string; pickupProvince?: string | null }> };
  shipping: { quote(req: { fromProvince: string; toProvince: string; weightGrams: number }): Promise<ShippingQuote> };
  promotion: { quote(req: PromotionQuoteRequest): Promise<PromotionQuote> };
}

export function createDeps(urls: {
  CATALOG_URL: string;
  USER_PROFILE_URL: string;
  SELLER_URL: string;
  SHIPPING_URL: string;
  PROMOTION_URL: string;
  INTERNAL_TOKEN: string;
}): OrderDeps {
  const t = urls.INTERNAL_TOKEN;
  const catalog = serviceClient({ name: 'catalog', baseUrl: urls.CATALOG_URL, internalToken: t });
  const profile = serviceClient({ name: 'user-profile', baseUrl: urls.USER_PROFILE_URL, internalToken: t });
  const seller = serviceClient({ name: 'seller', baseUrl: urls.SELLER_URL, internalToken: t });
  const shipping = serviceClient({ name: 'shipping', baseUrl: urls.SHIPPING_URL, internalToken: t });
  const promotion = serviceClient({ name: 'promotion', baseUrl: urls.PROMOTION_URL, internalToken: t, timeoutMs: 3_000 });
  return {
    catalog: {
      async skus(skuIds) {
        const r = await catalog.post<{ items: SkuInfo[] } | SkuInfo[]>('/internal/skus', { skuIds });
        return Array.isArray(r) ? r : r.items;
      },
    },
    profile: {
      async address(addressId, userId) {
        const r = await profile.get<Address & { address?: Address }>(
          `/internal/addresses/${encodeURIComponent(addressId)}?userId=${encodeURIComponent(userId)}`,
        );
        return r.address ?? r;
      },
    },
    seller: {
      shop: (shopId) => seller.get(`/internal/shops/${encodeURIComponent(shopId)}`),
    },
    shipping: {
      quote: (req) => shipping.post<ShippingQuote>('/quote', req),
    },
    promotion: {
      quote: (req) => promotion.post<PromotionQuote>('/quote', req),
    },
  };
}
