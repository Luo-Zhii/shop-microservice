import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { createAuth, createService, newId } from '@shopnow/platform';
import { startTestJwks } from '@shopnow/platform/testing';
import { buildGateway, isInternalPath, type GatewayOptions } from '../src/gateway';
import type { Upstreams } from '../src/config';

const PRODUCT = { id: '0190f0e0-0000-7000-8000-0000000000aa', slug: 'ao-thun', title: 'Áo thun', variants: [{ id: 'sku-1' }, { id: 'sku-2' }] };

let jwks: Awaited<ReturnType<typeof startTestJwks>>;
let deadUrl: string;
const fakes: FastifyInstance[] = [];
let gw: FastifyInstance;
let upstreams: Upstreams;

async function listen(app: FastifyInstance) {
  await app.listen({ port: 0, host: '127.0.0.1' });
  fakes.push(app);
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** Upstream giả: trả lại method/url/header nhận được. */
function echoApp() {
  const app = Fastify();
  app.get('/readyz', async () => ({ status: 'ok', checks: { postgres: 'ok' } }));
  app.all('/*', async (req) => ({ method: req.method, url: req.url, headers: req.headers, body: req.body ?? null }));
  return app;
}

function catalogApp() {
  const app = echoApp();
  app.get('/products', async () => ({ items: [PRODUCT], page: 1, pageSize: 12, total: 1 }));
  app.get<{ Params: { id: string } }>('/products/:id', async (req, reply) =>
    req.params.id === PRODUCT.slug || req.params.id === PRODUCT.id
      ? PRODUCT
      : reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy sản phẩm' } }),
  );
  app.get('/banners', async () => ({ items: [{ id: 'b1' }] }));
  app.get('/categories', async () => ({ items: [{ id: 'c1', children: [] }] }));
  return app;
}

function gatewayOpts(over: Partial<GatewayOptions> = {}): GatewayOptions {
  return {
    auth: createAuth(jwks.authOptions),
    upstreams,
    rateLimit: { enabled: true, globalMax: 600, authMax: 30 },
    bffTimeoutMs: 500,
    statusTimeoutMs: 500,
    ...over,
  };
}

before(async () => {
  jwks = await startTestJwks();
  // URL chắc chắn chết: mở cổng rồi đóng
  const tmp = Fastify();
  await tmp.listen({ port: 0, host: '127.0.0.1' });
  deadUrl = `http://127.0.0.1:${(tmp.server.address() as AddressInfo).port}`;
  await tmp.close();

  const catalog = await listen(catalogApp());
  const echo = await listen(echoApp());
  const promotion = echoApp();
  promotion.get('/flash-sales/active', async () => ({ items: [{ id: 'fs-other', items: [{ productId: 'x' }] }, { id: 'fs-1', items: [{ productId: PRODUCT.id, skuId: 'sku-1', salePrice: 99000 }] }] }));
  const promotionUrl = await listen(promotion);
  const review = echoApp();
  review.get('/products/:id/summary', async () => ({ ratingAvg: 4.5, ratingCount: 10 }));
  const reviewUrl = await listen(review);
  const notification = Fastify();
  notification.get('/notifications/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write(`data: {"n":1,"user":"${req.headers['x-user-id'] ?? ''}"}\n\n`);
    const t = setTimeout(() => {
      reply.raw.write('data: {"n":2}\n\n');
      reply.raw.end();
    }, 400);
    req.raw.on('close', () => clearTimeout(t));
  });
  const notificationUrl = await listen(notification);

  upstreams = {
    identity: echo, 'user-profile': echo, seller: echo, catalog, search: echo, inventory: deadUrl, cart: echo, promotion: promotionUrl,
    order: echo, payment: echo, shipping: echo, review: reviewUrl, notification: notificationUrl, ai: deadUrl,
  };
  gw = createService('api-gateway-test').app;
  await buildGateway(gw, gatewayOpts());
  await gw.ready();
});

after(async () => {
  await gw.close();
  for (const f of fakes) await f.close();
  await jwks.close();
});

test('proxy bỏ prefix /api/<svc>, giữ query, truyền x-request-id, không tin x-user-id client gửi', async () => {
  const r = await gw.inject({ method: 'GET', url: '/api/cart/cart?x=1', headers: { 'x-request-id': 'req-abc', 'x-user-id': 'gia-mao', 'x-internal-token': 'leak' } });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.url, '/cart?x=1');
  assert.equal(body.headers['x-request-id'], 'req-abc');
  assert.equal(body.headers['x-user-id'], undefined);
  assert.equal(body.headers['x-internal-token'], undefined);
  assert.equal(r.headers['x-request-id'], 'req-abc');

  const up = (await gw.inject({ method: 'POST', url: '/api/user-profile/me/addresses', payload: { a: 1 } })).json();
  assert.equal(up.url, '/me/addresses');
  assert.equal(up.method, 'POST');
  assert.deepEqual(up.body, { a: 1 });
  assert.equal((await gw.inject({ method: 'GET', url: '/api/khong-co/abc' })).statusCode, 404);
});

test('chặn mọi đường /internal (kể cả mã hoá / dot-segment)', async () => {
  for (const url of [
    '/api/catalog/internal/skus',
    '/api/identity/internal/users/1',
    '/api/catalog//internal/skus',
    '/api/catalog/%69nternal/skus',
    '/api/catalog/products/../internal/skus',
    '/api/catalog/products/%2e%2e/internal/skus',
    '/api/catalog/INTERNAL/skus',
    '/api/catalog/products%2F..%2Finternal',
  ]) {
    const r = await gw.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 403, `${url} → ${r.statusCode}`);
    assert.equal(r.json().error.code, 'FORBIDDEN');
  }
  assert.equal(isInternalPath('/api/catalog/products/internal-tshirt'), false);
  assert.equal((await gw.inject({ method: 'GET', url: '/api/catalog/products/internals' })).statusCode, 404);
});

test('JWT: token hợp lệ → x-user-id; token sai → 401; endpoint đăng nhập/refresh bỏ qua token cũ', async () => {
  const uid = newId();
  const good = await jwks.sign(uid, ['buyer', 'seller']);
  const ok = (await gw.inject({ method: 'GET', url: '/api/order/orders', headers: { authorization: `Bearer ${good}` } })).json();
  assert.equal(ok.headers['x-user-id'], uid);
  assert.equal(ok.headers['x-user-roles'], 'buyer,seller');
  assert.equal(ok.headers.authorization, `Bearer ${good}`);

  const bad = await gw.inject({ method: 'GET', url: '/api/order/orders', headers: { authorization: 'Bearer abc.def.ghi' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.code, 'UNAUTHORIZED');
  // Không có token → cho qua (service tự phân quyền)
  assert.equal((await gw.inject({ method: 'GET', url: '/api/catalog/categories' })).statusCode, 200);
  const refresh = await gw.inject({ method: 'POST', url: '/api/identity/auth/refresh', headers: { authorization: 'Bearer het-han' }, payload: {} });
  assert.equal(refresh.statusCode, 200);
  assert.equal(refresh.json().url, '/auth/refresh');
});

test('BFF product: gom catalog + review + flash sale; inventory/ai chết → degraded', async () => {
  const r = await gw.inject({ method: 'GET', url: '/api/bff/products/ao-thun' });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.product.id, PRODUCT.id);
  assert.deepEqual(b.reviewSummary, { ratingAvg: 4.5, ratingCount: 10 });
  assert.equal(b.flashSale.id, 'fs-1');
  assert.equal(b.stock, null);
  assert.deepEqual(b.recommendations, []);
  assert.deepEqual(b.degraded.sort(), ['recommendations', 'stock']);

  const nf = await gw.inject({ method: 'GET', url: '/api/bff/products/khong-ton-tai' });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().error.code, 'NOT_FOUND');
});

test('BFF home: thiếu nguồn phụ vẫn trả; catalog chết → lỗi UPSTREAM_ERROR', async () => {
  const t = await jwks.sign(newId());
  const r = await gw.inject({ method: 'GET', url: '/api/bff/home', headers: { authorization: `Bearer ${t}` } });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.newProducts.length, 1);
  assert.equal(b.banners[0].id, 'b1');
  assert.equal(b.categories[0].id, 'c1');
  assert.equal(b.flashSales.length, 2);
  assert.deepEqual(b.degraded, ['recommendations']);
  // Khách (không token) → không gọi gợi ý cá nhân
  assert.deepEqual((await gw.inject({ method: 'GET', url: '/api/bff/home' })).json().degraded, []);

  const broken = createService('api-gateway-test-broken').app;
  await buildGateway(broken, gatewayOpts({ upstreams: { ...upstreams, catalog: deadUrl } }));
  const e = await broken.inject({ method: 'GET', url: '/api/bff/home' });
  assert.equal(e.statusCode, 502);
  assert.equal(e.json().error.code, 'UPSTREAM_ERROR');
  // Proxy tới upstream chết → 502 chuẩn
  const p = await broken.inject({ method: 'GET', url: '/api/catalog/products' });
  assert.equal(p.statusCode, 502);
  assert.equal(p.json().error.code, 'UPSTREAM_ERROR');
  await broken.close();
});

test('rate limit: /api/identity/auth/* 30 req/phút/IP → RATE_LIMITED; IP khác không ảnh hưởng', async () => {
  const hit = (ip: string) => gw.inject({ method: 'POST', url: '/api/identity/auth/login', payload: {}, headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 30; i++) assert.equal((await hit('10.0.0.1')).statusCode, 200);
  const blocked = await hit('10.0.0.1');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'RATE_LIMITED');
  assert.ok(blocked.headers['retry-after']);
  assert.equal((await hit('10.0.0.2')).statusCode, 200);
  // Bucket chung khác bucket auth
  assert.equal((await gw.inject({ method: 'GET', url: '/api/catalog/categories', headers: { 'x-forwarded-for': '10.0.0.1' } })).statusCode, 200);
});

test('rate limit lưu Redis (dùng chung giữa các replica)', async () => {
  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379', { maxRetriesPerRequest: 1 });
  const nameSpace = `gw-rl-test:${newId()}:`;
  const mk = async () => {
    const a = createService('api-gateway-test-redis').app;
    await buildGateway(a, gatewayOpts({ redis, rateLimit: { enabled: true, globalMax: 3, authMax: 30, nameSpace } }));
    return a;
  };
  const [a, b] = [await mk(), await mk()];
  const hit = (app: FastifyInstance) => app.inject({ method: 'GET', url: '/api/catalog/categories', headers: { 'x-forwarded-for': '10.9.9.9' } });
  assert.equal((await hit(a)).statusCode, 200);
  assert.equal((await hit(b)).statusCode, 200);
  assert.equal((await hit(a)).statusCode, 200);
  assert.equal((await hit(b)).statusCode, 429);
  await a.close();
  await b.close();
  const keys = await redis.keys(`${nameSpace}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

test('SSE đi xuyên proxy không bị buffer, ?token= được xác minh', async () => {
  const live = createService('api-gateway-test-sse').app;
  await buildGateway(live, gatewayOpts());
  await live.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(live.server.address() as AddressInfo).port}`;
  try {
    const uid = newId();
    const token = await jwks.sign(uid);
    const t0 = Date.now();
    const res = await fetch(`${base}/api/notification/notifications/stream?token=${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.startsWith('text/event-stream'));
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // Sự kiện đầu tới trước khi upstream kết thúc stream (400ms) → không bị buffer
    assert.ok(Date.now() - t0 < 350, `nhận sự kiện đầu sau ${Date.now() - t0}ms`);
    assert.ok(first.includes('"n":1') && first.includes(uid), first);
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert.ok(rest.includes('"n":2'));

    const bad = await fetch(`${base}/api/notification/notifications/stream?token=sai`);
    assert.equal(bad.status, 401);
  } finally {
    await live.close();
  }
});

test('/api/status gom readyz của các upstream', async () => {
  const s = (await gw.inject({ method: 'GET', url: '/api/status' })).json();
  assert.equal(s.total, 14);
  assert.equal(s.status, 'degraded');
  const by = Object.fromEntries(s.services.map((x: { name: string; status: string }) => [x.name, x.status]));
  assert.equal(by.catalog, 'up');
  assert.equal(by.inventory, 'down');
  assert.equal(by.ai, 'down');
});
