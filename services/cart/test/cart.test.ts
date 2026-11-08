import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { createAuth, createService, newId } from '@shopnow/platform';
import { startTestJwks } from '@shopnow/platform/testing';
import type { EventEnvelope, OrderSnapshot } from '@shopnow/contracts';
import type { CatalogPort, InventoryPort, SkuInfo } from '../src/clients';
import { createCartStore } from '../src/store';
import { registerRoutes } from '../src/routes';
import { handleOrderEvent } from '../src/consumers';

const PREFIX = `carttest:${process.pid}:`;
const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379/11');
const store = createCartStore(redis, PREFIX, 3600);
const svc = createService('cart-test');
const app = svc.app;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;

const SHOP_A = newId();
const SHOP_B = newId();
const skus = new Map<string, SkuInfo>();
const stock = new Map<string, number>();
let inventoryDown = false;
let catalogDown = false;

function addSku(shopId: string, title: string, price: number): string {
  const skuId = newId();
  skus.set(skuId, {
    skuId, productId: newId(), shopId, shopName: shopId === SHOP_A ? 'Shop A' : 'Shop B', title, variantLabel: 'M / Đen',
    image: null, price, status: 'ACTIVE', productStatus: 'APPROVED', purchasable: true,
  });
  stock.set(skuId, 50);
  return skuId;
}

const catalog: CatalogPort = {
  async getSkus(ids) {
    if (catalogDown) throw new Error('catalog down');
    return ids.map((id) => skus.get(id)).filter((s): s is SkuInfo => Boolean(s));
  },
};
const inventory: InventoryPort = {
  async getStock(ids) {
    if (inventoryDown) throw new Error('inventory down');
    return new Map(ids.filter((i) => stock.has(i)).map((i) => [i, stock.get(i)!]));
  },
};

async function clear() {
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length) await redis.del(...keys);
}

before(async () => {
  jwks = await startTestJwks();
  await clear();
  registerRoutes(app, { store, auth: createAuth(jwks.authOptions), catalog, inventory, log: svc.log });
  await app.ready();
});
beforeEach(() => {
  inventoryDown = false;
  catalogDown = false;
});
after(async () => {
  await clear();
  await app.close();
  await redis.quit();
  await jwks.close();
});

test('khách thêm giỏ → nhận x-cart-id, nhóm theo shop, tính tiền', async () => {
  const a1 = addSku(SHOP_A, 'Áo thun', 150_000);
  const b1 = addSku(SHOP_B, 'Quần jean', 300_000);
  const r1 = await app.inject({ method: 'POST', url: '/cart/items', payload: { skuId: a1, qty: 2 } });
  assert.equal(r1.statusCode, 200, r1.body);
  const cartId = r1.headers['x-cart-id'] as string;
  assert.ok(cartId);
  const r2 = await app.inject({ method: 'POST', url: '/cart/items', headers: { 'x-cart-id': cartId }, payload: { skuId: b1, qty: 1 } });
  const cart = r2.json();
  assert.equal(cart.shops.length, 2);
  assert.equal(cart.subtotal, 600_000);
  assert.equal(cart.totalQty, 3);
  const groupA = cart.shops.find((g: { shopId: string }) => g.shopId === SHOP_A);
  assert.equal(groupA.items[0].lineTotal, 300_000);
  assert.equal(groupA.items[0].available, 50);
  assert.equal(groupA.items[0].purchasable, true);

  // cộng dồn, chặn 99
  await app.inject({ method: 'POST', url: '/cart/items', headers: { 'x-cart-id': cartId }, payload: { skuId: b1, qty: 99 } });
  stock.set(b1, 500);
  const capped = await app.inject({ method: 'POST', url: '/cart/items', headers: { 'x-cart-id': cartId }, payload: { skuId: b1, qty: 99 } });
  assert.equal(capped.json().shops.find((g: { shopId: string }) => g.shopId === SHOP_B).items[0].qty, 99);

  // PUT / DELETE
  const put = await app.inject({ method: 'PUT', url: `/cart/items/${a1}`, headers: { 'x-cart-id': cartId }, payload: { qty: 5 } });
  assert.equal(put.json().shops.find((g: { shopId: string }) => g.shopId === SHOP_A).items[0].qty, 5);
  assert.equal((await app.inject({ method: 'PUT', url: `/cart/items/${a1}`, headers: { 'x-cart-id': cartId }, payload: { qty: 100 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: `/cart/items/${newId()}`, headers: { 'x-cart-id': cartId }, payload: { qty: 1 } })).statusCode, 404);
  const del = await app.inject({ method: 'DELETE', url: `/cart/items/${b1}`, headers: { 'x-cart-id': cartId } });
  assert.equal(del.json().shops.length, 1);
  assert.ok((await redis.ttl(`${PREFIX}g:${cartId}`)) > 0, 'giỏ khách phải có TTL');
});

test('validate: qty 0, sku không tồn tại, hết hàng, giỏ rỗng', async () => {
  const a = addSku(SHOP_A, 'Mũ', 50_000);
  assert.equal((await app.inject({ method: 'POST', url: '/cart/items', payload: { skuId: a, qty: 0 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/cart/items', payload: { skuId: newId(), qty: 1 } })).statusCode, 404);
  stock.set(a, 1);
  const r = await app.inject({ method: 'POST', url: '/cart/items', payload: { skuId: a, qty: 2 } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'INSUFFICIENT_STOCK');
  const empty = (await app.inject({ method: 'GET', url: '/cart' })).json();
  assert.deepEqual(empty.shops, []);
});

test('inventory chết → available=null, không lỗi; đổi giá + hết hàng có cảnh báo', async () => {
  const token = await jwks.sign(newId());
  const h = { authorization: `Bearer ${token}` };
  const a = addSku(SHOP_A, 'Giày', 500_000);
  const b = addSku(SHOP_A, 'Tất', 20_000);
  await app.inject({ method: 'POST', url: '/cart/items', headers: h, payload: { skuId: a, qty: 1 } });
  await app.inject({ method: 'POST', url: '/cart/items', headers: h, payload: { skuId: b, qty: 3 } });

  inventoryDown = true;
  const r = await app.inject({ method: 'GET', url: '/cart', headers: h });
  assert.equal(r.statusCode, 200);
  const items = r.json().shops[0].items;
  assert.ok(items.every((i: { available: unknown; purchasable: boolean }) => i.available === null && i.purchasable));
  assert.ok(r.json().warnings.some((w: { code: string }) => w.code === 'INVENTORY_UNAVAILABLE'));

  inventoryDown = false;
  skus.get(a)!.price = 450_000;
  stock.set(b, 0);
  const w = (await app.inject({ method: 'GET', url: '/cart', headers: h })).json();
  const codes = w.warnings.map((x: { code: string }) => x.code).sort();
  assert.deepEqual(codes, ['OUT_OF_STOCK', 'PRICE_CHANGED']);
  assert.equal(w.subtotal, 450_000);
  // cảnh báo đổi giá chỉ báo một lần
  const again = (await app.inject({ method: 'GET', url: '/cart', headers: h })).json();
  assert.ok(!again.warnings.some((x: { code: string }) => x.code === 'PRICE_CHANGED'));

  catalogDown = true;
  const deg = await app.inject({ method: 'GET', url: '/cart', headers: h });
  assert.equal(deg.statusCode, 200);
  assert.ok(deg.json().warnings.some((x: { code: string }) => x.code === 'CATALOG_UNAVAILABLE'));
});

test('merge giỏ khách vào giỏ user: cộng dồn rồi xoá giỏ khách', async () => {
  const userId = newId();
  const h = { authorization: `Bearer ${await jwks.sign(userId)}` };
  const a = addSku(SHOP_B, 'Balo', 400_000);
  const b = addSku(SHOP_B, 'Ví', 100_000);
  await app.inject({ method: 'POST', url: '/cart/items', headers: h, payload: { skuId: a, qty: 1 } });
  const g = await app.inject({ method: 'POST', url: '/cart/items', payload: { skuId: a, qty: 2 } });
  const guestCartId = g.headers['x-cart-id'] as string;
  await app.inject({ method: 'POST', url: '/cart/items', headers: { 'x-cart-id': guestCartId }, payload: { skuId: b, qty: 1 } });

  assert.equal((await app.inject({ method: 'POST', url: '/cart/merge', payload: { guestCartId } })).statusCode, 401);
  const m = await app.inject({ method: 'POST', url: '/cart/merge', headers: h, payload: { guestCartId } });
  assert.equal(m.statusCode, 200, m.body);
  const cart = m.json();
  assert.equal(cart.merged, 2);
  const qtyOf = (sku: string) => cart.shops[0].items.find((i: { skuId: string }) => i.skuId === sku).qty;
  assert.equal(qtyOf(a), 3);
  assert.equal(qtyOf(b), 1);
  assert.equal(await redis.exists(`${PREFIX}g:${guestCartId}`), 0);
});

test('giới hạn 100 dòng', async () => {
  const ref = { kind: 'guest' as const, id: `limit${Date.now()}` };
  for (let i = 0; i < 100; i++) assert.ok((await store.add(ref, `sku-${i}`, 1, 1000)) > 0);
  assert.equal(await store.add(ref, 'sku-100', 1, 1000), -1);
  assert.equal(await store.add(ref, 'sku-5', 1, 1000), 2); // dòng cũ vẫn cộng được
});

test('order.created → xoá SKU đã đặt khỏi giỏ buyer, idempotent', async () => {
  const buyerId = newId();
  const h = { authorization: `Bearer ${await jwks.sign(buyerId)}` };
  const a = addSku(SHOP_A, 'Bút', 10_000);
  const b = addSku(SHOP_A, 'Vở', 15_000);
  await app.inject({ method: 'POST', url: '/cart/items', headers: h, payload: { skuId: a, qty: 1 } });
  await app.inject({ method: 'POST', url: '/cart/items', headers: h, payload: { skuId: b, qty: 1 } });
  const event: EventEnvelope<OrderSnapshot> = {
    id: newId(), type: 'order.created', source: 'order', time: new Date().toISOString(), subject: newId(),
    data: {
      id: newId(), checkoutId: newId(), buyerId, shopId: SHOP_A, status: 'PENDING',
      items: [{ skuId: a, productId: skus.get(a)!.productId, title: 'Bút', variantLabel: '', unitPrice: 10_000, qty: 1, lineTotal: 10_000 }],
      subtotal: 10_000, shippingFee: 0, discount: 0, total: 10_000, paymentMethod: 'COD',
      shippingAddress: { fullName: 'A', phone: '0900000000', line1: 'x', ward: 'x', district: 'x', province: 'Hà Nội' }, createdAt: new Date().toISOString(),
    },
  };
  assert.equal(await handleOrderEvent({ store, log: svc.log }, event), true);
  // thêm lại món đó rồi nhận bản trùng → không bị xoá lần nữa
  await app.inject({ method: 'POST', url: '/cart/items', headers: h, payload: { skuId: a, qty: 1 } });
  assert.equal(await handleOrderEvent({ store, log: svc.log }, event), false);
  const cart = (await app.inject({ method: 'GET', url: '/cart', headers: h })).json();
  assert.deepEqual(cart.shops[0].items.map((i: { skuId: string }) => i.skuId).sort(), [a, b].sort());
});
