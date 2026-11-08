import {
  badRequest,
  conflict,
  forbidden,
  newId,
  notFound,
  parsePage,
  requireUser,
  withTx,
  z,
  type Auth,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type Pool,
} from '@shopnow/platform';
import type { PaymentConfig } from './config';
import { messagePage, mockPayPage } from './pages';
import { finalize, lockPayment, moveWallet, recordCallback, type Log } from './payments';
import { isSuccess, verify } from './vnpay';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RouteDeps {
  pool: Pool;
  auth: Auth;
  cfg: PaymentConfig;
  log?: Log;
}

const html = (reply: FastifyReply, status: number, body: string) => reply.status(status).type('text/html; charset=utf-8').send(body);

function paymentOut(p: Record<string, any>) {
  return {
    id: p.id,
    checkoutId: p.checkout_id,
    method: p.method,
    status: p.status,
    amount: Number(p.amount),
    refundedAmount: Number(p.refunded_amount),
    redirectUrl: p.redirect_url ?? undefined,
    failureReason: p.failure_reason ?? undefined,
    paidAt: p.paid_at ?? undefined,
    createdAt: p.created_at,
  };
}

export function registerRoutes(app: FastifyInstance, rd: RouteDeps) {
  const { pool, auth, cfg } = rd;
  const log = rd.log ?? app.log;
  const seller = { preHandler: auth.requireRole('seller') };
  const admin = { preHandler: auth.requireRole('admin') };

  // Form HTML của trang mock gửi application/x-www-form-urlencoded
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
  }

  // ---------------- Người mua ----------------
  app.get<{ Params: { checkoutId: string } }>('/payments/:checkoutId', { preHandler: auth.authenticate }, async (req) => {
    const u = requireUser(req);
    if (!UUID_RE.test(req.params.checkoutId)) throw notFound('Không tìm thấy giao dịch');
    const { rows } = await pool.query('SELECT * FROM payments WHERE checkout_id = $1', [req.params.checkoutId]);
    const p = rows[0];
    if (!p || (p.buyer_id !== u.id && !u.roles.includes('admin'))) throw notFound('Không tìm thấy giao dịch');
    const refunds = await pool.query('SELECT order_id, amount, reason, created_at FROM refunds WHERE checkout_id = $1 ORDER BY created_at', [p.checkout_id]);
    return {
      ...paymentOut(p),
      refunds: refunds.rows.map((r) => ({ orderId: r.order_id, amount: Number(r.amount), reason: r.reason, createdAt: r.created_at })),
    };
  });

  // ---------------- Cổng giả lập ----------------
  app.get<{ Params: { paymentId: string } }>('/pay/mock/:paymentId', async (req, reply) => {
    const { rows } = UUID_RE.test(req.params.paymentId) ? await pool.query(`SELECT * FROM payments WHERE id = $1 AND method = 'MOCK'`, [req.params.paymentId]) : { rows: [] };
    if (!rows[0]) return html(reply, 404, messagePage('Không tìm thấy giao dịch', 'Liên kết thanh toán không đúng hoặc đã hết hạn.'));
    reply.header('cache-control', 'no-store');
    return html(reply, 200, mockPayPage(rows[0]));
  });

  app.post<{ Params: { paymentId: string } }>('/pay/mock/:paymentId/complete', async (req, reply) => {
    const { result } = z.object({ result: z.enum(['success', 'fail']) }).parse(req.body ?? {});
    if (!UUID_RE.test(req.params.paymentId)) throw notFound('Không tìm thấy giao dịch');
    const p = await withTx(pool, async (c) => {
      const p = await lockPayment(c, 'id', req.params.paymentId);
      if (!p || p.method !== 'MOCK') throw notFound('Không tìm thấy giao dịch');
      const changed = await finalize(c, p, result === 'success', result === 'success' ? 'OK' : 'Người dùng chọn thất bại trên cổng giả lập');
      await recordCallback(c, 'mock', p.id, { paymentId: p.id, result, at: changed ? 'applied' : 'ignored' }, true, p.status);
      return p;
    });
    const isJson = String(req.headers['content-type'] ?? '').includes('application/json');
    if (isJson || !p.return_url) return { paymentId: p.id, status: p.status, returnUrl: p.return_url };
    return reply.redirect(p.return_url, 303);
  });

  // ---------------- VNPay ----------------
  type VnpResult = { rsp: { RspCode: string; Message: string }; payment?: { return_url: string | null; status: string } };

  /** Xử lý callback VNPay (return hoặc IPN) — idempotent, verify chữ ký trước mọi thứ. */
  async function processVnpay(source: 'vnpay_return' | 'vnpay_ipn', q: Record<string, string>): Promise<VnpResult> {
    const ok = verify(q, cfg.VNPAY_HASH_SECRET);
    return withTx(pool, async (c) => {
      if (!ok) {
        await recordCallback(c, source, null, q, false, '97');
        return { rsp: { RspCode: '97', Message: 'Invalid Checksum' } };
      }
      const p = q.vnp_TxnRef ? await lockPayment(c, 'txn_ref', q.vnp_TxnRef) : undefined;
      if (!p || p.method !== 'VNPAY') {
        await recordCallback(c, source, null, q, true, '01');
        return { rsp: { RspCode: '01', Message: 'Order not found' } };
      }
      if (Number(q.vnp_Amount) !== Number(p.amount) * 100) {
        await recordCallback(c, source, p.id, q, true, '04');
        return { rsp: { RspCode: '04', Message: 'Invalid amount' }, payment: p };
      }
      if (p.status !== 'PENDING') {
        await recordCallback(c, source, p.id, q, true, '02');
        return { rsp: { RspCode: '02', Message: 'Order already confirmed' }, payment: p };
      }
      const success = isSuccess(q);
      await finalize(c, p, success, success ? 'OK' : `VNPay mã ${q.vnp_ResponseCode ?? '?'}`, q.vnp_TransactionNo);
      await recordCallback(c, source, p.id, q, true, '00');
      return { rsp: { RspCode: '00', Message: 'Confirm Success' }, payment: p };
    });
  }

  const vnpQuery = (req: FastifyRequest) => {
    const q = req.query as Record<string, unknown>;
    return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v ?? '')]));
  };

  app.get('/pay/vnpay/ipn', async (req) => {
    try {
      return (await processVnpay('vnpay_ipn', vnpQuery(req))).rsp;
    } catch (err) {
      log.warn({ err }, 'VNPay IPN lỗi');
      return { RspCode: '99', Message: 'Unknown error' };
    }
  });

  app.get('/pay/vnpay/return', async (req, reply) => {
    const r = await processVnpay('vnpay_return', vnpQuery(req));
    if (r.rsp.RspCode === '97') return html(reply, 400, messagePage('Chữ ký không hợp lệ', 'Kết quả thanh toán không xác thực được, vui lòng kiểm tra lại đơn hàng.'));
    if (!r.payment) return html(reply, 404, messagePage('Không tìm thấy giao dịch', 'Giao dịch VNPay không khớp với đơn hàng nào.'));
    if (r.payment.return_url) return reply.redirect(r.payment.return_url, 303);
    return html(reply, 200, messagePage('Đã nhận kết quả thanh toán', r.payment.status === 'SUCCEEDED' ? 'Thanh toán thành công.' : 'Thanh toán không thành công.'));
  });

  // ---------------- Ví seller ----------------
  function shopOf(req: FastifyRequest) {
    const u = requireUser(req);
    if (!u.shopId) throw forbidden('Tài khoản chưa có shop được duyệt');
    return u.shopId;
  }

  app.get('/seller/wallet', seller, async (req) => {
    const shopId = shopOf(req);
    const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>);
    const w = (await pool.query('SELECT * FROM wallets WHERE shop_id = $1', [shopId])).rows[0];
    const total = (await pool.query('SELECT count(*)::int n FROM wallet_ledger WHERE shop_id = $1', [shopId])).rows[0].n;
    const { rows } = await pool.query('SELECT * FROM wallet_ledger WHERE shop_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3', [shopId, limit, offset]);
    const payouts = await pool.query('SELECT * FROM payouts WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 20', [shopId]);
    return {
      shopId,
      available: Number(w?.available ?? 0),
      pending: Number(w?.pending ?? 0),
      totalEarned: Number(w?.total_earned ?? 0),
      totalPaidOut: Number(w?.total_paid_out ?? 0),
      history: {
        items: rows.map((r) => ({
          id: r.id, type: r.type, amount: Number(r.amount), availableAfter: Number(r.available_after), pendingAfter: Number(r.pending_after),
          refId: r.ref_id, note: r.note, createdAt: r.created_at,
        })),
        page, pageSize, total,
      },
      payouts: payouts.rows.map(payoutOut),
    };
  });

  app.post('/seller/payouts', seller, async (req, reply) => {
    const shopId = shopOf(req);
    const u = requireUser(req);
    const { amount, note } = z.object({ amount: z.number().int().positive(), note: z.string().trim().max(500).optional() }).parse(req.body);
    if (amount < cfg.MIN_PAYOUT) throw badRequest(`Số tiền rút tối thiểu là ${cfg.MIN_PAYOUT.toLocaleString('vi-VN')}đ`);
    const payout = await withTx(pool, async (c) => {
      const w = (await c.query('SELECT available FROM wallets WHERE shop_id = $1 FOR UPDATE', [shopId])).rows[0];
      const available = Number(w?.available ?? 0);
      if (amount > available) throw badRequest(`Số dư khả dụng không đủ (hiện có ${available.toLocaleString('vi-VN')}đ)`);
      const id = newId();
      const { rows } = await c.query(
        `INSERT INTO payouts (id, shop_id, amount, status, requested_by, note) VALUES ($1,$2,$3,'REQUESTED',$4,$5) RETURNING *`,
        [id, shopId, amount, u.id, note ?? null],
      );
      await moveWallet(c, shopId, -amount, amount, 'PAYOUT_HOLD', id, 'Yêu cầu rút tiền');
      return rows[0];
    });
    return reply.status(201).send(payoutOut(payout));
  });

  // ---------------- Admin chi trả ----------------
  app.get('/admin/payouts', admin, async (req) => {
    const q = req.query as Record<string, unknown>;
    const { page, pageSize, offset, limit } = parsePage(q);
    const status = typeof q.status === 'string' && q.status ? q.status.toUpperCase() : undefined;
    if (status && !['REQUESTED', 'PAID'].includes(status)) throw badRequest('Trạng thái không hợp lệ');
    const where = status ? 'WHERE status = $1' : '';
    const args = status ? [status] : [];
    const total = (await pool.query(`SELECT count(*)::int n FROM payouts ${where}`, args)).rows[0].n;
    const { rows } = await pool.query(`SELECT * FROM payouts ${where} ORDER BY created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, limit, offset]);
    return { items: rows.map(payoutOut), page, pageSize, total };
  });

  app.post<{ Params: { id: string } }>('/admin/payouts/:id/paid', admin, async (req) => {
    const u = requireUser(req);
    if (!UUID_RE.test(req.params.id)) throw notFound('Không tìm thấy yêu cầu rút tiền');
    const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return withTx(pool, async (c) => {
      const p = (await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!p) throw notFound('Không tìm thấy yêu cầu rút tiền');
      if (p.status !== 'REQUESTED') throw conflict('Yêu cầu rút tiền đã được chi trả');
      const { rows } = await c.query(`UPDATE payouts SET status = 'PAID', paid_by = $2, paid_at = now(), note = COALESCE($3, note) WHERE id = $1 RETURNING *`, [
        p.id, u.id, note ?? null,
      ]);
      await moveWallet(c, p.shop_id, 0, -Number(p.amount), 'PAYOUT_PAID', p.id, 'Đã chi trả', { paidOut: Number(p.amount) });
      return payoutOut(rows[0]);
    });
  });
}

function payoutOut(r: Record<string, any>) {
  return { id: r.id, shopId: r.shop_id, amount: Number(r.amount), status: r.status, note: r.note, createdAt: r.created_at, paidAt: r.paid_at ?? undefined };
}
