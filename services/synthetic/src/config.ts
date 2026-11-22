import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('synthetic', 8117, {
  /** Đi qua cửa chính như khách thật (ingress/gateway), không gọi thẳng service nội bộ */
  GATEWAY_URL: z.string().url().default('http://localhost:8080'),
  /** Token robot: gateway thấy đúng token mới gắn x-synthetic=1 (search không ghi truy vấn phổ biến từ robot) */
  SYNTHETIC_TOKEN: z.string().default(''),
  INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  STEP_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  SEARCH_QUERY: z.string().default('áo'),
  /** Nhãn vị trí chạy (on-prem / aws) — cùng hành trình từ hai nơi để tách lỗi mạng/cụm khỏi lỗi ứng dụng */
  SYNTHETIC_LOCATION: z.string().default(process.env.CLOUD_PROVIDER || 'local'),
});
export type Config = typeof cfg;
