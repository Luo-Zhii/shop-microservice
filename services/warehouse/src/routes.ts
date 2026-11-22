import { notFound, requireUser, withTx, z, type Auth, type FastifyInstance, type Pool } from '@shopnow/platform';
import type { createReconciler } from './reconcile';
import { slaOf } from './sla';
import { cycleCountPlan, replenishment } from './replenishment';
import {
  allocatePick, approveCount, chargeStorage, confirmPick, countSheet, createReceipt, receive, startCount, stockLedgerReport, submitCount,
} from './stock';

export interface RouteDeps {
  pool: Pool;
  auth: Auth;
  countThreshold: number;
  storageRate: number;
  /** giờ cắt đơn cho SLA xuất kho (mặc định 14h) */
  cutoffHour?: number;
  /** đối soát tồn với inventory (reconcile.ts) — tuỳ chọn để test cũ không đổi */
  reconciler?: ReturnType<typeof createReconciler>;
}

const id = z.string().min(1).max(64);
const qty = z.number().int().min(0).max(1_000_000);

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { pool, auth } = deps;
  const staff = { preHandler: auth.requireRole('admin', 'warehouse') };
  const seller = { preHandler: auth.requireRole('seller') };
  const actor = (req: Parameters<typeof requireUser>[0]) => requireUser(req).email || requireUser(req).id;

  app.get('/warehouses', staff, async () => ({ items: (await pool.query('SELECT * FROM warehouses ORDER BY code')).rows }));

  // ---- đối soát tồn với inventory (data consistency SLO) ----
  const admin = { preHandler: auth.requireRole('admin') };
  app.get('/reports/stock-drift', staff, async (req) => {
    if (!deps.reconciler) return { enabled: false };
    const fresh = (req.query as { refresh?: string }).refresh === 'true';
    return { enabled: true, ...((fresh ? await deps.reconciler.runOnce() : deps.reconciler.last()) ?? await deps.reconciler.runOnce()) };
  });
  app.post('/reports/stock-drift/resync', admin, async (req) => {
    if (!deps.reconciler) return { resent: 0 };
    return deps.reconciler.resync(actor(req));
  });

  // ---- seller: báo trước lô hàng gửi kho (ASN) + xem tồn của mình ----
  app.post('/seller/receipts', seller, async (req, reply) => {
    const u = requireUser(req);
    const b = z.object({ warehouse: z.string().min(2).max(10), lines: z.array(z.object({ skuId: id, qty: qty.min(1), unitCost: z.number().int().min(0) })).min(1).max(200) }).parse(req.body);
    reply.code(201);
    return withTx(pool, (c) => createReceipt(c, { ...b, shopId: u.shopId! }, actor(req)));
  });
  app.get('/seller/stock', seller, async (req) => {
    const u = requireUser(req);
    const { rows } = await pool.query(
      `SELECT sku_id, warehouse, SUM(qty)::int AS on_hand, (SUM(qty - reserved) FILTER (WHERE bin <> 'QRT'))::int AS available,
              SUM(qty) FILTER (WHERE bin = 'QRT')::int AS quarantined FROM lots WHERE shop_id = $1 GROUP BY sku_id, warehouse ORDER BY sku_id`, [u.shopId]);
    return { items: rows };
  });

  // ---- nhân viên kho ----
  app.get('/receipts', staff, async (req) => {
    const st = (req.query as { status?: string }).status;
    const { rows } = await pool.query(
      `SELECT r.*, (SELECT json_agg(l) FROM receipt_lines l WHERE l.receipt_id = r.id) AS lines FROM receipts r
        WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 100`, [st ?? null]);
    return { items: rows };
  });
  app.post<{ Params: { id: string } }>('/receipts/:id/receive', staff, async (req) => {
    const b = z.object({ lines: z.array(z.object({ skuId: id, received: qty, damaged: qty.optional(), bin: z.string().min(1).max(20) })).min(1) }).parse(req.body);
    return withTx(pool, (c) => receive(c, req.params.id, b.lines, actor(req)));
  });

  app.get('/picks', staff, async (req) => {
    const st = (req.query as { status?: string }).status ?? 'OPEN';
    const { rows } = await pool.query(
      `SELECT p.*, (SELECT json_agg(l ORDER BY l.bin) FROM pick_lines l WHERE l.pick_id = p.id) AS lines FROM picks p
        WHERE status = $1 ORDER BY created_at LIMIT 200`, [st]);
    // hạn xuất theo giờ cắt đơn — chỉ phiếu còn phải xử lý mới có đồng hồ SLA
    const now = new Date();
    return { items: rows.map((r) => (['OPEN', 'SHORT'].includes(r.status) ? { ...r, sla: slaOf(new Date(r.created_at), now, deps.cutoffHour ?? 14) } : r)) };
  });
  /** Tạo phiếu lấy hàng thủ công (vd đơn đi từ kênh khác). Đơn ShopNow tự tạo qua sự kiện order.confirmed. */
  app.post('/picks', staff, async (req, reply) => {
    const b = z.object({ orderId: id, shopId: id, items: z.array(z.object({ skuId: id, qty: qty.min(1) })).min(1) }).parse(req.body);
    reply.code(201);
    return withTx(pool, (c) => allocatePick(c, { id: b.orderId, shopId: b.shopId, items: b.items }));
  });
  app.post<{ Params: { id: string } }>('/picks/:id/confirm', staff, async (req) => withTx(pool, (c) => confirmPick(c, req.params.id, actor(req))));

  app.post('/counts', staff, async (req, reply) => {
    const b = z.object({ warehouse: z.string().min(2).max(10), binPrefix: z.string().max(20).default('') }).parse(req.body);
    reply.code(201);
    return withTx(pool, (c) => startCount(c, b.warehouse, b.binPrefix, actor(req)));
  });
  app.get<{ Params: { id: string } }>('/counts/:id/sheet', staff, async (req) => {
    const items = await withTx(pool, (c) => countSheet(c, req.params.id));
    if (!items.length) throw notFound('không có phiếu kiểm kê');
    return { items };
  });
  app.post<{ Params: { id: string } }>('/counts/:id/submit', staff, async (req) => {
    const b = z.object({ lines: z.array(z.object({ lotId: id, qty })).min(1) }).parse(req.body);
    return withTx(pool, (c) => submitCount(c, req.params.id, b.lines, actor(req), deps.countThreshold));
  });
  app.post<{ Params: { id: string } }>('/counts/:id/approve', staff, async (req) =>
    withTx(pool, (c) => approveCount(c, req.params.id, actor(req), deps.countThreshold, true)));
  app.post<{ Params: { id: string } }>('/counts/:id/reject', staff, async (req) =>
    withTx(pool, (c) => approveCount(c, req.params.id, actor(req), deps.countThreshold, false)));
  app.get('/counts', staff, async () => ({ items: (await pool.query('SELECT * FROM counts ORDER BY created_at DESC LIMIT 100')).rows }));

  // ---- báo cáo ----
  app.get('/reports/stock-ledger', staff, async (req) => {
    const q = z.object({ from: z.string().date(), to: z.string().date(), shopId: id.optional() }).parse(req.query);
    return { from: q.from, to: q.to, items: await stockLedgerReport(pool, q.from, q.to, q.shopId) };
  });
  app.get<{ Params: { skuId: string } }>('/reports/stock-card/:skuId', staff, async (req) => {
    const { rows } = await pool.query('SELECT at, type, warehouse, bin, qty, unit_cost, ref_type, ref_id, actor FROM stock_moves WHERE sku_id = $1 ORDER BY id', [req.params.skuId]);
    let bal = 0;
    return { skuId: req.params.skuId, items: rows.map((r) => ({ ...r, balance: (bal += ['RECEIPT', 'ADJUST_IN', 'TRANSFER_IN'].includes(r.type) ? r.qty : -r.qty) })) };
  });
  app.get('/reports/replenishment', staff, async (req) => {
    const q = z.object({ shopId: id.optional(), leadTimeDays: z.coerce.number().int().min(1).max(90).optional(),
      reviewDays: z.coerce.number().int().min(1).max(60).optional(), days: z.coerce.number().int().min(7).max(180).optional() }).parse(req.query);
    return replenishment(pool, q);
  });
  app.get('/reports/cycle-count-plan', staff, async (req) => {
    const q = z.object({ warehouse: z.string().min(2).max(10).optional() }).parse(req.query);
    return cycleCountPlan(pool, q);
  });
  app.get('/seller/replenishment', seller, async (req) => replenishment(pool, { shopId: requireUser(req).shopId }));
  app.post<{ Params: { period: string } }>('/storage-fees/:period/charge', staff, async (req) => {
    const p = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.period);
    return { period: p, charged: await withTx(pool, (c) => chargeStorage(c, p, deps.storageRate)) };
  });
}
