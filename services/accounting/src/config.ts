import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('accounting', 8115, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/accounting'),
  /** Phí hoa hồng sàn trên (tổng đơn − phí ship), đã gồm VAT */
  COMMISSION_RATE: z.coerce.number().min(0).max(0.5).default(0.05),
  VAT_RATE: z.coerce.number().min(0).max(0.2).default(0.1),
  /** Ký hiệu hoá đơn điện tử (TT78): 1 = HĐ GTGT, C = có mã CQT, 26 = năm, T = DN đăng ký, SN = tự đặt */
  INVOICE_SERIES: z.string().default('1C26TSN'),
  TIMEZONE: z.string().default('Asia/Ho_Chi_Minh'),
});
export type Config = typeof cfg;
