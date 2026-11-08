import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('order', 8109, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/orders'),
  CATALOG_URL: z.string().default('http://localhost:8104'),
  USER_PROFILE_URL: z.string().default('http://localhost:8102'),
  SELLER_URL: z.string().default('http://localhost:8103'),
  SHIPPING_URL: z.string().default('http://localhost:8111'),
  PROMOTION_URL: z.string().default('http://localhost:8108'),
  /** FE: returnUrl sau thanh toán = WEB_URL/checkout/result?checkoutId=… */
  WEB_URL: z.string().default('http://localhost:3000'),
  PAYMENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  AUTO_COMPLETE_SECONDS: z.coerce.number().int().positive().default(259_200),
  RETURN_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Shop chưa khai báo tỉnh lấy hàng → dùng tỉnh mặc định để báo giá ship. */
  DEFAULT_PICKUP_PROVINCE: z.string().default('Hồ Chí Minh'),
});
export type Config = typeof cfg;

/** Phần cấu hình saga cần (test truyền thẳng, không đọc env). */
export interface SagaConfig {
  WEB_URL: string;
  PAYMENT_TIMEOUT_SECONDS: number;
  AUTO_COMPLETE_SECONDS: number;
  RETURN_WINDOW_DAYS: number;
  DEFAULT_PICKUP_PROVINCE: string;
}
