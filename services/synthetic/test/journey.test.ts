import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { registry } from '@shopnow/platform';
import { runJourney } from '../src/journey';
import { createProbe } from '../src/probe';

const SKU = '0190f0e0-0000-7000-8000-0000000000b1';
const CART = '0190f0e0-0000-7000-8000-0000000000c1';
let gw: FastifyInstance;
let url: string;
const mode = { cart: 'ok' as 'ok' | 'down' | 'slow', variants: true, seen: [] as Record<string, unknown>[] };
const carts = new Map<string, string[]>();

before(async () => {
  gw = Fastify();
  gw.addHook('onRequest', async (req) => { mode.seen.push({ url: req.url, token: req.headers['x-synthetic-token'], ua: req.headers['user-agent'] }); });
  gw.get('/api/bff/home', async () => ({ newProducts: [{ id: 'p1', slug: 'ao-thun' }] }));
  gw.get('/api/search/search', async () => ({ items: [], total: 0 }));
  gw.get('/api/bff/products/:slug', async () => ({ product: { id: 'p1', variants: mode.variants ? [{ id: SKU }] : [] } }));
  gw.post('/api/cart/cart/items', async (req, reply) => {
    if (mode.cart === 'down') return reply.status(503).send({ error: { code: 'UPSTREAM_ERROR' } });
    if (mode.cart === 'slow') await new Promise((r) => setTimeout(r, 300));
    carts.set(CART, [SKU]);
    return reply.header('x-cart-id', CART).send({ items: [{ skuId: SKU }] });
  });
  gw.get('/api/cart/cart', async (req) => ({ items: (carts.get(String(req.headers['x-cart-id'])) ?? []).map((skuId) => ({ skuId })) }));
  gw.delete('/api/cart/cart/items/:sku', async (req, reply) => { carts.set(CART, []); return reply.status(204).send(); });
  await gw.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
});
after(() => gw.close());

const opts = () => ({ baseUrl: url, token: 'tok', query: 'áo', timeoutMs: 150, location: 'onprem' });

test('hành trình đủ 6 bước qua gateway, gắn token robot, dọn giỏ khách', async () => {
  mode.cart = 'ok'; mode.variants = true; mode.seen.length = 0;
  const r = await runJourney(opts());
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(r.steps.map((s) => s.step), ['home', 'search', 'product', 'cart_add', 'cart_view', 'cart_remove']);
  assert.deepEqual([...new Set(r.steps.map((s) => s.service))], ['api-gateway', 'search', 'catalog', 'cart']);
  assert.ok(mode.seen.every((s) => s.token === 'tok' && String(s.ua).startsWith('ShopNowSynthetic')));
  assert.deepEqual(carts.get(CART), [], 'giỏ khách phải được dọn sau mỗi lần chạy');
  assert.ok(!mode.seen.some((s) => String(s.url).includes('checkout')), 'không bao giờ gọi checkout');
});

test('lỗi giữa chừng: dừng ở bước hỏng, gán đúng service; bước sau không chạy', async () => {
  mode.cart = 'down';
  const r = await runJourney(opts());
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 'cart_add');
  const last = r.steps.at(-1)!;
  assert.deepEqual([last.step, last.service, last.status, last.ok], ['cart_add', 'cart', 503, false]);
  assert.equal(r.steps.length, 4);
  // dữ liệu sai (sản phẩm không có biến thể) cũng là lỗi — ở bước product/catalog
  mode.cart = 'ok'; mode.variants = false;
  const p = await runJourney(opts());
  assert.equal(p.failedStep, 'product');
  assert.match(p.steps.at(-1)!.error!, /không có biến thể/);
  mode.variants = true;
});

test('timeout từng bước, metric theo bước + bỏ nhãn bước không chạy tới', async () => {
  mode.cart = 'slow';
  const probe = createProbe(opts());
  const r = await probe.runOnce();
  assert.equal(r.failedStep, 'cart_add');
  assert.match(r.steps.at(-1)!.error!, /quá 150 ms/);
  let text = await registry.metrics();
  assert.match(text, /synthetic_step_success\{journey="browse_to_cart",step="cart_add",service="cart",location="onprem"\} 0/);
  assert.doesNotMatch(text, /synthetic_step_success\{[^}]*step="cart_view"/);
  assert.match(text, /synthetic_journey_runs_total\{journey="browse_to_cart",location="onprem",result="failure"\} 1/);
  mode.cart = 'ok';
  await probe.runOnce();
  text = await registry.metrics();
  assert.match(text, /synthetic_step_success\{[^}]*step="cart_view"[^}]*\} 1/);
  assert.match(text, /synthetic_journey_success\{journey="browse_to_cart",location="onprem"\} 1/);
  assert.equal(probe.history.length, 2);
  assert.equal(probe.history[0].ok, true);
});
