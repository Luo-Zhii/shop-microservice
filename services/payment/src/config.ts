import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('payment', 8110, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/payment'),
  /** URL công khai của payment qua gateway (trang mock, VNPay return). */
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080/api/payment'),
  VNPAY_TMN_CODE: z.string().default('DEMOTMN1'),
  VNPAY_HASH_SECRET: z.string().default('DEMOSECRETDEMOSECRETDEMOSECRET12'),
  VNPAY_URL: z.string().default('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'),
  /** Hạn thanh toán trên cổng VNPay (phút). */
  VNPAY_EXPIRE_MINUTES: z.coerce.number().int().positive().default(15),
  PLATFORM_COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0.05),
  /** Số tiền tối thiểu mỗi lần rút về ví ngân hàng (VND). */
  MIN_PAYOUT: z.coerce.number().int().min(0).default(50_000),
});
export type Config = typeof cfg;

export interface PaymentConfig {
  PUBLIC_BASE_URL: string;
  VNPAY_TMN_CODE: string;
  VNPAY_HASH_SECRET: string;
  VNPAY_URL: string;
  VNPAY_EXPIRE_MINUTES: number;
  PLATFORM_COMMISSION_RATE: number;
  MIN_PAYOUT: number;
}
