// Đối soát tồn kho liên service (data consistency SLO) — warehouse là nguồn sự thật về hàng thật; inventory (Go) giữ tồn
// để BÁN, đồng bộ qua Kafka (warehouse.stock_changed → syncFromWarehouse). Event mất / xử lý trùng / consumer lỗi im lặng
// → hai bên lệch nhau mà không alert nào kêu: `over` = inventory nhiều hơn thật → BÁN VƯỢT TỒN; `under` = bán hụt.
// Bất biến (giống syncFromWarehouse): inventory.onHand = max(warehouse.available, inventory.reserved).
// Chỉ báo lệch BỀN VỮNG (cùng chiều ở 2 lần chạy liên tiếp) — lệch thoáng qua do event đang trên đường không phải lỗi.
// Tự chữa đi đúng đường sự kiện: phát lại warehouse.stock_changed (không ghi thẳng vào DB của service khác).
import { counter, gauge, type Pool } from '@shopnow/platform';
import { emitStock } from './stock';

export interface InvStock { skuId: string; onHand: number; reserved: number; available: number }
export type DriftKind = 'over' | 'under' | 'missing';
export interface Drift { shopId: string; skuId: string; kind: DriftKind; warehouseAvailable: number; inventoryOnHand: number | null; expected: number; delta: number; persistent: boolean }
export interface DriftReport { at: string; skus: number; drifts: Drift[]; persistent: number; units: number; ok: boolean; error?: string }

const driftSkus = () => gauge('warehouse_stock_drift_skus', 'SKU lệch tồn BỀN VỮNG giữa warehouse và inventory', ['kind']);
const driftUnits = () => gauge('warehouse_stock_drift_units', 'Tổng |đơn vị lệch| bền vững giữa warehouse và inventory');
const runs = () => counter('warehouse_reconcile_runs_total', 'Số lần đối soát tồn với inventory', ['result']);
const lastOk = () => gauge('warehouse_reconcile_last_success_timestamp_seconds', 'Lần đối soát thành công gần nhất');

export function compare(wh: { shopId: string; skuId: string; available: number }[], inv: Map<string, InvStock>): Omit<Drift, 'persistent'>[] {
  const out: Omit<Drift, 'persistent'>[] = [];
  for (const w of wh) {
    const s = inv.get(w.skuId);
    if (!s) {
      if (w.available > 0) out.push({ shopId: w.shopId, skuId: w.skuId, kind: 'missing', warehouseAvailable: w.available, inventoryOnHand: null, expected: w.available, delta: -w.available });
      continue;
    }
    const expected = Math.max(w.available, s.reserved);
    const delta = s.onHand - expected;
    if (delta !== 0) out.push({ shopId: w.shopId, skuId: w.skuId, kind: delta > 0 ? 'over' : 'under', warehouseAvailable: w.available, inventoryOnHand: s.onHand, expected, delta });
  }
  return out;
}

export function createReconciler(deps: { pool: Pool; fetchStock: (skuIds: string[]) => Promise<InvStock[]>; batch?: number }) {
  const batch = deps.batch ?? 200;               // inventory /stock nhận tối đa 200 skuIds
  let prev = new Map<string, DriftKind>();
  let last: DriftReport | null = null;

  async function runOnce(): Promise<DriftReport> {
    const at = new Date().toISOString();
    try {
      const { rows } = await deps.pool.query<{ shop_id: string; sku_id: string; available: number }>(
        "SELECT shop_id, sku_id, COALESCE(SUM(qty - reserved) FILTER (WHERE bin <> 'QRT'),0)::int AS available FROM lots GROUP BY shop_id, sku_id ORDER BY sku_id");
      const wh = rows.map((r) => ({ shopId: r.shop_id, skuId: r.sku_id, available: Number(r.available) }));
      const inv = new Map<string, InvStock>();
      for (let i = 0; i < wh.length; i += batch) {
        for (const s of await deps.fetchStock(wh.slice(i, i + batch).map((w) => w.skuId))) inv.set(s.skuId, s);
      }
      const now = compare(wh, inv);
      const drifts: Drift[] = now.map((d) => ({ ...d, persistent: prev.get(d.skuId) === d.kind }));
      prev = new Map(now.map((d) => [d.skuId, d.kind]));
      const persistent = drifts.filter((d) => d.persistent);
      for (const k of ['over', 'under', 'missing'] as DriftKind[]) driftSkus().set({ kind: k }, persistent.filter((d) => d.kind === k).length);
      const units = persistent.reduce((a, d) => a + Math.abs(d.delta), 0);
      driftUnits().set(units);
      runs().inc({ result: 'success' });
      lastOk().set(Date.now() / 1000);
      last = { at, skus: wh.length, drifts, persistent: persistent.length, units, ok: persistent.length === 0 };
    } catch (err) {
      runs().inc({ result: 'error' });
      last = { at, skus: 0, drifts: [], persistent: 0, units: 0, ok: false, error: (err as Error).message.slice(0, 300) };
    }
    return last;
  }

  /** Phát lại warehouse.stock_changed cho SKU lệch bền vững → inventory tự đồng bộ theo đường sự kiện chuẩn. */
  async function resync(actor: string): Promise<{ resent: number }> {
    const targets = (last?.drifts ?? []).filter((d) => d.persistent);
    const c = await deps.pool.connect();
    try {
      await c.query('BEGIN');
      for (const d of targets) await emitStock(c, d.shopId, d.skuId, `reconcile:${actor}`.slice(0, 120));
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    return { resent: targets.length };
  }

  return { runOnce, resync, last: () => last };
}
