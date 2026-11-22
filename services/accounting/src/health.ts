// Sức khoẻ tài chính dạng metric — KPI nghiệp vụ cho AIOps: tiền thu hộ (3388) treo quá N ngày = khách đã trả tiền mà
// đơn không hoàn tất/hoàn tiền (saga kẹt) → rủi ro tài chính và khiếu nại, trong khi mọi API vẫn trả 200.
// Dùng chung cho checklist khoá sổ (routes) và gauge cập nhật định kỳ (main).
import { gauge, type Pool, type PoolClient } from '@shopnow/platform';

export async function staleBalances(pool: Pool | PoolClient, endDate: string, staleDays: number) {
  const escrow = await pool.query<{ n: number; amount: string }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(bal),0)::bigint AS amount FROM (
       SELECT l.party_id, SUM(l.credit - l.debit) AS bal, max(e.entry_date) AS last_date
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account = '3388' AND e.entry_date <= $1 GROUP BY l.party_id) t
      WHERE bal > 0 AND last_date <= ($1::date - $2::int)`, [endDate, staleDays]);
  const cod = await pool.query<{ n: number; amount: string }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(bal),0)::bigint AS amount FROM (
       SELECT l.order_id, SUM(l.debit - l.credit) AS bal, min(e.entry_date) AS first_date
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account = '1388' AND e.entry_date <= $1 GROUP BY l.order_id) t
      WHERE bal > 0 AND first_date <= ($1::date - $2::int)`, [endDate, staleDays]);
  return {
    escrow: { n: Number(escrow.rows[0].n), amount: Number(escrow.rows[0].amount) },
    cod: { n: Number(cod.rows[0].n), amount: Number(cod.rows[0].amount) },
  };
}

const g = (name: string, help: string) => gauge(name, help);

export async function refreshFinanceGauges(pool: Pool, today: string, staleDays = 15) {
  const s = await staleBalances(pool, today, staleDays);
  g('accounting_escrow_stale_checkouts', `Checkout có tiền thu hộ 3388 treo quá ${staleDays} ngày`).set(s.escrow.n);
  g('accounting_escrow_stale_vnd', 'Số tiền thu hộ treo (VND)').set(s.escrow.amount);
  g('accounting_cod_open_orders', `Đơn COD ĐVVC giữ tiền quá ${staleDays} ngày chưa đối soát`).set(s.cod.n);
  g('accounting_cod_open_vnd', 'Số tiền COD chưa đối soát (VND)').set(s.cod.amount);
  return s;
}
