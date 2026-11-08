import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createService, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import { registerRoutes } from '../src/routes';
import { seedCategories } from '../src/seed';

let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const svc = createService('catalog-test');
const app = svc.app;
const SHOP = '0190f0e0-0000-7000-8000-000000000001';

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('catalog_test', join(__dirname, '../migrations'));
  await seedCategories(pool);
  await pool.query(`INSERT INTO shops_cache (shop_id, name, status) VALUES ($1, 'Shop Test', 'APPROVED')`, [SHOP]);
  const storage = { ensureBucket: async () => undefined, presignUpload: async () => ({ uploadUrl: 'http://x', publicUrl: 'http://y', key: 'k' }) };
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), storage });
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
  await jwks.close();
});

test('seller tạo sản phẩm → admin duyệt → công khai + outbox có sự kiện', async () => {
  const sellerToken = await jwks.sign('seller-1', ['buyer', 'seller'], { shopId: SHOP });
  const adminToken = await jwks.sign('admin-1', ['admin']);
  const cats = (await app.inject({ method: 'GET', url: '/categories' })).json();
  const leaf = cats.items[0].children[0];

  const created = await app.inject({
    method: 'POST',
    url: '/seller/products',
    headers: { authorization: `Bearer ${sellerToken}` },
    payload: {
      categoryId: leaf.id,
      title: 'Áo thun cotton basic',
      description: 'Áo thun 100% cotton',
      variants: [
        { sku: 'AT-M-DEN', options: { size: 'M', color: 'Đen' }, price: 159000 },
        { sku: 'AT-L-DEN', options: { size: 'L', color: 'Đen' }, price: 169000 },
      ],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const p = created.json();
  assert.equal(p.slug, 'ao-thun-cotton-basic');
  assert.equal(p.minPrice, 159000);
  assert.equal(p.maxPrice, 169000);

  // Chưa duyệt → khách không thấy
  assert.equal((await app.inject({ method: 'GET', url: `/products/${p.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/seller/products/${p.id}/submit`, headers: { authorization: `Bearer ${sellerToken}` } })).statusCode, 200);
  // buyer không được duyệt
  const buyer = await jwks.sign('buyer-1');
  assert.equal((await app.inject({ method: 'POST', url: `/admin/products/${p.id}/approve`, headers: { authorization: `Bearer ${buyer}` } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/admin/products/${p.id}/approve`, headers: { authorization: `Bearer ${adminToken}` } })).statusCode, 200);

  const pub = await app.inject({ method: 'GET', url: `/products/ao-thun-cotton-basic` });
  assert.equal(pub.statusCode, 200);
  assert.deepEqual(pub.json().categoryPath, [cats.items[0].name, leaf.name]);

  const list = (await app.inject({ method: 'GET', url: `/products?categoryId=${cats.items[0].id}` })).json();
  assert.equal(list.total, 1);

  const skus = await app.inject({
    method: 'POST', url: '/internal/skus', headers: { 'x-internal-token': 'test-internal' },
    payload: { skuIds: p.variants.map((v: { id: string }) => v.id) },
  });
  assert.equal(skus.json().items.every((s: { purchasable: boolean }) => s.purchasable), true);
  assert.equal((await app.inject({ method: 'POST', url: '/internal/skus', payload: { skuIds: [] } })).statusCode, 403);

  const outbox = await pool.query(`SELECT payload->>'type' t FROM outbox ORDER BY created_at`);
  assert.ok(outbox.rows.length >= 3);
  assert.ok(outbox.rows.every((r) => r.t === 'product.upserted'));
});

test('validate dữ liệu: giá âm / SKU trùng', async () => {
  const sellerToken = await jwks.sign('seller-1', ['seller'], { shopId: SHOP });
  const cats = (await app.inject({ method: 'GET', url: '/categories' })).json();
  const bad = await app.inject({
    method: 'POST', url: '/seller/products', headers: { authorization: `Bearer ${sellerToken}` },
    payload: { categoryId: cats.items[0].id, title: 'Sản phẩm lỗi', variants: [{ sku: 'A', price: 2000 }, { sku: 'A', price: 3000 }] },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'VALIDATION_ERROR');
});
