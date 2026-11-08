import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { createAuth, createEvent, createService, newId } from '@shopnow/platform';
import { startTestJwks } from '@shopnow/platform/testing';
import { Topics, type OrderSnapshot, type ShopSnapshot } from '@shopnow/contracts';
import { collections, ensureIndexes, type Collections } from '../src/store';
import { createNotifier, type Mailer } from '../src/notifier';
import { localFanout, redisFanout, SseHub, type RealtimeMessage } from '../src/realtime';
import { cachedShopOwners } from '../src/clients';
import { handleEvent, type ConsumerDeps } from '../src/consumers';
import { registerRoutes } from '../src/routes';
import { cancelReasonText, escapeHtml } from '../src/templates';
import { smtpMailer } from '../src/mailer';

const mongo = new MongoClient(process.env.TEST_MONGO_URL ?? 'mongodb://localhost:57017', { serverSelectionTimeoutMS: 5_000 });
let col: Collections;
let deps: ConsumerDeps;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const svc = createService('notification-test');
const app = svc.app;
const hub = new SseHub();
const fanout = localFanout(hub);
const mails: { to: string; subject: string; html: string }[] = [];
let smtpDown = false;
const mailer: Mailer = {
  async send(m) {
    if (smtpDown) throw new Error('ECONNREFUSED');
    mails.push(m);
  },
};
const BUYER = newId();
const OWNER = newId();
const SHOP = newId();
let ownerLookups = 0;

before(async () => {
  jwks = await startTestJwks();
  await mongo.connect();
  const db = mongo.db('notification_test');
  await db.dropDatabase();
  col = collections(db);
  await ensureIndexes(col);
  deps = {
    col,
    notifier: createNotifier({ col, fanout, mailer, from: 'no-reply@shopnow.local', log: svc.log }),
    users: { getUser: async (id) => (id === BUYER ? { id, email: 'buyer@test.local', fullName: 'Người Mua' } : null) },
    shops: cachedShopOwners({
      async getOwnerId(id) {
        ownerLookups++;
        return id === SHOP ? OWNER : null;
      },
    }),
    webUrl: 'http://web.local',
    log: svc.log,
  };
  registerRoutes(app, { col, auth: createAuth(jwks.authOptions), hub, fanout, heartbeatMs: 50 });
  await app.listen({ port: 0, host: '127.0.0.1' });
});
after(async () => {
  hub.closeAll();
  await app.close();
  await mongo.close();
  await jwks.close();
});

function order(type: string, extra: Partial<OrderSnapshot> = {}) {
  const id = extra.id ?? newId();
  return createEvent<OrderSnapshot>(type, 'order', id, {
    id, checkoutId: extra.checkoutId ?? newId(), buyerId: BUYER, shopId: SHOP, status: 'PENDING',
    items: [{ skuId: newId(), productId: newId(), title: 'Áo <b>thun</b>', variantLabel: 'M', unitPrice: 150_000, qty: 2, lineTotal: 300_000 }],
    subtotal: 300_000, shippingFee: 30_000, discount: 0, total: 330_000, paymentMethod: 'COD',
    shippingAddress: { fullName: 'Người Mua', phone: '0900000000', line1: '1 Lê Lợi', ward: 'Bến Nghé', district: 'Quận 1', province: 'Hồ Chí Minh' },
    createdAt: new Date().toISOString(),
    ...extra,
  });
}

const auth = async (u: string) => ({ authorization: `Bearer ${await jwks.sign(u)}` });

test('OTP + chào mừng → email (template tiếng Việt), không gửi trùng', async () => {
  const otp = createEvent('user.otp_requested', 'identity', 'u1', { userId: 'u1', email: 'new@test.local', purpose: 'verify_email', code: '123456' });
  assert.equal(await handleEvent(deps, Topics.identityUser, otp), true);
  assert.equal(await handleEvent(deps, Topics.identityUser, otp), false);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /123456/);
  assert.match(mails[0].html, /Xác thực email/);

  const reg = createEvent('user.registered', 'identity', BUYER, { userId: BUYER, email: 'buyer@test.local', fullName: 'Người Mua' });
  await handleEvent(deps, Topics.identityUser, reg);
  assert.equal(mails.length, 2);
  assert.equal(mails[1].subject, 'Chào mừng bạn đến với ShopNow');
});

test('order.created → buyer in-app + email, seller in-app (cache chủ shop); huỷ có lý do tiếng Việt', async () => {
  mails.length = 0;
  const created = order('order.created');
  await handleEvent(deps, Topics.order, created);
  await handleEvent(deps, Topics.order, order('order.created'));
  assert.equal(ownerLookups, 1, 'chủ shop được cache');
  assert.equal(mails.length, 2);
  assert.equal(mails[0].to, 'buyer@test.local');
  assert.match(mails[0].subject, /Đặt hàng thành công/);
  assert.match(mails[0].html, /330\.000/);
  assert.ok(mails[0].html.includes('Áo &lt;b&gt;thun&lt;/b&gt;'), 'nội dung người dùng phải được escape');
  const sellerNotes = await col.notifications.find({ userId: OWNER }).toArray();
  assert.equal(sellerNotes.length, 2);
  assert.equal(sellerNotes[0].title, 'Bạn có đơn hàng mới');

  // SMTP lỗi → ném để consumer thử lại; lần sau gửi được, in-app không bị nhân đôi
  smtpDown = true;
  const cancelled = order('order.cancelled', { id: created.data.id, checkoutId: created.data.checkoutId, status: 'CANCELLED', reason: 'OUT_OF_STOCK' });
  await assert.rejects(handleEvent(deps, Topics.order, cancelled));
  smtpDown = false;
  assert.equal(await handleEvent(deps, Topics.order, cancelled), true);
  const buyerCancel = await col.notifications.find({ userId: BUYER, type: 'order.cancelled' }).toArray();
  assert.equal(buyerCancel.length, 1);
  assert.match(buyerCancel[0].body, /Sản phẩm đã hết hàng/);
  assert.match(mails.at(-1)!.subject, /đã bị huỷ/);
  assert.equal(await col.notifications.countDocuments({ userId: OWNER, type: 'seller.order_cancelled' }), 1);

  // completed → nhắc đánh giá
  await handleEvent(deps, Topics.order, order('order.completed', { id: created.data.id, status: 'COMPLETED' }));
  const done = await col.notifications.findOne({ userId: BUYER, type: 'order.completed' });
  assert.match(done!.link!, /review=1/);
  assert.equal(cancelReasonText('Đổi ý không mua nữa'), 'Đổi ý không mua nữa');
  assert.equal(escapeHtml('<x>'), '&lt;x&gt;');
});

test('payment.* (tra buyer theo checkout) + shipment.created (mã vận đơn) + shop.approved', async () => {
  const o = order('order.created');
  await handleEvent(deps, Topics.order, o);
  await handleEvent(deps, Topics.paymentEvent, createEvent('payment.succeeded', 'payment', o.data.checkoutId, { paymentId: 'p1', checkoutId: o.data.checkoutId, amount: 330_000 }));
  await handleEvent(deps, Topics.paymentEvent, createEvent('payment.refunded', 'payment', o.data.checkoutId, { checkoutId: o.data.checkoutId, orderId: o.data.id, amount: 330_000 }));
  await handleEvent(deps, Topics.paymentEvent, createEvent('payment.failed', 'payment', 'unknown', { paymentId: 'p2', checkoutId: 'unknown', reason: 'x' }));
  assert.equal(await col.notifications.countDocuments({ userId: BUYER, type: 'payment.succeeded' }), 1);
  assert.equal(await col.notifications.countDocuments({ userId: BUYER, type: 'payment.refunded' }), 1);
  assert.equal(await col.notifications.countDocuments({ type: 'payment.failed' }), 0);

  await handleEvent(deps, Topics.shipping, createEvent('shipment.created', 'shipping', o.data.id, { shipmentId: 's1', orderId: o.data.id, carrier: 'GHN', trackingCode: 'GHNABC123', fee: 30_000, status: 'CREATED', at: new Date().toISOString() }));
  const ship = await col.notifications.findOne({ userId: BUYER, type: 'shipment.created' });
  assert.match(ship!.body, /GHNABC123/);
  assert.match(ship!.body, /Giao Hàng Nhanh/);

  const newOwner = newId();
  const shop: ShopSnapshot = { id: newId(), ownerId: newOwner, name: 'Shop Mới', slug: 'shop-moi', status: 'APPROVED', createdAt: new Date().toISOString() };
  await handleEvent(deps, Topics.sellerShop, createEvent('shop.approved', 'seller', shop.id, shop));
  await handleEvent(deps, Topics.sellerShop, createEvent('shop.rejected', 'seller', shop.id, { ...shop, status: 'REJECTED', rejectReason: 'Thiếu giấy phép' }));
  const owner = await col.notifications.find({ userId: newOwner }).sort({ createdAt: 1 }).toArray();
  assert.deepEqual(owner.map((n) => n.title), ['Shop đã được duyệt', 'Hồ sơ shop bị từ chối']);
  assert.match(owner[1].body, /Thiếu giấy phép/);
  assert.equal(await deps.shops.getOwnerId(shop.id), newOwner);
});

test('API in-app: phân trang, unreadCount, đọc 1 / đọc hết, không đọc được của người khác', async () => {
  const h = await auth(BUYER);
  const list = await app.inject({ method: 'GET', url: '/notifications?pageSize=2', headers: h });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.equal(body.items.length, 2);
  assert.ok(body.total >= 5);
  assert.equal(body.unreadCount, body.total);
  const first = body.items[0].id;
  assert.equal((await app.inject({ method: 'POST', url: `/notifications/${first}/read`, headers: await auth(OWNER) })).json().unreadCount, await col.notifications.countDocuments({ userId: OWNER, read: false }));
  const r = (await app.inject({ method: 'POST', url: `/notifications/${first}/read`, headers: h })).json();
  assert.equal(r.unreadCount, body.total - 1);
  const all = (await app.inject({ method: 'POST', url: '/notifications/read-all', headers: h })).json();
  assert.equal(all.updated, body.total - 1);
  assert.equal((await app.inject({ method: 'GET', url: '/notifications?unread=true', headers: h })).json().total, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/notifications' })).statusCode, 401);
});

test('SSE: token qua ?token=, nhận ready + heartbeat + thông báo mới', async () => {
  const userId = newId();
  const token = await jwks.sign(userId);
  const port = (app.server.address() as AddressInfo).port;
  const chunks: string[] = [];
  const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    get(`http://127.0.0.1:${port}/notifications/stream?token=${token}`, resolve).on('error', reject);
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  res.setEncoding('utf8');
  res.on('data', (c: string) => chunks.push(c));
  const waitFor = async (re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(chunks.join('')); i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(chunks.join(''), re);
  };
  await waitFor(/event: ready/);
  await waitFor(/: ping/);
  await deps.notifier.inApp(userId, `test:${userId}`, { type: 'test', title: 'Xin chào', body: 'Thông báo realtime' });
  await waitFor(/event: notification\ndata: .*Xin chào/);
  res.destroy();
  const bad = await new Promise<number>((resolve) => get(`http://127.0.0.1:${port}/notifications/stream?token=bad`, (r) => resolve(r.statusCode ?? 0)));
  assert.equal(bad, 401);
});

test('fan-out nhiều replica qua Redis pub/sub', async () => {
  const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379/11';
  const conns = [new Redis(url), new Redis(url), new Redis(url)];
  const channel = `notiftest:${process.pid}:${Date.now()}`;
  const hubA = new SseHub();
  const hubB = new SseHub();
  const got: RealtimeMessage[] = [];
  hubB.deliver = (m) => (got.push(m), 1);
  const fa = await redisFanout(conns[0], conns[1], channel, hubA, svc.log);
  const fb = await redisFanout(conns[0], conns[2], channel, hubB, svc.log);
  await fa.publish({ userId: 'u', event: 'unread', data: { unreadCount: 3 } });
  for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got[0], { userId: 'u', event: 'unread', data: { unreadCount: 3 } });
  await fa.close();
  await fb.close();
  await Promise.all(conns.map((c) => c.quit()));
});

test('SMTP thật (Mailpit) gửi được email', { skip: process.env.SKIP_SMTP === '1' }, async () => {
  const m = smtpMailer(process.env.TEST_SMTP_URL ?? 'smtp://localhost:51025', 'ShopNow <no-reply@shopnow.local>');
  await m.send({ to: 'test@shopnow.local', subject: '[test] notification', html: '<p>ok</p>', text: 'ok' });
  m.close();
});
