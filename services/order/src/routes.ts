import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  parsePage,
  requireUser,
  withTx,
  z,
  type Auth,
  type AuthUser,
  type FastifyInstance,
  type FastifyRequest,
  type Pool,
} from '@shopnow/platform';
import type { OrderStatus } from '@shopnow/contracts';
import type { OrderDeps } from './clients';
import type { SagaConfig } from './config';
import { checkoutSchema, createCheckout } from './checkout';
import { emitOrderEvent, loadOrders, lockCheckout, lockOrder, ordersCancelled, transition, type OrderRow } from './repo';
import type { Log } from './repo';
import { cancelCheckout, requestRefund } from './saga';

const STATUSES: OrderStatus[] = ['PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'SHIPPING', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED'];
/** Đơn được tính doanh thu / GMV (đã chốt, chưa huỷ / trả). */
const REVENUE_STATUSES = ['CONFIRMED', 'SHIPPING', 'DELIVERED', 'COMPLETED', 'RETURN_REQUESTED'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RouteDeps {
  pool: Pool;
  auth: Auth;
  deps: OrderDeps;
  cfg: SagaConfig;
  log?: Log;
}

function statusFilter(v: unknown): OrderStatus[] | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const list = v.split(',').map((s) => s.trim().toUpperCase()) as OrderStatus[];
  for (const s of list) if (!STATUSES.includes(s)) throw badRequest(`Trạng thái "${s}" không hợp lệ`);
  return list;
}

function assertUuid(id: string, what = 'đơn hàng') {
  if (!UUID_RE.test(id)) throw notFound(`Không tìm thấy ${what}`);
}

function shopOf(u: AuthUser) {
  if (!u.shopId) throw forbidden('Tài khoản chưa có shop được duyệt');
  return u.shopId;
}

export function registerRoutes(app: FastifyInstance, rd: RouteDeps) {
  const { pool, auth, cfg } = rd;
  const ctx = { pool, cfg, log: rd.log ?? app.log };
  const authed = { preHandler: auth.authenticate };
  const seller = { preHandler: auth.requireRole('seller') };
  const admin = { preHandler: auth.requireRole('admin') };

  /** Danh sách order có lọc + phân trang (dùng chung buyer / seller / admin). */
  async function listOrders(q: Record<string, unknown>, where: string[], args: unknown[]) {
    const { page, pageSize, offset, limit } = parsePage(q);
    const statuses = statusFilter(q.status);
    if (statuses) {
      args.push(statuses);
      where.push(`status = ANY($${args.length}::text[])`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await pool.query(`SELECT count(*)::int n FROM orders ${whereSql}`, args)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT id FROM orders ${whereSql} ORDER BY created_at DESC, id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    return { items: await loadOrders(pool, rows.map((r) => r.id)), page, pageSize, total };
  }

  async function timeline(orderId: string) {
    const { rows } = await pool.query(
      'SELECT from_status, to_status, note, created_at FROM order_status_history WHERE order_id = $1 ORDER BY id',
      [orderId],
    );
    return rows.map((r) => ({ from: r.from_status, status: r.to_status, note: r.note, at: r.created_at }));
  }

  /** Khoá order (và checkout trước — thứ tự khoá cố định checkout → order để tránh deadlock). */
  async function lockOwned(c: Parameters<typeof lockOrder>[0], id: string, check: (o: OrderRow) => boolean) {
    assertUuid(id);
    const pre = await c.query('SELECT checkout_id FROM orders WHERE id = $1', [id]);
    if (!pre.rows[0]) throw notFound('Không tìm thấy đơn hàng');
    const co = await lockCheckout(c, pre.rows[0].checkout_id);
    const o = await lockOrder(c, id);
    if (!o || !co || !check(o)) throw notFound('Không tìm thấy đơn hàng');
    return { co, o };
  }

  // ---------------- Checkout ----------------
  app.post('/checkout', authed, async (req, reply) => {
    const u = requireUser(req);
    const input = checkoutSchema.parse(req.body);
    const raw = req.headers['idempotency-key'];
    const key = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
    if (key && key.length > 128) throw badRequest('Idempotency-Key quá dài (tối đa 128 ký tự)');
    const { result, replayed } = await createCheckout({ pool, deps: rd.deps, cfg, log: ctx.log }, u.id, input, key);
    if (replayed) reply.header('idempotent-replayed', 'true');
    return reply.status(replayed ? 200 : 201).send(result);
  });

  app.get<{ Params: { id: string } }>('/checkouts/:id', authed, async (req) => {
    const u = requireUser(req);
    assertUuid(req.params.id, 'checkout');
    const { rows } = await pool.query('SELECT * FROM checkouts WHERE id = $1', [req.params.id]);
    const co = rows[0];
    if (!co || (co.buyer_id !== u.id && !u.roles.includes('admin'))) throw notFound('Không tìm thấy checkout');
    const ids = await pool.query('SELECT id FROM orders WHERE checkout_id = $1 ORDER BY created_at, id', [co.id]);
    return {
      id: co.id,
      checkoutId: co.id,
      status: co.status,
      paymentMethod: co.payment_method,
      redirectUrl: co.redirect_url ?? undefined,
      paymentId: co.payment_id ?? undefined,
      paid: Boolean(co.paid_at),
      subtotal: Number(co.subtotal),
      shippingFee: Number(co.shipping_fee),
      discount: Number(co.discount),
      total: Number(co.total),
      cancelReason: co.cancel_reason ?? undefined,
      expiresAt: new Date(new Date(co.created_at).getTime() + cfg.PAYMENT_TIMEOUT_SECONDS * 1000).toISOString(),
      createdAt: co.created_at,
      orders: await loadOrders(pool, ids.rows.map((r) => r.id)),
    };
  });

  // ---------------- Buyer ----------------
  app.get('/orders', authed, async (req) => {
    const u = requireUser(req);
    return listOrders(req.query as Record<string, unknown>, ['buyer_id = $1'], [u.id]);
  });

  app.get<{ Params: { id: string } }>('/orders/:id', authed, async (req) => {
    const u = requireUser(req);
    assertUuid(req.params.id);
    const [o] = await loadOrders(pool, [req.params.id]);
    const allowed = o && (o.buyerId === u.id || u.roles.includes('admin') || (u.shopId && u.shopId === o.shopId));
    if (!allowed) throw notFound('Không tìm thấy đơn hàng');
    return { ...o, timeline: await timeline(o.id) };
  });

  app.post<{ Params: { id: string } }>('/orders/:id/cancel', authed, async (req) => {
    const u = requireUser(req);
    const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    const note = reason ? `Người mua huỷ: ${reason}` : 'Người mua huỷ đơn';
    return withTx(pool, async (c) => {
      const { co, o } = await lockOwned(c, req.params.id, (x) => x.buyer_id === u.id);
      if (o.status === 'PENDING' || o.status === 'AWAITING_PAYMENT') {
        // Chưa chốt: kho & thanh toán gắn với cả checkout → huỷ cả checkout (mọi shop trong lần đặt).
        const ids = await cancelCheckout(c, ctx, co, 'BUYER_CANCELLED', { release: true, note });
        return { ok: true, status: 'CANCELLED', cancelledOrderIds: ids };
      }
      if (o.status !== 'CONFIRMED') throw conflict(`Không thể huỷ đơn ở trạng thái ${o.status}`);
      await transition(c, o, 'CANCELLED', ctx.log, { note, cancelReason: 'BUYER_CANCELLED' });
      await emitOrderEvent(c, 'order.cancelled', o.id);
      ordersCancelled().inc({ reason: 'BUYER_CANCELLED' });
      let refundRequested = false;
      if (o.payment_method !== 'COD' && co.paid_at) refundRequested = await requestRefund(c, o, 'BUYER_CANCELLED');
      // Kho đã commit khi CONFIRMED → không nhả (hợp đồng chưa có lệnh hoàn kho sau commit).
      return { ok: true, status: 'CANCELLED', cancelledOrderIds: [o.id], refundRequested };
    });
  });

  app.post<{ Params: { id: string } }>('/orders/:id/confirm-received', authed, async (req) => {
    const u = requireUser(req);
    return withTx(pool, async (c) => {
      const { o } = await lockOwned(c, req.params.id, (x) => x.buyer_id === u.id);
      if (o.status !== 'DELIVERED') throw conflict(`Chỉ xác nhận đã nhận khi đơn ở trạng thái DELIVERED (hiện tại ${o.status})`);
      await transition(c, o, 'COMPLETED', ctx.log, { note: 'Người mua xác nhận đã nhận hàng' });
      await emitOrderEvent(c, 'order.completed', o.id);
      return { ok: true, status: 'COMPLETED' };
    });
  });

  app.post<{ Params: { id: string } }>('/orders/:id/return', authed, async (req) => {
    const u = requireUser(req);
    const { reason } = z.object({ reason: z.string().trim().min(5, 'Vui lòng nêu lý do trả hàng (ít nhất 5 ký tự)').max(1000) }).parse(req.body ?? {});
    return withTx(pool, async (c) => {
      const { o } = await lockOwned(c, req.params.id, (x) => x.buyer_id === u.id);
      if (o.status !== 'DELIVERED') throw conflict(`Chỉ yêu cầu trả hàng khi đơn đã giao (hiện tại ${o.status})`);
      const deadline = new Date(o.delivered_at ?? 0).getTime() + cfg.RETURN_WINDOW_DAYS * 86_400_000;
      if (Date.now() > deadline) throw conflict(`Đã quá ${cfg.RETURN_WINDOW_DAYS} ngày kể từ khi nhận hàng, không thể yêu cầu trả hàng`);
      await transition(c, o, 'RETURN_REQUESTED', ctx.log, { note: `Yêu cầu trả hàng: ${reason}`, returnReason: reason });
      await emitOrderEvent(c, 'order.return_requested', o.id);
      return { ok: true, status: 'RETURN_REQUESTED' };
    });
  });

  // ---------------- Trả hàng: duyệt / từ chối (seller của shop hoặc admin) ----------------
  async function decideReturn(req: FastifyRequest<{ Params: { id: string } }>, approve: boolean, check: (o: OrderRow) => boolean) {
    const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return withTx(pool, async (c) => {
      const { o } = await lockOwned(c, req.params.id, check);
      if (o.status !== 'RETURN_REQUESTED') throw conflict(`Đơn không có yêu cầu trả hàng (trạng thái ${o.status})`);
      if (approve) {
        await transition(c, o, 'RETURNED', ctx.log, { note: note ? `Đồng ý trả hàng: ${note}` : 'Đồng ý trả hàng' });
        await emitOrderEvent(c, 'order.returned', o.id);
        await requestRefund(c, o, 'RETURNED');
        return { ok: true, status: 'RETURNED' };
      }
      await transition(c, o, 'DELIVERED', ctx.log, { note: note ? `Từ chối trả hàng: ${note}` : 'Từ chối trả hàng' });
      return { ok: true, status: 'DELIVERED' };
    });
  }

  for (const action of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/seller/orders/:id/return/${action}`, seller, async (req) => {
      const shopId = shopOf(requireUser(req));
      return decideReturn(req, action === 'approve', (o) => o.shop_id === shopId);
    });
    app.post<{ Params: { id: string } }>(`/admin/orders/:id/return/${action}`, admin, async (req) => decideReturn(req, action === 'approve', () => true));
  }

  // ---------------- Seller ----------------
  app.get('/seller/orders', seller, async (req) => {
    const shopId = shopOf(requireUser(req));
    return listOrders(req.query as Record<string, unknown>, ['shop_id = $1'], [shopId]);
  });

  app.get('/seller/stats', seller, async (req) => {
    const shopId = shopOf(requireUser(req));
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query ?? {});
    const since = new Date(Date.now() - days * 86_400_000);
    const tz = 'Asia/Ho_Chi_Minh';
    const daily = await pool.query(
      `SELECT to_char((created_at AT TIME ZONE '${tz}')::date, 'YYYY-MM-DD') d,
              sum(subtotal - discount)::bigint revenue, count(*)::int orders
         FROM orders WHERE shop_id = $1 AND created_at >= $2 AND status = ANY($3::text[])
        GROUP BY 1 ORDER BY 1`,
      [shopId, since, REVENUE_STATUSES],
    );
    const byStatus = await pool.query('SELECT status, count(*)::int n FROM orders WHERE shop_id = $1 AND created_at >= $2 GROUP BY status', [shopId, since]);
    const top = await pool.query(
      `SELECT i.product_id, min(i.title) title, min(i.image) image, sum(i.qty)::int qty, sum(i.line_total)::bigint revenue
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.shop_id = $1 AND o.created_at >= $2 AND o.status = ANY($3::text[])
        GROUP BY i.product_id ORDER BY qty DESC, revenue DESC LIMIT 5`,
      [shopId, since, REVENUE_STATUSES],
    );
    const map = new Map(daily.rows.map((r) => [r.d, r]));
    const revenueByDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toLocaleDateString('en-CA', { timeZone: tz });
      revenueByDay.push({ date: d, revenue: Number(map.get(d)?.revenue ?? 0), orders: map.get(d)?.orders ?? 0 });
    }
    const ordersByStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
    for (const r of byStatus.rows) ordersByStatus[r.status as OrderStatus] = r.n;
    return {
      days,
      totalRevenue: revenueByDay.reduce((s, d) => s + d.revenue, 0),
      totalOrders: byStatus.rows.reduce((s, r) => s + r.n, 0),
      revenueByDay,
      ordersByStatus,
      topProducts: top.rows.map((r) => ({ productId: r.product_id, title: r.title, image: r.image, qty: r.qty, revenue: Number(r.revenue) })),
    };
  });

  // ---------------- Admin ----------------
  app.get('/admin/orders', admin, async (req) => {
    const q = req.query as Record<string, unknown>;
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [param, col] of [['shopId', 'shop_id'], ['buyerId', 'buyer_id'], ['checkoutId', 'checkout_id']] as const) {
      if (typeof q[param] === 'string' && q[param]) {
        if (param === 'checkoutId') assertUuid(q[param] as string, 'checkout');
        args.push(q[param]);
        where.push(`${col} = $${args.length}`);
      }
    }
    return listOrders(q, where, args);
  });

  app.get('/admin/stats', admin, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(3650).optional() }).parse(req.query ?? {});
    const args: unknown[] = [];
    let where = '';
    if (days) {
      args.push(new Date(Date.now() - days * 86_400_000));
      where = 'WHERE created_at >= $1';
    }
    const { rows } = await pool.query(`SELECT status, count(*)::int n, sum(total)::bigint total FROM orders ${where} GROUP BY status`, args);
    const ordersByStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
    let gmv = 0;
    let totalOrders = 0;
    for (const r of rows) {
      ordersByStatus[r.status as OrderStatus] = r.n;
      totalOrders += r.n;
      if (REVENUE_STATUSES.includes(r.status)) gmv += Number(r.total);
    }
    const cancelled = ordersByStatus.CANCELLED;
    return {
      days: days ?? null,
      gmv,
      totalOrders,
      cancelledOrders: cancelled,
      cancelRate: totalOrders ? Math.round((cancelled / totalOrders) * 10_000) / 10_000 : 0,
      ordersByStatus,
    };
  });
}
