import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('seller', 8103, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/seller'),
  /** Khoá mã hoá KYC (chuỗi bất kỳ, dẫn xuất sha256). Prod: lấy từ Secrets Manager / Vault. */
  KYC_ENCRYPTION_KEY: z.string().min(16).default('dev-only-kyc-key-change-me'),
});
export type Config = typeof cfg;
