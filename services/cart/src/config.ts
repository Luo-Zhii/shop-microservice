import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('cart', 8107, {
  REDIS_URL: z.string().default('redis://localhost:56379'),
  CART_KEY_PREFIX: z.string().default('cart:'),
  CART_GUEST_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  CATALOG_URL: z.string().default('http://localhost:8104'),
  INVENTORY_URL: z.string().default('http://localhost:8106'),
});
export type Config = typeof cfg;
