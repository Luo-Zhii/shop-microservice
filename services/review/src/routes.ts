import { MongoServerError, type Filter } from 'mongodb';
import { conflict, forbidden, newId, notFound, parsePage, requireUser, z, type Auth, type FastifyInstance, type Logger } from '@shopnow/platform';
import { moderate, type Moderator } from './moderation';
import { pendingEvents, ratingSummary, stageOutbox, type Collections, type ReviewDoc } from './store';

export interface RouteDeps {
  col: Collections;
  auth: Auth;
  moderator: Moderator;
  log: Logger;
}

const createInput = z.object({
  orderId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  rating: z.number().int().min(1, 'Số sao từ 1 đến 5').max(5, 'Số sao từ 1 đến 5'),
  content: z.string().max(2000, 'Nội dung tối đa 2000 ký tự').default(''),
  images: z.array(z.string().url('Ảnh phải là URL hợp lệ')).max(6, 'Tối đa 6 ảnh').default([]),
});
const replyInput = z.object({ content: z.string().trim().min(1, 'Nội dung trả lời không được trống').max(1000) });
const hideInput = z.object({ reason: z.string().max(500).optional() }).default({});

/** "nguyenvana@gmail.com" → "n********a" (không lộ email người mua). */
export function maskName(email: string) {
  const local = email.split('@')[0] || 'khach';
  return local.length <= 2 ? `${local[0]}*` : `${local[0]}${'*'.repeat(Math.min(8, local.length - 2))}${local[local.length - 1]}`;
}

export function toView(r: ReviewDoc) {
  return {
    id: r._id,
    orderId: r.orderId,
    productId: r.productId,
    shopId: r.shopId,
    userId: r.userId,
    authorName: r.authorName,
    rating: r.rating,
    content: r.content,
    images: r.images,
    status: r.status,
    reply: r.reply ? { content: r.reply.content, at: r.reply.at.toISOString() } : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { col, auth, log } = deps;
  const seller = { preHandler: auth.requireRole('seller') };
  const admin = { preHandler: auth.requireRole('admin') };
  const stage = (id: string) => stageOutbox(col, id).catch((err) => log.warn({ err, reviewId: id }, 'stage outbox lỗi — sweeper sẽ thử lại'));

  app.post('/reviews', { preHandler: auth.authenticate }, async (req, reply) => {
    const user = requireUser(req);
    const b = createInput.parse(req.body);
    const purchase = await col.purchases.findOne({ _id: b.orderId, buyerId: user.id, productIds: b.productId });
    if (!purchase) throw forbidden('Chỉ người đã mua và hoàn tất đơn hàng mới được đánh giá sản phẩm này');
    const m = await moderate(deps.moderator, b.content, log);
    const now = new Date();
    const doc: ReviewDoc = {
      _id: newId(),
      orderId: b.orderId,
      productId: b.productId,
      shopId: purchase.shopId,
      userId: user.id,
      authorName: maskName(user.email),
      rating: b.rating,
      content: b.content,
      images: b.images,
      status: m.allowed ? 'PUBLISHED' : 'HIDDEN',
      moderation: m,
      hiddenReason: m.allowed ? null : 'Nội dung đang chờ kiểm duyệt',
      hiddenBy: m.allowed ? null : 'ai',
      announced: m.allowed,
      reply: null,
      outbox: [],
      createdAt: now,
      updatedAt: now,
    };
    doc.outbox = m.allowed ? pendingEvents(doc, { created: true, ratingChanged: true }) : [];
    try {
      await col.reviews.insertOne(doc);
    } catch (e) {
      if (e instanceof MongoServerError && e.code === 11000) throw conflict('Bạn đã đánh giá sản phẩm này cho đơn hàng này rồi');
      throw e;
    }
    await stage(doc._id);
    reply.status(201);
    return { ...toView(doc), pendingModeration: !m.allowed };
  });

  app.get<{ Params: { productId: string } }>('/products/:productId/reviews', async (req) => {
    const q = req.query as { rating?: string; hasImages?: string };
    const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>, 50);
    const filter: Filter<ReviewDoc> = { productId: req.params.productId, status: 'PUBLISHED' };
    const rating = Number(q.rating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) filter.rating = rating;
    if (q.hasImages === 'true') filter['images.0'] = { $exists: true };
    const [items, total] = await Promise.all([
      col.reviews.find(filter, { projection: { outbox: 0, moderation: 0 } }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
      col.reviews.countDocuments(filter),
    ]);
    return { items: items.map(toView), page, pageSize, total };
  });

  app.get<{ Params: { productId: string } }>('/products/:productId/summary', async (req) => {
    const s = await ratingSummary(col, req.params.productId);
    return { avg: s.avg, count: s.count, distribution: s.distribution };
  });

  app.post<{ Params: { id: string } }>('/seller/reviews/:id/reply', seller, async (req) => {
    const user = requireUser(req);
    const b = replyInput.parse(req.body);
    const r = await col.reviews.findOneAndUpdate(
      { _id: req.params.id, shopId: user.shopId ?? '__none__' },
      { $set: { reply: { content: b.content, by: user.id, at: new Date() }, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!r) throw notFound('Không tìm thấy đánh giá của shop bạn');
    return toView(r);
  });

  app.get('/seller/reviews', seller, async (req) => {
    const user = requireUser(req);
    const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>, 50);
    const filter: Filter<ReviewDoc> = { shopId: user.shopId ?? '__none__', status: 'PUBLISHED' };
    const [items, total] = await Promise.all([
      col.reviews.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray(),
      col.reviews.countDocuments(filter),
    ]);
    return { items: items.map(toView), page, pageSize, total };
  });

  app.get('/admin/reviews', admin, async (req) => {
    const q = req.query as { status?: string };
    const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>, 100);
    const filter: Filter<ReviewDoc> = q.status === 'PUBLISHED' || q.status === 'HIDDEN' ? { status: q.status } : {};
    const [items, total] = await Promise.all([
      col.reviews.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray(),
      col.reviews.countDocuments(filter),
    ]);
    return { items: items.map((r) => ({ ...toView(r), moderation: r.moderation, hiddenReason: r.hiddenReason, hiddenBy: r.hiddenBy })), page, pageSize, total };
  });

  // Ẩn / hiện: cập nhật trạng thái + nhúng sự kiện trong CÙNG một lệnh update (nguyên tử trên document).
  async function setVisibility(id: string, target: 'PUBLISHED' | 'HIDDEN', reason: string | null) {
    const cur = await col.reviews.findOne({ _id: id });
    if (!cur) throw notFound('Không tìm thấy đánh giá');
    if (cur.status === target) return cur;
    const events = pendingEvents(cur, { created: target === 'PUBLISHED' && !cur.announced, ratingChanged: true });
    const r = await col.reviews.findOneAndUpdate(
      { _id: id, status: cur.status },
      {
        $set: {
          status: target,
          hiddenReason: target === 'HIDDEN' ? (reason ?? 'Vi phạm quy định cộng đồng') : null,
          hiddenBy: target === 'HIDDEN' ? 'admin' : null,
          announced: cur.announced || target === 'PUBLISHED',
          updatedAt: new Date(),
        },
        $push: { outbox: { $each: events } },
      },
      { returnDocument: 'after' },
    );
    if (!r) throw conflict('Đánh giá vừa được cập nhật, vui lòng thử lại');
    await stage(id);
    return r;
  }

  app.post<{ Params: { id: string } }>('/admin/reviews/:id/hide', admin, async (req) => {
    const b = hideInput.parse(req.body ?? {});
    return toView(await setVisibility(req.params.id, 'HIDDEN', b.reason ?? null));
  });
  app.post<{ Params: { id: string } }>('/admin/reviews/:id/show', admin, async (req) => toView(await setVisibility(req.params.id, 'PUBLISHED', null)));
}
