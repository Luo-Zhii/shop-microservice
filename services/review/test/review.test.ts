import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createAuth, createEvent, createService, newId, type EventBus } from '@shopnow/platform';
import { startTestJwks } from '@shopnow/platform/testing';
import type { EventEnvelope, OrderSnapshot } from '@shopnow/contracts';
import { collections, ensureIndexes, pendingEvents, relayOnce, stageOutbox, sweepPending, type Collections } from '../src/store';
import { registerRoutes } from '../src/routes';
import { handleOrderEvent } from '../src/consumers';
import type { Moderator } from '../src/moderation';

const mongo = new MongoClient(process.env.TEST_MONGO_URL ?? 'mongodb://localhost:57017', { serverSelectionTimeoutMS: 5_000 });
let col: Collections;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const svc = createService('review-test');
const app = svc.app;
let aiMode: 'ok' | 'block' | 'down' = 'ok';
const moderator: Moderator = async (text) => {
  if (aiMode === 'down') throw new Error('timeout');
  return aiMode === 'block' || text.includes('lừa đảo') ? { allowed: false, labels: ['scam'], score: 0.9 } : { allowed: true, labels: [], score: 0.01 };
};

const SHOP = newId();
const PRODUCT = newId();
const PRODUCT2 = newId();

before(async () => {
  jwks = await startTestJwks();
  await mongo.connect();
  const db = mongo.db('review_test');
  await db.dropDatabase();
  col = collections(db);
  await ensureIndexes(col);
  registerRoutes(app, { col, auth: createAuth(jwks.authOptions), moderator, log: svc.log });
  await app.ready();
});
after(async () => {
  await app.close();
  await mongo.close();
  await jwks.close();
});

function completed(buyerId: string, productIds: string[]): EventEnvelope<OrderSnapshot> {
  const id = newId();
  return createEvent('order.completed', 'order', id, {
    id, checkoutId: newId(), buyerId, shopId: SHOP, status: 'COMPLETED',
    items: productIds.map((p) => ({ skuId: newId(), productId: p, title: 'SP', variantLabel: '', unitPrice: 100_000, qty: 1, lineTotal: 100_000 })),
    subtotal: 100_000, shippingFee: 0, discount: 0, total: 100_000, paymentMethod: 'COD',
    shippingAddress: { fullName: 'A', phone: '0900000000', line1: 'x', ward: 'x', district: 'x', province: 'Hà Nội' },
    createdAt: new Date().toISOString(),
  });
}

async function outboxTypes() {
  return (await col.outbox.find().sort({ createdAt: 1, _id: 1 }).toArray()).map((d) => d.event.type);
}

test('chỉ người đã mua mới được đánh giá; mỗi (order, product) một lần; validate', async () => {
  const buyer = newId();
  const tok = { authorization: `Bearer ${await jwks.sign(buyer)}` };
  const ev = completed(buyer, [PRODUCT, PRODUCT2]);

  const before = await app.inject({ method: 'POST', url: '/reviews', headers: tok, payload: { orderId: ev.data.id, productId: PRODUCT, rating: 5 } });
  assert.equal(before.statusCode, 403);

  assert.equal(await handleOrderEvent({ col, log: svc.log }, ev), true);
  assert.equal(await handleOrderEvent({ col, log: svc.log }, ev), false); // inbox chặn bản trùng

  const bad = await app.inject({ method: 'POST', url: '/reviews', headers: tok, payload: { orderId: ev.data.id, productId: PRODUCT, rating: 6 } });
  assert.equal(bad.statusCode, 400);
  const tooMany = await app.inject({
    method: 'POST', url: '/reviews', headers: tok,
    payload: { orderId: ev.data.id, productId: PRODUCT, rating: 5, images: Array.from({ length: 7 }, (_, i) => `https://img.local/${i}.jpg`) },
  });
  assert.equal(tooMany.statusCode, 400);

  const ok = await app.inject({ method: 'POST', url: '/reviews', headers: tok, payload: { orderId: ev.data.id, productId: PRODUCT, rating: 5, content: 'Áo đẹp, giao nhanh', images: ['https://img.local/a.jpg'] } });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().status, 'PUBLISHED');
  assert.equal(ok.json().shopId, SHOP);
  const dup = await app.inject({ method: 'POST', url: '/reviews', headers: tok, payload: { orderId: ev.data.id, productId: PRODUCT, rating: 4 } });
  assert.equal(dup.statusCode, 409);

  // người khác không đánh giá được đơn này
  const stranger = { authorization: `Bearer ${await jwks.sign(newId())}` };
  assert.equal((await app.inject({ method: 'POST', url: '/reviews', headers: stranger, payload: { orderId: ev.data.id, productId: PRODUCT2, rating: 1 } })).statusCode, 403);

  assert.deepEqual(await outboxTypes(), ['review.created', 'product.rating_changed']);
  const rc = await col.outbox.findOne({ 'event.type': 'product.rating_changed' });
  assert.deepEqual(rc!.event.data, { productId: PRODUCT, ratingAvg: 5, ratingCount: 1 });
  const review = await col.reviews.findOne({ _id: ok.json().id });
  assert.equal(review!.outbox.length, 0, 'sự kiện nhúng đã được chuyển sang outbox');
});

test('kiểm duyệt: AI chặn → HIDDEN; AI chết → fail-open PUBLISHED; tổng hợp sao + lọc', async () => {
  await col.outbox.deleteMany({});
  const users = await Promise.all([1, 2, 3].map(async () => {
    const id = newId();
    const ev = completed(id, [PRODUCT]);
    await handleOrderEvent({ col, log: svc.log }, ev);
    return { headers: { authorization: `Bearer ${await jwks.sign(id)}` }, orderId: ev.data.id };
  }));

  const blocked = await app.inject({ method: 'POST', url: '/reviews', headers: users[0].headers, payload: { orderId: users[0].orderId, productId: PRODUCT, rating: 1, content: 'shop lừa đảo' } });
  assert.equal(blocked.statusCode, 201);
  assert.equal(blocked.json().status, 'HIDDEN');
  assert.equal(blocked.json().pendingModeration, true);
  assert.deepEqual(await outboxTypes(), [], 'review bị ẩn chưa phát sự kiện');

  aiMode = 'down';
  const failOpen = await app.inject({ method: 'POST', url: '/reviews', headers: users[1].headers, payload: { orderId: users[1].orderId, productId: PRODUCT, rating: 4, content: 'Tạm ổn' } });
  aiMode = 'ok';
  assert.equal(failOpen.json().status, 'PUBLISHED');
  assert.equal((await col.reviews.findOne({ _id: failOpen.json().id }))!.moderation.source, 'fail_open');
  await app.inject({ method: 'POST', url: '/reviews', headers: users[2].headers, payload: { orderId: users[2].orderId, productId: PRODUCT, rating: 3 } });

  const sum = (await app.inject({ method: 'GET', url: `/products/${PRODUCT}/summary` })).json();
  assert.equal(sum.count, 3);
  assert.equal(sum.avg, 4);
  assert.deepEqual(sum.distribution, { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 });

  const list = (await app.inject({ method: 'GET', url: `/products/${PRODUCT}/reviews?pageSize=2` })).json();
  assert.equal(list.total, 3);
  assert.equal(list.items.length, 2);
  assert.ok(!('moderation' in list.items[0]));
  const only4 = (await app.inject({ method: 'GET', url: `/products/${PRODUCT}/reviews?rating=4` })).json();
  assert.equal(only4.total, 1);
  assert.equal((await app.inject({ method: 'GET', url: `/products/${PRODUCT}/reviews?hasImages=true` })).json().total, 1);

  // admin duyệt lại review bị AI ẩn → hiện + phát review.created lần đầu
  const adminTok = { authorization: `Bearer ${await jwks.sign('admin', ['admin'])}` };
  const queue = (await app.inject({ method: 'GET', url: '/admin/reviews?status=HIDDEN', headers: adminTok })).json();
  assert.equal(queue.total, 1);
  await col.outbox.deleteMany({});
  const shown = await app.inject({ method: 'POST', url: `/admin/reviews/${blocked.json().id}/show`, headers: adminTok });
  assert.equal(shown.json().status, 'PUBLISHED');
  assert.deepEqual(await outboxTypes(), ['review.created', 'product.rating_changed']);
  await col.outbox.deleteMany({});
  const hidden = await app.inject({ method: 'POST', url: `/admin/reviews/${failOpen.json().id}/hide`, headers: adminTok, payload: { reason: 'Spam' } });
  assert.equal(hidden.json().status, 'HIDDEN');
  assert.deepEqual(await outboxTypes(), ['product.rating_changed']);
  const after = (await app.inject({ method: 'GET', url: `/products/${PRODUCT}/summary` })).json();
  assert.equal(after.count, 3); // 5,3,1 (4 bị ẩn)
  assert.equal(after.avg, 3);
  const buyer = { authorization: `Bearer ${await jwks.sign(newId())}` };
  assert.equal((await app.inject({ method: 'POST', url: `/admin/reviews/${failOpen.json().id}/show`, headers: buyer })).statusCode, 403);
});

test('seller trả lời review của shop mình', async () => {
  const r = await col.reviews.findOne({ productId: PRODUCT, status: 'PUBLISHED' });
  const mine = { authorization: `Bearer ${await jwks.sign(newId(), ['seller'], { shopId: SHOP })}` };
  const other = { authorization: `Bearer ${await jwks.sign(newId(), ['seller'], { shopId: newId() })}` };
  assert.equal((await app.inject({ method: 'POST', url: `/seller/reviews/${r!._id}/reply`, headers: other, payload: { content: 'Cảm ơn' } })).statusCode, 404);
  const ok = await app.inject({ method: 'POST', url: `/seller/reviews/${r!._id}/reply`, headers: mine, payload: { content: 'Cảm ơn bạn đã ủng hộ shop!' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().reply.content, 'Cảm ơn bạn đã ủng hộ shop!');
  assert.equal((await app.inject({ method: 'POST', url: `/seller/reviews/${r!._id}/reply`, headers: mine, payload: { content: '  ' } })).statusCode, 400);
});

test('outbox: crash sau khi ghi review → sweeper chuyển lại, relay gửi đúng thứ tự rồi xoá', async () => {
  await col.outbox.deleteMany({});
  const id = newId();
  const doc = { _id: id, productId: PRODUCT2, shopId: SHOP, userId: 'u', rating: 2 };
  const events = pendingEvents(doc, { created: true, ratingChanged: true });
  await col.reviews.insertOne({
    ...doc, orderId: newId(), authorName: 'u*', content: '', images: [], status: 'PUBLISHED',
    moderation: { allowed: true, labels: [], score: 0, source: 'skipped' }, hiddenReason: null, hiddenBy: null, announced: true, reply: null,
    outbox: events, createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
  });
  assert.equal(await sweepPending(col), 1);
  assert.equal(await stageOutbox(col, id), 0); // chạy lặp không nhân đôi
  assert.equal(await col.outbox.countDocuments(), 2);

  const sent: { topic: string; types: string[] }[] = [];
  const bus = { publish: async (topic: string, evs: EventEnvelope[]) => void sent.push({ topic, types: evs.map((e) => e.type) }) } as unknown as EventBus;
  assert.equal(await relayOnce(col, bus, 'owner-1'), 2);
  assert.deepEqual(sent, [{ topic: 'review.v1', types: ['review.created', 'product.rating_changed'] }]);
  assert.equal(await col.outbox.countDocuments(), 0);
});
