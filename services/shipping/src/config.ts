import { envBool, loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('shipping', 8111, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/shipping'),
  SELLER_URL: z.string().default('http://localhost:8103'),
  CATALOG_URL: z.string().default('http://localhost:8104'),
  CARRIER_WEBHOOK_SECRET: z.string().default('dev-carrier-secret'),
  /** Kho lấy hàng mặc định khi shop chưa khai báo pickupProvince */
  DEFAULT_PICKUP_PROVINCE: z.string().default('Hồ Chí Minh'),
  DEV_SIMULATOR: envBool.default(false),
  DEV_AUTO_ADVANCE_SECONDS: z.coerce.number().int().min(0).default(0),
});
export type Config = typeof cfg;
