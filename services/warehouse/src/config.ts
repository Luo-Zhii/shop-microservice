import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('warehouse', 8116, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/warehouse'),
  /** Chênh lệch kiểm kê (giá trị tuyệt đối, VND) vượt ngưỡng → cần người khác duyệt (tách nhiệm vụ) */
  COUNT_APPROVAL_THRESHOLD: z.coerce.number().int().min(0).default(2_000_000),
  /** Phí lưu kho mỗi đơn vị mỗi ngày (VND) */
  STORAGE_FEE_PER_UNIT_DAY: z.coerce.number().int().min(0).default(50),
  TIMEZONE: z.string().default('Asia/Ho_Chi_Minh'),
  /** Đối soát tồn với inventory (data consistency SLO); 0 = tắt */
  INVENTORY_URL: z.string().default('http://localhost:8107'),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
});
export type Config = typeof cfg;
