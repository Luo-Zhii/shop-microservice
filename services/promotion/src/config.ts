import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('promotion', 8108, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/promotion'),
  REDIS_URL: z.string().default('redis://localhost:56379'),
  /** Tiền tố key Redis (flash sale) — tách môi trường / test dùng chung một Redis. */
  REDIS_PREFIX: z.string().default('promo:'),
  /** Lớn hơn PAYMENT_TIMEOUT_SECONDS của order (900s). */
  LOCK_TTL_SECONDS: z.coerce.number().int().default(1800),
});
export type Config = typeof cfg;
