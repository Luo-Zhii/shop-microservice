// SLA xuất kho theo giờ cắt đơn (cut-off) — thực hành kho TMĐT: đơn xác nhận TRƯỚC giờ cắt phải xuất trong ngày (hạn 23:59),
// sau giờ cắt thì xuất trước 12:00 hôm sau. Tính theo giờ Việt Nam (+7, không có giờ mùa hè).
// Gauge cập nhật mỗi phút → cảnh báo + KPI có hướng của AIOps (pick_overdue tăng là xấu) — tắc nghẽn kho là sự cố
// nghiệp vụ dù mọi API vẫn trả 200.
import { gauge, type Pool } from '@shopnow/platform';

const VN_MS = 7 * 3600_000;
export type SlaState = 'ok' | 'due_soon' | 'overdue';

export function pickDue(createdAt: Date, cutoffHour = 14): Date {
  const local = new Date(createdAt.getTime() + VN_MS);              // "giờ VN" biểu diễn trong trường UTC
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  const dueLocal = local.getUTCHours() < cutoffHour
    ? Date.UTC(y, m, d, 23, 59, 59)
    : Date.UTC(y, m, d + 1, 12, 0, 0);
  return new Date(dueLocal - VN_MS);
}

export function slaOf(createdAt: Date, now: Date, cutoffHour = 14, soonMinutes = 120) {
  const due = pickDue(createdAt, cutoffHour);
  const minutesLeft = Math.round((due.getTime() - now.getTime()) / 60_000);
  const state: SlaState = minutesLeft < 0 ? 'overdue' : minutesLeft <= soonMinutes ? 'due_soon' : 'ok';
  return { dueAt: due.toISOString(), minutesLeft, state };
}

const overdueG = () => gauge('warehouse_picks_overdue', 'Phiếu lấy hàng quá hạn xuất kho (SLA cut-off)');
const soonG = () => gauge('warehouse_picks_due_soon', 'Phiếu lấy hàng sắp quá hạn (≤ 2 giờ)');
const oldestG = () => gauge('warehouse_pick_oldest_overdue_seconds', 'Phiếu quá hạn lâu nhất (giây)');

/** Đếm phiếu OPEN/SHORT theo trạng thái SLA và cập nhật gauge. */
export async function refreshPickSla(pool: Pool, now = new Date(), cutoffHour = 14) {
  const { rows } = await pool.query<{ created_at: Date }>("SELECT created_at FROM picks WHERE status IN ('OPEN','SHORT')");
  let overdue = 0, soon = 0, oldest = 0;
  for (const r of rows) {
    const s = slaOf(new Date(r.created_at), now, cutoffHour);
    if (s.state === 'overdue') { overdue++; oldest = Math.max(oldest, -s.minutesLeft * 60); }
    else if (s.state === 'due_soon') soon++;
  }
  overdueG().set(overdue); soonG().set(soon); oldestG().set(oldest);
  return { open: rows.length, overdue, dueSoon: soon, oldestOverdueSeconds: oldest };
}
