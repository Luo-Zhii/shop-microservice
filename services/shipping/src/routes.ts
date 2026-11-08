import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  forbidden,
  notFound,
  parsePage,
  requireUser,
  unauthorized,
  withTx,
  z,
  type Auth,
  type FastifyInstance,
  type FastifyRequest,
  type Pool,
} from '@shopnow/platform';
import { quote } from './pricing';
import { getShipment, loadView, nextStatus, transition, type ShipmentRow, type Status } from './repo';

export interface RouteDeps {
  pool: Pool;
  auth: Auth;
  webhookSecret: string;
  devSimulator: boolean;
}

const quoteInput = z.object({
  fromProvince: z.string().min(1).max(100),
  toProvince: z.string().min(1).max(100),
  weightGrams: z.number().int().min(1).max(100_000).default(500),
});
const webhookInput = z.object({
  trackingCode: z.string().min(1).max(64),
  status: z.enum(['PICKED', 'IN_TRANSIT', 'DELIVERED', 'FAILED']),
  note: z.string().max(500).optional(),
});

export function signWebhook(secret: string, rawBody: string) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifySignature(secret: string, rawBody: string, header: string | undefined) {
  if (!header) return false;
  const given = Buffer.from(header.replace(/^sha256=/, '').trim(), 'hex');
  const expected = Buffer.from(signWebhook(secret, rawBody), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { pool, auth } = deps;
  const seller = { preHandler: auth.requireRole('seller') };

  app.post('/quote', async (req) => {
    const b = quoteInput.parse(req.body);
    return quote(b.fromProvince, b.toProvince, b.weightGrams);
  });

  app.get<{ Params: { orderId: string } }>('/shipments/by-order/:orderId', { preHandler: auth.authenticate }, async (req) => {
    const user = requireUser(req);
    const { rows } = await pool.query<ShipmentRow>('SELECT * FROM shipments WHERE order_id = $1', [req.params.orderId]);
    const s = rows[0];
    if (!s) throw notFound('Đơn hàng chưa có vận đơn');
    const allowed = user.roles.includes('admin') || s.buyer_id === user.id || (user.roles.includes('seller') && user.shopId === s.shop_id);
    if (!allowed) throw notFound('Đơn hàng chưa có vận đơn'); // không lộ sự tồn tại của đơn người khác
    return loadView(pool, s);
  });

  app.get('/seller/shipments', seller, async (req) => {
    const user = requireUser(req);
    if (!user.shopId) throw forbidden('Tài khoản chưa có shop');
    const q = req.query as { status?: string };
    const { page, pageSize, limit, offset } = parsePage(req.query as Record<string, unknown>);
    const params: unknown[] = [user.shopId];
    let where = 'shop_id = $1';
    if (q.status) {
      params.push(q.status);
      where += ` AND status = $${params.length}`;
    }
    const total = (await pool.query(`SELECT count(*)::int n FROM shipments WHERE ${where}`, params)).rows[0].n;
    const { rows } = await pool.query<ShipmentRow>(`SELECT * FROM shipments WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
    return { items: await Promise.all(rows.map((r) => loadView(pool, r))), page, pageSize, total };
  });

  app.post<{ Params: { id: string } }>('/seller/shipments/:id/pick', seller, async (req) => {
    const user = requireUser(req);
    const s = await getShipment(pool, req.params.id);
    if (!s || s.shop_id !== user.shopId) throw notFound('Không tìm thấy vận đơn');
    const r = await withTx(pool, (c) => transition(c, s.id, 'PICKED', 'seller', 'Người bán đã bàn giao hàng cho đơn vị vận chuyển'));
    return loadView(pool, r.shipment);
  });

  // Webhook hãng vận chuyển: cần body thô để kiểm chữ ký HMAC → parser riêng trong scope này.
  app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch {
        done(Object.assign(new Error('JSON không hợp lệ'), { statusCode: 400 }), undefined);
      }
    });
    scope.post('/webhooks/carrier', async (req) => {
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      const sig = req.headers['x-carrier-signature'];
      if (!verifySignature(deps.webhookSecret, raw, Array.isArray(sig) ? sig[0] : sig)) throw unauthorized('Chữ ký webhook không hợp lệ');
      const b = webhookInput.parse(req.body);
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM shipments WHERE tracking_code = $1', [b.trackingCode]);
      if (!rows[0]) throw notFound('Không tìm thấy mã vận đơn');
      const r = await withTx(pool, (c) => transition(c, rows[0].id, b.status, 'carrier', b.note));
      return { ok: true, changed: r.changed, status: r.shipment.status };
    });
  });

  if (deps.devSimulator) {
    app.post<{ Params: { id: string } }>('/dev/shipments/:id/advance', async (req) => {
      const s = await getShipment(pool, req.params.id);
      if (!s) throw notFound('Không tìm thấy vận đơn');
      const next = nextStatus(s.status);
      if (!next) return loadView(pool, s);
      const r = await withTx(pool, (c) => transition(c, s.id, next, 'simulator'));
      return loadView(pool, r.shipment);
    });
  }
}

/** Job giả lập (DEV): tự tiến PICKED → IN_TRANSIT → DELIVERED sau mỗi `seconds` giây. Chạy nhiều replica an toàn (SKIP LOCKED). */
export function startAutoAdvance(pool: Pool, seconds: number, log: { warn: (o: object, m: string) => void }) {
  if (seconds <= 0) return () => undefined;
  const tick = async () => {
    try {
      await advanceDue(pool, seconds);
    } catch (err) {
      log.warn({ err }, 'auto-advance lỗi');
    }
  };
  const timer = setInterval(tick, Math.max(1, Math.min(seconds, 5)) * 1000);
  return () => clearInterval(timer);
}

export async function advanceDue(pool: Pool, seconds: number) {
  return withTx(pool, async (c) => {
    const { rows } = await c.query<{ id: string; status: Status }>(
      `SELECT id, status FROM shipments WHERE status IN ('PICKED','IN_TRANSIT') AND updated_at <= now() - make_interval(secs => $1)
       ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [seconds],
    );
    for (const r of rows) await transition(c, r.id, nextStatus(r.status)!, 'simulator');
    return rows.length;
  });
}
