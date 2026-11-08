import type { Db } from 'mongodb';
import { createEvent, gauge, type EventBus, type Logger } from '@shopnow/platform';
import { Topics, type EventEnvelope, type ProductRatingChanged } from '@shopnow/contracts';
import type { ModerationResult } from './moderation';

export type ReviewStatus = 'PUBLISHED' | 'HIDDEN';

export interface PendingEvent {
  topic: string;
  event: EventEnvelope<unknown>;
}

export interface ReviewDoc {
  _id: string;
  orderId: string;
  productId: string;
  shopId: string;
  userId: string;
  authorName: string;
  rating: number;
  content: string;
  images: string[];
  status: ReviewStatus;
  moderation: ModerationResult;
  hiddenReason: string | null;
  hiddenBy: 'ai' | 'admin' | null;
  /** đã phát review.created chưa (review bị AI ẩn ngay từ đầu chỉ phát khi admin cho hiện) */
  announced: boolean;
  reply: { content: string; by: string; at: Date } | null;
  /** Outbox nhúng trong chính document: ghi cùng thao tác (Mongo đảm bảo nguyên tử trên một document). */
  outbox: PendingEvent[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseDoc {
  _id: string; // orderId
  buyerId: string;
  shopId: string;
  productIds: string[];
  completedAt: Date;
}

export interface OutboxDoc {
  _id: string; // event id
  topic: string;
  event: EventEnvelope<unknown>;
  createdAt: Date;
  lockedUntil: Date | null;
  lockOwner: string | null;
}

export function collections(db: Db) {
  return {
    reviews: db.collection<ReviewDoc>('reviews'),
    purchases: db.collection<PurchaseDoc>('purchases'),
    outbox: db.collection<OutboxDoc>('outbox'),
    processed: db.collection<{ _id: string; consumer: string; at: Date }>('processed_events'),
  };
}
export type Collections = ReturnType<typeof collections>;

export async function ensureIndexes(c: Collections) {
  await Promise.all([
    c.reviews.createIndex({ orderId: 1, productId: 1 }, { unique: true, name: 'uniq_order_product' }),
    c.reviews.createIndex({ productId: 1, status: 1, createdAt: -1 }),
    c.reviews.createIndex({ shopId: 1, createdAt: -1 }),
    c.reviews.createIndex({ status: 1, createdAt: -1 }),
    c.reviews.createIndex({ 'outbox.0': 1, updatedAt: 1 }, { sparse: true }),
    c.purchases.createIndex({ buyerId: 1 }),
    c.outbox.createIndex({ createdAt: 1 }),
  ]);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function ratingSummary(c: Collections, productId: string) {
  const rows = await c.reviews
    .aggregate<{ _id: number; n: number }>([{ $match: { productId, status: 'PUBLISHED' } }, { $group: { _id: '$rating', n: { $sum: 1 } } }])
    .toArray();
  const distribution: Record<'1' | '2' | '3' | '4' | '5', number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;
  for (const r of rows) {
    distribution[String(r._id) as keyof typeof distribution] = r.n;
    count += r.n;
    sum += r._id * r.n;
  }
  return { productId, avg: count ? round2(sum / count) : 0, count, distribution };
}

/** Dựng sự kiện cần phát cho một thay đổi. rating_changed chỉ mang productId — giá trị tính lúc chuyển sang outbox (luôn là trạng thái mới nhất). */
export function pendingEvents(r: Pick<ReviewDoc, '_id' | 'productId' | 'shopId' | 'userId' | 'rating'>, opts: { created: boolean; ratingChanged: boolean }) {
  const out: PendingEvent[] = [];
  if (opts.created) {
    out.push({
      topic: Topics.review,
      event: createEvent('review.created', 'review', r.productId, { reviewId: r._id, productId: r.productId, shopId: r.shopId, userId: r.userId, rating: r.rating }),
    });
  }
  if (opts.ratingChanged) out.push({ topic: Topics.review, event: createEvent('product.rating_changed', 'review', r.productId, { productId: r.productId }) });
  return out;
}

/**
 * Bước 2 của outbox: chuyển sự kiện nhúng trong review sang collection `outbox` (upsert theo event id → chạy lặp an toàn)
 * rồi $pull khỏi review. Crash giữa chừng → sweeper chạy lại, không mất sự kiện, không sinh id mới.
 */
export async function stageOutbox(c: Collections, reviewId: string) {
  const r = await c.reviews.findOne({ _id: reviewId }, { projection: { outbox: 1, productId: 1 } });
  if (!r?.outbox?.length) return 0;
  for (const p of r.outbox) {
    let event = p.event;
    if (event.type === 'product.rating_changed') {
      const s = await ratingSummary(c, r.productId);
      event = { ...event, data: { productId: r.productId, ratingAvg: s.avg, ratingCount: s.count } satisfies ProductRatingChanged };
    }
    await c.outbox.updateOne(
      { _id: event.id },
      { $setOnInsert: { topic: p.topic, event, createdAt: new Date(), lockedUntil: null, lockOwner: null } },
      { upsert: true },
    );
  }
  const ids = r.outbox.map((p) => p.event.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typing của mongodb không hiểu path lồng trong $pull
  await c.reviews.updateOne({ _id: reviewId }, { $pull: { outbox: { 'event.id': { $in: ids } } as any } });
  return r.outbox.length;
}

/** Sweeper: review còn sự kiện nhúng (do crash sau bước 1) → stage lại. */
export async function sweepPending(c: Collections, olderThanMs = 5_000) {
  const stuck = await c.reviews
    .find({ 'outbox.0': { $exists: true }, updatedAt: { $lt: new Date(Date.now() - olderThanMs) } }, { projection: { _id: 1 } })
    .limit(100)
    .toArray();
  for (const s of stuck) await stageOutbox(c, s._id);
  return stuck.length;
}

/** Relay Mongo → Kafka: khoá lô bằng lockOwner/lockedUntil (nhiều replica an toàn), gửi theo thứ tự, xoá sau khi gửi. */
export async function relayOnce(c: Collections, bus: EventBus, owner: string) {
  const now = new Date();
  const free = { $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] };
  const ids = (await c.outbox.find(free, { projection: { _id: 1 } }).sort({ createdAt: 1, _id: 1 }).limit(200).toArray()).map((d) => d._id);
  if (ids.length === 0) return 0;
  await c.outbox.updateMany({ _id: { $in: ids }, ...free }, { $set: { lockOwner: owner, lockedUntil: new Date(now.getTime() + 30_000) } });
  const docs = await c.outbox.find({ _id: { $in: ids }, lockOwner: owner }).sort({ createdAt: 1, _id: 1 }).toArray();
  const byTopic = new Map<string, EventEnvelope<unknown>[]>();
  for (const d of docs) byTopic.set(d.topic, [...(byTopic.get(d.topic) ?? []), d.event]);
  for (const [topic, evs] of byTopic) await bus.publish(topic, evs);
  await c.outbox.deleteMany({ _id: { $in: docs.map((d) => d._id) }, lockOwner: owner });
  return docs.length;
}

export function startRelay(c: Collections, bus: EventBus, log: Logger, owner: string) {
  if (!bus.enabled) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const pending = gauge('outbox_pending', 'Số sự kiện outbox chưa gửi');
  let lastSweep = 0;
  const tick = async () => {
    if (stopped) return;
    let sent = 0;
    try {
      if (Date.now() - lastSweep > 10_000) {
        lastSweep = Date.now();
        await sweepPending(c);
        pending.set(await c.outbox.estimatedDocumentCount());
      }
      sent = await relayOnce(c, bus, owner);
    } catch (err) {
      log.warn({ err }, 'outbox relay (mongo) lỗi, sẽ thử lại');
    }
    if (!stopped) timer = setTimeout(tick, sent > 0 ? 0 : 300);
  };
  timer = setTimeout(tick, 300);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Inbox Mongo: _id = `${consumer}:${eventId}`. */
export async function alreadyProcessed(c: Collections, consumer: string, eventId: string) {
  return (await c.processed.countDocuments({ _id: `${consumer}:${eventId}` }, { limit: 1 })) > 0;
}
export async function markProcessed(c: Collections, consumer: string, eventId: string) {
  await c.processed.updateOne({ _id: `${consumer}:${eventId}` }, { $setOnInsert: { consumer, at: new Date() } }, { upsert: true });
}
