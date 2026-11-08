import { envBool, loadConfig, z } from '@shopnow/platform';

const url = (port: number) => z.string().url().default(`http://localhost:${port}`);

export const cfg = loadConfig('api-gateway', 8080, {
  REDIS_URL: z.string().default('redis://localhost:56379'),
  RATE_LIMIT_ENABLED: envBool.default(true),
  RATE_LIMIT_GLOBAL: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_AUTH: z.coerce.number().int().min(1).default(30),
  BFF_TIMEOUT_MS: z.coerce.number().int().min(100).default(1500),
  STATUS_TIMEOUT_MS: z.coerce.number().int().min(100).default(1500),
  IDENTITY_URL: url(8101),
  USER_PROFILE_URL: url(8102),
  SELLER_URL: url(8103),
  CATALOG_URL: url(8104),
  SEARCH_URL: url(8105),
  INVENTORY_URL: url(8106),
  CART_URL: url(8107),
  PROMOTION_URL: url(8108),
  ORDER_URL: url(8109),
  PAYMENT_URL: url(8110),
  SHIPPING_URL: url(8111),
  REVIEW_URL: url(8112),
  NOTIFICATION_URL: url(8113),
  AI_URL: url(8114),
});
export type Config = typeof cfg;

/** Tên trong đường dẫn `/api/<name>/*` → URL upstream. */
export function upstreamsFrom(c: Config) {
  return {
    identity: c.IDENTITY_URL,
    'user-profile': c.USER_PROFILE_URL,
    seller: c.SELLER_URL,
    catalog: c.CATALOG_URL,
    search: c.SEARCH_URL,
    inventory: c.INVENTORY_URL,
    cart: c.CART_URL,
    promotion: c.PROMOTION_URL,
    order: c.ORDER_URL,
    payment: c.PAYMENT_URL,
    shipping: c.SHIPPING_URL,
    review: c.REVIEW_URL,
    notification: c.NOTIFICATION_URL,
    ai: c.AI_URL,
  };
}
export type Upstreams = ReturnType<typeof upstreamsFrom>;
export type UpstreamName = keyof Upstreams;
