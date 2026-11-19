import { badRequest, conflict, createEvent, enqueue, forbidden, newId, notFound, type PoolClient } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';

export interface Lot {
  id: string;
  warehouse: string;
  bin: string;
  shop_id: string;
  sku_id: string;
  qty: number;
  reserved: number;
  unit_cost: number;
  received_at: string;
}

type MoveType = 'RECEIPT' | 'ISSUE' | 'ADJUST_IN' | 'ADJUST_OUT' | 'TRANSFER_IN' | 'TRANSFER_OUT';

async function move(c: PoolClient, type: MoveType, lot: Pick<Lot, 'id' | 'warehouse' | 'bin' | 'shop_id' | 'sku_id' | 'unit_cost'>,
  qty: number, ref: [string, string], actor: string) {
  await c.query(
    `INSERT INTO stock_moves (type, lot_id, warehouse, bin, shop_id, sku_id, qty, unit_cost, ref_type, ref_id, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [type, lot.id, lot.warehouse, lot.bin, lot.shop_id, lot.sku_id, qty, lot.unit_cost, ref[0], ref[1], actor]);
}

async function emitStock(c: PoolClient, shopId: string, skuId: string, reason: string) {
  const { rows } = await c.query<{ on_hand: number; available: number }>(
    'SELECT COALESCE(SUM(qty),0)::int AS on_hand, COALESCE(SUM(qty - reserved),0)::int AS available FROM lots WHERE shop_id = $1 AND sku_id = $2',
    [shopId, skuId]);
  await enqueue(c, Topics.warehouse, createEvent('warehouse.stock_changed', 'warehouse', skuId, { shopId, skuId, ...rows[0], reason }));
}

// ---------------------------------------------------------------- nhập kho
export async function createReceipt(c: PoolClient, input: { warehouse: string; shopId: string; lines: { skuId: string; qty: number; unitCost: number }[] }, actor: string) {
  const id = newId();
  const n = await c.query<{ n: number }>("SELECT count(*)::int + 1 AS n FROM receipts WHERE created_at::date = current_date");
  const receiptNo = `PN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(n.rows[0].n).padStart(4, '0')}`;
  await c.query("INSERT INTO receipts (id, receipt_no, warehouse, shop_id, status, created_by) VALUES ($1,$2,$3,$4,'EXPECTED',$5)",
    [id, receiptNo, input.warehouse, input.shopId, actor]);
  for (const l of input.lines) {
    await c.query('INSERT INTO receipt_lines (receipt_id, sku_id, qty_expected, unit_cost) VALUES ($1,$2,$3,$4)', [id, l.skuId, l.qty, l.unitCost]);
  }
  return { id, receiptNo };
}

/** Nhận hàng: hàng tốt vào kệ chỉ định, hàng hỏng vào QUARANTINE; ghi chênh lệch so với ASN. */
export async function receive(c: PoolClient, receiptId: string, lines: { skuId: string; received: number; damaged?: number; bin: string }[], actor: string) {
  const r = await c.query<{ id: string; warehouse: string; shop_id: string; status: string }>('SELECT * FROM receipts WHERE id = $1 FOR UPDATE', [receiptId]);
  const rc = r.rows[0];
  if (!rc) throw notFound('không có phiếu nhập');
  if (rc.status !== 'EXPECTED') throw conflict(`phiếu nhập đang ${rc.status}`);
  const expected = await c.query<{ sku_id: string; qty_expected: number; unit_cost: number }>('SELECT * FROM receipt_lines WHERE receipt_id = $1', [receiptId]);
  const discrepancies: { skuId: string; expected: number; received: number; damaged: number }[] = [];
  for (const e of expected.rows) {
    const got = lines.find((l) => l.skuId === e.sku_id) ?? { skuId: e.sku_id, received: 0, damaged: 0, bin: 'RCV' };
    const damaged = got.damaged ?? 0;
    if (damaged > got.received) throw badRequest(`${e.sku_id}: hỏng nhiều hơn số nhận`);
    await c.query('UPDATE receipt_lines SET qty_received = $1, qty_damaged = $2, bin = $3 WHERE receipt_id = $4 AND sku_id = $5',
      [got.received, damaged, got.bin, receiptId, e.sku_id]);
    if (got.received !== e.qty_expected || damaged) discrepancies.push({ skuId: e.sku_id, expected: e.qty_expected, received: got.received, damaged });
    for (const [bin, qty] of [[got.bin, got.received - damaged], ['QRT', damaged]] as const) {
      if (qty <= 0) continue;
      const lot = { id: newId(), warehouse: rc.warehouse, bin, shop_id: rc.shop_id, sku_id: e.sku_id, unit_cost: Number(e.unit_cost) };
      await c.query('INSERT INTO lots (id, warehouse, bin, shop_id, sku_id, receipt_id, qty, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [lot.id, lot.warehouse, lot.bin, lot.shop_id, lot.sku_id, receiptId, qty, lot.unit_cost]);
      await move(c, 'RECEIPT', lot, qty, ['receipt', receiptId], actor);
    }
    await emitStock(c, rc.shop_id, e.sku_id, 'receipt');
  }
  const extra = lines.filter((l) => !expected.rows.some((e) => e.sku_id === l.skuId));
  if (extra.length) throw badRequest(`SKU ngoài ASN: ${extra.map((l) => l.skuId).join(', ')} — lập phiếu nhập bổ sung`);
  await c.query("UPDATE receipts SET status = 'RECEIVED', received_by = $1, received_at = now() WHERE id = $2", [actor, receiptId]);
  return { receiptId, discrepancies };
}

// ---------------------------------------------------------------- xuất kho (FIFO)
/** Giữ chỗ FIFO cho đơn; thiếu hàng → phiếu SHORT (không giữ gì) để CS xử lý. */
export async function allocatePick(c: PoolClient, order: { id: string; shopId: string; items: { skuId: string; qty: number }[] }) {
  const exists = await c.query('SELECT id FROM picks WHERE order_id = $1', [order.id]);
  if (exists.rowCount) return { id: exists.rows[0].id as string, created: false };
  const id = newId();
  const plan: { lot: Lot; qty: number }[] = [];
  let short: string | null = null;
  for (const it of order.items) {
    const { rows } = await c.query<Lot>(
      `SELECT l.* FROM lots l JOIN bins b ON b.warehouse = l.warehouse AND b.code = l.bin
        WHERE l.shop_id = $1 AND l.sku_id = $2 AND l.qty > l.reserved AND b.zone IN ('STORAGE','PICKING')
        ORDER BY l.received_at, l.id FOR UPDATE OF l`, [order.shopId, it.skuId]);
    let need = it.qty;
    for (const lot of rows) {
      if (need <= 0) break;
      const take = Math.min(need, lot.qty - lot.reserved);
      plan.push({ lot, qty: take });
      need -= take;
    }
    if (need > 0) short = `${it.skuId} thiếu ${need}`;
  }
  const warehouse = plan[0]?.lot.warehouse ?? 'HCM1';
  await c.query('INSERT INTO picks (id, order_id, shop_id, warehouse, status, short_reason) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, order.id, order.shopId, warehouse, short ? 'SHORT' : 'OPEN', short]);
  if (short) {
    await enqueue(c, Topics.warehouse, createEvent('warehouse.pick_short', 'warehouse', order.id, { orderId: order.id, shopId: order.shopId, reason: short }));
    return { id, created: true, short };
  }
  for (const p of plan) {
    await c.query('UPDATE lots SET reserved = reserved + $1 WHERE id = $2', [p.qty, p.lot.id]);
    await c.query('INSERT INTO pick_lines (pick_id, lot_id, sku_id, bin, qty) VALUES ($1,$2,$3,$4,$5)', [id, p.lot.id, p.lot.sku_id, p.lot.bin, p.qty]);
  }
  return { id, created: true };
}

export async function confirmPick(c: PoolClient, pickId: string, actor: string) {
  const p = await c.query<{ status: string; shop_id: string; order_id: string }>('SELECT * FROM picks WHERE id = $1 FOR UPDATE', [pickId]);
  if (!p.rows[0]) throw notFound('không có phiếu lấy hàng');
  if (p.rows[0].status !== 'OPEN') throw conflict(`phiếu đang ${p.rows[0].status}`);
  const lines = await c.query<{ lot_id: string; qty: number }>('SELECT lot_id, qty FROM pick_lines WHERE pick_id = $1', [pickId]);
  let cogs = 0;
  const skus = new Set<string>();
  for (const l of lines.rows) {
    const { rows } = await c.query<Lot>('UPDATE lots SET qty = qty - $1, reserved = reserved - $1 WHERE id = $2 RETURNING *', [l.qty, l.lot_id]);
    await move(c, 'ISSUE', rows[0], l.qty, ['pick', pickId], actor);
    cogs += l.qty * Number(rows[0].unit_cost);
    skus.add(rows[0].sku_id);
  }
  await c.query("UPDATE picks SET status = 'PICKED', picked_by = $1, updated_at = now() WHERE id = $2", [actor, pickId]);
  for (const s of skus) await emitStock(c, p.rows[0].shop_id, s, 'issue');
  await enqueue(c, Topics.warehouse, createEvent('warehouse.picked', 'warehouse', p.rows[0].order_id,
    { pickId, orderId: p.rows[0].order_id, shopId: p.rows[0].shop_id, cogs }));
  return { pickId, cogs };
}

export async function cancelPick(c: PoolClient, orderId: string) {
  const p = await c.query<{ id: string; status: string }>("SELECT id, status FROM picks WHERE order_id = $1 FOR UPDATE", [orderId]);
  if (!p.rows[0] || p.rows[0].status !== 'OPEN') return false;
  const lines = await c.query<{ lot_id: string; qty: number }>('SELECT lot_id, qty FROM pick_lines WHERE pick_id = $1', [p.rows[0].id]);
  for (const l of lines.rows) await c.query('UPDATE lots SET reserved = reserved - $1 WHERE id = $2', [l.qty, l.lot_id]);
  await c.query("UPDATE picks SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [p.rows[0].id]);
  return true;
}

// ---------------------------------------------------------------- kiểm kê
export async function startCount(c: PoolClient, warehouse: string, binPrefix: string, actor: string) {
  const id = newId();
  const n = await c.query<{ n: number }>('SELECT count(*)::int + 1 AS n FROM counts');
  const countNo = `KK-${String(n.rows[0].n).padStart(5, '0')}`;
  await c.query("INSERT INTO counts (id, count_no, warehouse, bin_prefix, status, created_by) VALUES ($1,$2,$3,$4,'COUNTING',$5)",
    [id, countNo, warehouse, binPrefix, actor]);
  // chụp số hệ thống lúc bắt đầu; lô đang giữ chỗ cho đơn vẫn đếm (hàng còn trên kệ)
  const r = await c.query(
    `INSERT INTO count_lines (count_id, lot_id, bin, shop_id, sku_id, system_qty, unit_cost)
     SELECT $1, id, bin, shop_id, sku_id, qty, unit_cost FROM lots WHERE warehouse = $2 AND bin LIKE $3 AND qty > 0`,
    [id, warehouse, `${binPrefix}%`]);
  return { id, countNo, lines: r.rowCount ?? 0 };
}

/** Phiếu đếm mù: không lộ system_qty cho người đếm. */
export async function countSheet(c: PoolClient, id: string) {
  const { rows } = await c.query('SELECT lot_id, bin, shop_id, sku_id, counted_qty FROM count_lines WHERE count_id = $1 ORDER BY bin, sku_id', [id]);
  return rows;
}

export async function submitCount(c: PoolClient, id: string, counted: { lotId: string; qty: number }[], actor: string, threshold: number) {
  const ct = await c.query<{ status: string }>('SELECT status FROM counts WHERE id = $1 FOR UPDATE', [id]);
  if (!ct.rows[0]) throw notFound('không có phiếu kiểm kê');
  if (ct.rows[0].status !== 'COUNTING') throw conflict(`phiếu đang ${ct.rows[0].status}`);
  for (const x of counted) {
    const u = await c.query('UPDATE count_lines SET counted_qty = $1 WHERE count_id = $2 AND lot_id = $3', [x.qty, id, x.lotId]);
    if (!u.rowCount) throw badRequest(`lô ${x.lotId} không thuộc phiếu`);
  }
  const missing = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM count_lines WHERE count_id = $1 AND counted_qty IS NULL', [id]);
  if (missing.rows[0].n) throw badRequest(`còn ${missing.rows[0].n} dòng chưa đếm`);
  const v = await c.query<{ value: number; abs_value: number }>(
    `SELECT COALESCE(SUM((counted_qty - system_qty) * unit_cost),0)::bigint AS value,
            COALESCE(SUM(abs(counted_qty - system_qty) * unit_cost),0)::bigint AS abs_value FROM count_lines WHERE count_id = $1`, [id]);
  await c.query("UPDATE counts SET status = 'SUBMITTED', submitted_by = $1, variance_value = $2 WHERE id = $3", [actor, v.rows[0].value, id]);
  const needsApproval = Number(v.rows[0].abs_value) > threshold;
  return { id, varianceValue: Number(v.rows[0].value), absVariance: Number(v.rows[0].abs_value), needsApproval };
}

/** Duyệt kiểm kê → bút điều chỉnh tồn. Vượt ngưỡng thì người duyệt phải khác người đếm (four-eyes). */
export async function approveCount(c: PoolClient, id: string, actor: string, threshold: number, approve = true) {
  const ct = await c.query<{ status: string; submitted_by: string; count_no: string; variance_value: number }>('SELECT * FROM counts WHERE id = $1 FOR UPDATE', [id]);
  const row = ct.rows[0];
  if (!row) throw notFound('không có phiếu kiểm kê');
  if (row.status !== 'SUBMITTED') throw conflict(`phiếu đang ${row.status}`);
  const lines = await c.query<{ lot_id: string; system_qty: number; counted_qty: number; unit_cost: number }>(
    'SELECT * FROM count_lines WHERE count_id = $1 AND counted_qty <> system_qty', [id]);
  const abs = lines.rows.reduce((s, l) => s + Math.abs(l.counted_qty - l.system_qty) * Number(l.unit_cost), 0);
  if (abs > threshold && actor === row.submitted_by) throw forbidden('chênh lệch vượt ngưỡng — người duyệt phải khác người đếm');
  if (!approve) {
    await c.query("UPDATE counts SET status = 'REJECTED', approved_by = $1, decided_at = now() WHERE id = $2", [actor, id]);
    return { id, adjusted: 0 };
  }
  const touched = new Map<string, string>();
  for (const l of lines.rows) {
    // tồn đã đổi kể từ lúc chụp (nhập/xuất trong lúc đếm) → điều chỉnh theo chênh lệch, không ghi đè
    const diff = l.counted_qty - l.system_qty;
    const { rows } = await c.query<Lot>('UPDATE lots SET qty = qty + $1 WHERE id = $2 AND qty + $1 >= reserved RETURNING *', [diff, l.lot_id]);
    if (!rows[0]) throw conflict(`lô ${l.lot_id}: điều chỉnh làm tồn nhỏ hơn số đã giữ cho đơn`);
    await move(c, diff > 0 ? 'ADJUST_IN' : 'ADJUST_OUT', rows[0], Math.abs(diff), ['count', id], actor);
    touched.set(`${rows[0].shop_id}|${rows[0].sku_id}`, rows[0].shop_id);
  }
  await c.query("UPDATE counts SET status = 'APPROVED', approved_by = $1, decided_at = now() WHERE id = $2", [actor, id]);
  for (const k of touched.keys()) {
    const [shop, sku] = k.split('|');
    await emitStock(c, shop, sku, 'count');
  }
  await enqueue(c, Topics.warehouse, createEvent('warehouse.count_adjusted', 'warehouse', id,
    { countId: id, countNo: row.count_no, varianceValue: Number(row.variance_value), lines: lines.rowCount }));
  return { id, adjusted: lines.rowCount ?? 0 };
}

// ---------------------------------------------------------------- báo cáo nhập – xuất – tồn
export async function stockLedgerReport(c: PoolClient | { query: PoolClient['query'] }, from: string, to: string, shopId?: string) {
  const { rows } = await c.query(
    `WITH m AS (
       SELECT shop_id, sku_id,
              SUM(CASE WHEN at <  $1 THEN (CASE WHEN type IN ('RECEIPT','ADJUST_IN','TRANSFER_IN') THEN qty ELSE -qty END) ELSE 0 END) AS opening_qty,
              SUM(CASE WHEN at <  $1 THEN (CASE WHEN type IN ('RECEIPT','ADJUST_IN','TRANSFER_IN') THEN qty ELSE -qty END) * unit_cost ELSE 0 END) AS opening_value,
              SUM(CASE WHEN at >= $1 AND at < $2 AND type IN ('RECEIPT','ADJUST_IN','TRANSFER_IN') THEN qty ELSE 0 END) AS in_qty,
              SUM(CASE WHEN at >= $1 AND at < $2 AND type IN ('RECEIPT','ADJUST_IN','TRANSFER_IN') THEN qty * unit_cost ELSE 0 END) AS in_value,
              SUM(CASE WHEN at >= $1 AND at < $2 AND type IN ('ISSUE','ADJUST_OUT','TRANSFER_OUT') THEN qty ELSE 0 END) AS out_qty,
              SUM(CASE WHEN at >= $1 AND at < $2 AND type IN ('ISSUE','ADJUST_OUT','TRANSFER_OUT') THEN qty * unit_cost ELSE 0 END) AS out_value
         FROM stock_moves WHERE at < $2 AND ($3::text IS NULL OR shop_id = $3) GROUP BY shop_id, sku_id)
     SELECT *, opening_qty + in_qty - out_qty AS closing_qty, opening_value + in_value - out_value AS closing_value
       FROM m ORDER BY shop_id, sku_id`, [from, to, shopId ?? null]);
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k.endsWith('_id') ? v : Number(v)])));
}

/** Phí lưu kho = Σ (số lượng tồn × số ngày tồn) trong kỳ × đơn giá — tính từ thẻ kho, khử trùng theo (shop, kỳ). */
export async function chargeStorage(c: PoolClient, period: string, rate: number) {
  const start = `${period}-01`;
  const { rows } = await c.query<{ shop_id: string; unit_days: number }>(
    `WITH bounds AS (SELECT $1::date AS s, ($1::date + interval '1 month')::date AS e),
          ev AS (
            SELECT m.shop_id, GREATEST(m.at, b.s::timestamptz) AS at,
                   (CASE WHEN m.type IN ('RECEIPT','ADJUST_IN','TRANSFER_IN') THEN m.qty ELSE -m.qty END) AS d
              FROM stock_moves m, bounds b WHERE m.at < b.e)
     SELECT shop_id, COALESCE(SUM(d * EXTRACT(EPOCH FROM ((SELECT e FROM bounds)::timestamptz - at)) / 86400), 0)::bigint AS unit_days
       FROM ev GROUP BY shop_id`, [start]);
  const out = [];
  for (const r of rows) {
    const amount = Math.round(Number(r.unit_days) * rate);
    if (amount <= 0) continue;
    const ins = await c.query('INSERT INTO storage_fees (shop_id, period, unit_days, amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *',
      [r.shop_id, period, r.unit_days, amount]);
    if (!ins.rowCount) continue;
    await enqueue(c, Topics.warehouse, createEvent('warehouse.storage_fee_charged', 'warehouse', `${r.shop_id}:${period}`,
      { shopId: r.shop_id, period, unitDays: Number(r.unit_days), amount }));
    out.push({ shopId: r.shop_id, period, unitDays: Number(r.unit_days), amount });
  }
  return out;
}
