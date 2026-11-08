import { envBool, loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('identity', 8101, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/identity'),
  /** PEM PKCS#8 RSA; bỏ trống → tự sinh và lưu bảng signing_keys. Chấp nhận "\n" dạng escape. */
  JWT_PRIVATE_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).default(600),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  LOGIN_MAX_FAILED: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  ADMIN_EMAIL: z.string().default('admin@shopnow.local'),
  ADMIN_PASSWORD: z.string().default('Admin@12345'),
  DEV_EXPOSE_OTP: envBool.default(false),
  TOTP_ISSUER: z.string().default('ShopNow'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:3000/auth/google/callback'),
});
export type Config = typeof cfg;

/** Phần cấu hình route cần — tách riêng để test tự dựng. */
export type Settings = Pick<
  Config,
  | 'JWT_ISSUER'
  | 'JWT_AUDIENCE'
  | 'INTERNAL_TOKEN'
  | 'ACCESS_TOKEN_TTL_SECONDS'
  | 'REFRESH_TOKEN_TTL_DAYS'
  | 'OTP_TTL_SECONDS'
  | 'OTP_MAX_ATTEMPTS'
  | 'OTP_RESEND_COOLDOWN_SECONDS'
  | 'LOGIN_MAX_FAILED'
  | 'LOGIN_LOCK_MINUTES'
  | 'DEV_EXPOSE_OTP'
  | 'TOTP_ISSUER'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_REDIRECT_URI'
>;
