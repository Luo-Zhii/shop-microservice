// Kiểm kê đột xuất theo tín hiệu (exception-based cycle counting) — kho lớn không chờ tới kỳ kiểm kê ABC (A 30 / B 90 /
// C 180 ngày) khi đã có dấu hiệu số hệ thống sai; đếm NGAY đúng SKU đó, trên mọi kệ đang chứa nó:
//   pick_missing   người lấy hàng báo không thấy đủ hàng tại kệ → phiếu lấy hàng chuyển SHORT (nhả giữ chỗ, đi luồng thiếu hàng
//                  sẵn có cho CS) + TỰ tạo phiếu kiểm kê đột xuất. Tín hiệu mạnh nhất.
//   drift          lệch tồn warehouse ↔ inventory bền vững (reconcile.ts, 8.41) — lệch giữa hai HỆ THỐNG; đếm để biết số nào đúng.
//   variance       lần kiểm kê được duyệt gần nhất (7 ngày) có chênh lệch → đếm lại xác nhận (lỗi đếm hay mất hàng thật).
// Một SKU × kho chỉ có MỘT phiếu đột xuất đang mở — tín hiệu mới gộp vào phiếu đang đếm, không sinh phiếu trùng.
import { conflict, counter, createEvent, enqueue, gauge, newId, notFound, type Pool, type PoolClient } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import type { DriftReport } from './reconcile';

const exceptions = () => counter('warehouse_pick_exceptions_total', 'Báo không thấy hàng tại kệ khi lấy hàng', ['warehouse']);
const spotOpen = () => gauge('warehouse_spot_counts_open', 'Phiếu kiểm kê đột xuất đang mở');

export async function startSpotCount(c: PoolClient, o: { warehouse: string; shopId: string; skuId: string; reason: string; actor: string }) {
  const open = await c.query<{ id: string; count_no: string; reason: string }>(
    "SELECT id, count_no, reason FROM counts WHERE kind = 'SPOT' AND status = 'COUNTING' AND warehouse = $1 AND shop_id = $2 AND sku_id = $3 FOR UPDATE",
    [o.warehouse, o.shopId, o.skuId]);
  if (open.rows[0]) {
    const r = open.rows[0];
    if (!r.reason.includes(o.reason)) await c.query('UPDATE counts SET reason = $2 WHERE id = $1', [r.id, `${r.reason}; ${o.reason}`.slice(0, 500)]);
    return { id: r.id, countNo: r.count_no, created: false, lines: 0 };
  }
  const id = newId();
  const n = await c.query<{ n: number }>('SELECT count(*)::int + 1 AS n FROM counts');
  const countNo = `KKD-${String(n.rows[0].n).padStart(5, '0')}`;
  await c.query(
    "INSERT INTO counts (id, count_no, warehouse, bin_prefix, status, created_by, kind, reason, shop_id, sku_id) VALUES ($1,$2,$3,'','COUNTING',$4,'SPOT',$5,$6,$7)",
    [id, countNo, o.warehouse, o.actor, o.reason.slice(0, 500), o.shopId, o.skuId]);
  // mọi lô của SKU trong kho (kể cả lô vừa báo thiếu và lô đang giữ chỗ) — đếm mù như kiểm kê thường
  const r = await c.query(
    `INSERT INTO count_lines (count_id, lot_id, bin, shop_id, sku_id, system_qty, unit_cost)
     SELECT $1, id, bin, shop_id, sku_id, qty, unit_cost FROM lots WHERE warehouse = $2 AND shop_id = $3 AND sku_id = $4 AND (qty > 0 OR reserved > 0)`,
    [id, o.warehouse, o.shopId, o.skuId]);
  return { id, countNo, created: true, lines: r.rowCount ?? 0 };
}

/** Người lấy hàng báo không thấy đủ hàng: nhả giữ chỗ của phiếu → SHORT (luồng thiếu hàng sẵn có) + kiểm kê đột xuất ngay. */
export async function reportMissing(c: PoolClient, pickId: string, lotId: string, missingQty: number, actor: string) {
  const p = await c.query<{ id: string; status: string; order_id: string; shop_id: string; warehouse: string }>('SELECT * FROM picks WHERE id = $1 FOR UPDATE', [pickId]);
  const pick = p.rows[0];
  if (!pick) throw notFound('không có phiếu lấy hàng');
  if (pick.status !== 'OPEN') throw conflict(`phiếu đang ${pick.status}`);
  const l = await c.query<{ qty: number; bin: string; sku_id: string }>(
    'SELECT pl.qty, l.bin, l.sku_id FROM pick_lines pl JOIN lots l ON l.id = pl.lot_id WHERE pl.pick_id = $1 AND pl.lot_id = $2', [pickId, lotId]);
  const line = l.rows[0];
  if (!line) throw notFound('lô không thuộc phiếu lấy hàng này');
  if (missingQty < 1 || missingQty > line.qty) throw conflict(`số thiếu phải từ 1 tới ${line.qty}`);
  const lines = await c.query<{ lot_id: string; qty: number }>('SELECT lot_id, qty FROM pick_lines WHERE pick_id = $1', [pickId]);
  for (const x of lines.rows) await c.query('UPDATE lots SET reserved = reserved - $1 WHERE id = $2', [x.qty, x.lot_id]);
  const reason = `không thấy hàng tại ${line.bin}: ${line.sku_id} thiếu ${missingQty}`;
  await c.query("UPDATE picks SET status = 'SHORT', short_reason = $2, updated_at = now() WHERE id = $1", [pickId, reason]);
  await enqueue(c, Topics.warehouse, createEvent('warehouse.pick_short', 'warehouse', pick.order_id,
    { orderId: pick.order_id, shopId: pick.shop_id, reason }));
  const count = await startSpotCount(c, { warehouse: pick.warehouse, shopId: pick.shop_id, skuId: line.sku_id, reason: `pick_missing:${line.bin}`, actor });
  await c.query(
    `INSERT INTO pick_exceptions (id, pick_id, lot_id, warehouse, bin, shop_id, sku_id, missing_qty, reported_by, count_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [newId(), pickId, lotId, pick.warehouse, line.bin, pick.shop_id, line.sku_id, missingQty, actor, count.id]);
  exceptions().inc({ warehouse: pick.warehouse });
  return { pickId, status: 'SHORT', reason, count };
}

export interface Candidate { warehouse: string; shopId: string; skuId: string; signals: string[]; qty: number; value: number; openSpotCount: string | null }

/** Ứng viên kiểm kê đột xuất từ ba tín hiệu; xếp theo số tín hiệu rồi giá trị tồn (đếm hàng đắt trước). */
export async function candidates(db: Pool | PoolClient, drift: DriftReport | null): Promise<Candidate[]> {
  const sig = new Map<string, Set<string>>();
  const add = (shop: string, sku: string, s: string) => sig.set(`${shop}|${sku}`, (sig.get(`${shop}|${sku}`) ?? new Set()).add(s));
  for (const d of drift?.drifts ?? []) if (d.persistent) add(d.shopId, d.skuId, `drift:${d.kind} ${d.delta > 0 ? '+' : ''}${d.delta}`);
  const variance = await db.query<{ shop_id: string; sku_id: string; diff: number }>(
    `SELECT cl.shop_id, cl.sku_id, SUM(cl.counted_qty - cl.system_qty)::int AS diff FROM count_lines cl JOIN counts c ON c.id = cl.count_id
      WHERE c.status = 'APPROVED' AND c.decided_at > now() - interval '7 days' AND cl.counted_qty IS NOT NULL
      GROUP BY cl.shop_id, cl.sku_id HAVING SUM(abs(cl.counted_qty - cl.system_qty)) > 0`);
  for (const v of variance.rows) add(v.shop_id, v.sku_id, `variance ${v.diff > 0 ? '+' : ''}${v.diff}`);
  const missing = await db.query<{ shop_id: string; sku_id: string; n: number }>(
    `SELECT e.shop_id, e.sku_id, count(*)::int AS n FROM pick_exceptions e LEFT JOIN counts c ON c.id = e.count_id
      WHERE e.at > now() - interval '7 days' AND (c.status IS NULL OR c.status IN ('COUNTING','SUBMITTED')) GROUP BY e.shop_id, e.sku_id`);
  for (const m of missing.rows) add(m.shop_id, m.sku_id, `pick_missing ×${m.n}`);
  if (!sig.size) return [];
  const keys = [...sig.keys()].map((k) => k.split('|'));
  const { rows } = await db.query<{ warehouse: string; shop_id: string; sku_id: string; qty: number; value: number; spot: string | null }>(
    `SELECT l.warehouse, l.shop_id, l.sku_id, SUM(l.qty)::int AS qty, SUM(l.qty * l.unit_cost)::bigint AS value,
            (SELECT c.count_no FROM counts c WHERE c.kind = 'SPOT' AND c.status = 'COUNTING' AND c.warehouse = l.warehouse
               AND c.shop_id = l.shop_id AND c.sku_id = l.sku_id LIMIT 1) AS spot
       FROM lots l WHERE (l.shop_id, l.sku_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
      GROUP BY l.warehouse, l.shop_id, l.sku_id`, [keys.map((k) => k[0]), keys.map((k) => k[1])]);
  const out = rows.map((r) => ({ warehouse: r.warehouse, shopId: r.shop_id, skuId: r.sku_id, signals: [...(sig.get(`${r.shop_id}|${r.sku_id}`) ?? [])],
    qty: Number(r.qty), value: Number(r.value), openSpotCount: r.spot }));
  out.sort((a, b) => b.signals.length - a.signals.length || b.value - a.value);
  return out;
}

export async function refreshSpotGauge(db: Pool) {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM counts WHERE kind = 'SPOT' AND status = 'COUNTING'");
  spotOpen().set(Number(rows[0].n));
}
