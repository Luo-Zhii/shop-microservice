import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createEvent, createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb } from '@shopnow/platform/testing';
import type { ProductSnapshot } from '@shopnow/contracts';
import { PostgresEngine } from '../src/engines/postgres';
import { handleEvent, type IndexerDeps } from '../src/indexer';
import { registerRoutes } from '../src/routes';
import type { CategoryPort } from '../src/categories';

let pool: Pool;
let deps: IndexerDeps;
const svc = createService('search-test');
const app = svc.app;

// Cây danh mục giả: Thời trang > Áo, Thời trang > Quần; Điện tử > Điện thoại
const ROOT_FASHION = newId();
const CAT_SHIRT = newId();
const CAT_PANTS = newId();
const ROOT_ELEC = newId();
const CAT_PHONE = newId();
const tree: Record<string, { ids: string[]; names: string[] }> = {
  [ROOT_FASHION]: { ids: [ROOT_FASHION], names: ['Thời trang'] },
  [CAT_SHIRT]: { ids: [ROOT_FASHION, CAT_SHIRT], names: ['Thời trang', 'Áo'] },
  [CAT_PANTS]: { ids: [ROOT_FASHION, CAT_PANTS], names: ['Thời trang', 'Quần'] },
  [ROOT_ELEC]: { ids: [ROOT_ELEC], names: ['Điện tử'] },
  [CAT_PHONE]: { ids: [ROOT_ELEC, CAT_PHONE], names: ['Điện tử', 'Điện thoại'] },
};
let catalogDown = false;
const categories: CategoryPort = {
  async chain(id) {
    if (catalogDown) throw new Error('catalog down');
    return tree[id] ?? null;
  },
};
const SHOP_A = newId();
const SHOP_B = newId();
const ids: Record<string, string> = {};

function snapshot(key: string, o: Partial<ProductSnapshot> & { title: string; categoryId: string; price: number }): ProductSnapshot {
  const id = (ids[key] ??= newId());
  const now = new Date().toISOString();
  const { price, ...rest } = o;
  return {
    id, shopId: SHOP_A, shopName: 'Shop A', categoryPath: tree[o.categoryId]?.names ?? [], slug: key, description: '', brand: null,
    attributes: {}, images: [`https://img.local/${key}.jpg`], status: 'APPROVED', minPrice: price, maxPrice: price + 10_000,
    ratingAvg: 0, ratingCount: 0, soldCount: 0,
    variants: [{ id: `${id}-sku1`, sku: `${key}-1`, options: { size: 'M' }, price, weightGrams: 200, status: 'ACTIVE' }],
    createdAt: now, updatedAt: now,
    ...rest,
  };
}

const upsert = (p: ProductSnapshot) => handleEvent(deps, createEvent('product.upserted', 'catalog', p.id, p));
const search = async (qs: string) => {
  const r = await app.inject({ method: 'GET', url: `/search?${qs}` });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

before(async () => {
  pool = await freshTestDb('search_test', join(__dirname, '../migrations'));
  const engine = new PostgresEngine(pool, join(__dirname, '../migrations'));
  await engine.init();
  deps = { engine, categories, log: svc.log };
  registerRoutes(app, { engine, log: svc.log });
  await app.ready();

  const t0 = Date.now();
  const at = (m: number) => new Date(t0 - m * 60_000).toISOString();
  await upsert(snapshot('ao-thun', { title: 'Áo thun cotton nam basic', categoryId: CAT_SHIRT, price: 159_000, soldCount: 120, ratingAvg: 4.8, brand: 'Coolmate', createdAt: at(50) }));
  await upsert(snapshot('ao-khoac', { title: 'Áo khoác gió đi phượt', categoryId: CAT_SHIRT, price: 450_000, soldCount: 30, ratingAvg: 4.2, createdAt: at(40) }));
  await upsert(snapshot('quan-jean', { title: 'Quần jean ống đứng', categoryId: CAT_PANTS, price: 350_000, soldCount: 80, ratingAvg: 3.9, shopId: SHOP_B, shopName: 'Shop B', createdAt: at(30) }));
  await upsert(snapshot('dien-thoai', { title: 'Điện thoại Galaxy A15', categoryId: CAT_PHONE, price: 4_990_000, soldCount: 15, ratingAvg: 4.5, createdAt: at(10) }));
  await upsert(snapshot('ao-thun-tre-em', { title: 'Áo thun trẻ em in hình', categoryId: CAT_SHIRT, price: 89_000, soldCount: 5, ratingAvg: 4.9, createdAt: at(5) }));
});
after(async () => {
  await app.close();
  await pool.end();
});

test('tìm có dấu / không dấu / sai chính tả nhẹ', async () => {
  const noAccent = await search('q=ao%20thun');
  assert.equal(noAccent.total, 2);
  assert.equal(noAccent.items[0].title, 'Áo thun cotton nam basic'); // relevance: phrase + bán chạy
  assert.equal((await search(`q=${encodeURIComponent('Áo Thun')}`)).total, 2);
  assert.equal((await search(`q=${encodeURIComponent('dien thoai')}`)).items[0].id, ids['dien-thoai']);
  const typo = await search('q=ao%20thunn');
  assert.ok(typo.items.some((i: { id: string }) => i.id === ids['ao-thun']), 'gõ sai nhẹ vẫn ra');
  assert.equal((await search('q=coolmate')).total, 1, 'khớp cả thương hiệu');
  assert.equal((await search('q=xyzxyz')).total, 0);
  assert.equal((await search('q=tam%20thoi')).total, 0, 'một từ trùng "thời trang" không đủ để khớp');
  assert.equal((await search('q=ao%20thu')).total, 2, 'khớp tiền tố từ');
  assert.equal((await search('q=khoak')).items[0]?.id, ids['ao-khoac']);
  assert.equal((await search('q=100%25')).total, 0, 'ký tự LIKE được escape');
});

test('lọc danh mục cha/con, giá, rating, shop + sắp xếp + phân trang', async () => {
  assert.equal((await search(`categoryId=${ROOT_FASHION}`)).total, 4);
  assert.equal((await search(`categoryId=${CAT_SHIRT}`)).total, 3);
  assert.equal((await search(`categoryId=${CAT_SHIRT}&q=ao%20khoac`)).total, 1);
  const price = await search('minPrice=100000&maxPrice=500000&sort=price_asc');
  assert.deepEqual(price.items.map((i: { minPrice: number }) => i.minPrice), [159_000, 350_000, 450_000]);
  assert.deepEqual((await search('sort=price_desc&pageSize=2')).items.map((i: { id: string }) => i.id), [ids['dien-thoai'], ids['ao-khoac']]);
  assert.equal((await search('sort=newest')).items[0].id, ids['ao-thun-tre-em']);
  assert.equal((await search('sort=best_selling')).items[0].id, ids['ao-thun']);
  assert.equal((await search('rating=4.5')).total, 3);
  assert.equal((await search(`shopId=${SHOP_B}`)).total, 1);
  const p2 = await search('sort=price_asc&page=2&pageSize=2');
  assert.equal(p2.total, 5);
  assert.equal(p2.page, 2);
  assert.equal(p2.items.length, 2);
  const beyond = await search('page=9&pageSize=2');
  assert.equal(beyond.total, 5);
  assert.equal(beyond.items.length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/search?sort=random' })).statusCode, 400);
});

test('facets danh mục + khoảng giá', async () => {
  const r = await search('q=ao&minPrice=100000');
  const cats = Object.fromEntries(r.facets.categories.map((c: { id: string; count: number }) => [c.id, c.count]));
  assert.equal(cats[ROOT_FASHION], 2);
  assert.equal(cats[CAT_SHIRT], 2);
  assert.equal(r.facets.categories.find((c: { id: string }) => c.id === CAT_SHIRT).name, 'Áo');
  const ranges = Object.fromEntries(r.facets.priceRanges.map((p: { key: string; count: number }) => [p.key, p.count]));
  // facet giá bỏ qua bộ lọc giá: đếm cả áo trẻ em 89k
  assert.equal(ranges['0-100000'], 1);
  assert.equal(ranges['100000-200000'], 1);
  assert.equal(ranges['200000-500000'], 1);
  assert.equal(r.facets.priceRanges.length, 6);
});

test('chỉ APPROVED được index; product.deleted xoá; bản cũ đến trễ bị bỏ qua; rating_changed', async () => {
  const hidden = snapshot('ao-thun', { title: 'Áo thun cotton nam basic', categoryId: CAT_SHIRT, price: 159_000, status: 'HIDDEN', updatedAt: new Date(Date.now() + 1000).toISOString() });
  await upsert(hidden);
  assert.equal((await search('q=ao%20thun')).total, 1);
  await upsert({ ...hidden, status: 'APPROVED', soldCount: 120, updatedAt: new Date(Date.now() + 2000).toISOString() });
  assert.equal((await search('q=ao%20thun')).total, 2);
  // bản cũ (updatedAt nhỏ hơn) không ghi đè tiêu đề
  await upsert({ ...hidden, status: 'APPROVED', title: 'Tên cũ', updatedAt: new Date(Date.now() - 86_400_000).toISOString() });
  assert.equal((await search('q=ao%20thun')).items[0].title, 'Áo thun cotton nam basic');

  const tmp = snapshot('tmp', { title: 'Sản phẩm tạm thời', categoryId: CAT_PHONE, price: 10_000 });
  await upsert(tmp);
  assert.equal((await search('q=tam%20thoi')).total, 1);
  await handleEvent(deps, createEvent('product.deleted', 'catalog', tmp.id, { productId: tmp.id }));
  assert.equal((await search('q=tam%20thoi')).total, 0);

  await handleEvent(deps, createEvent('product.rating_changed', 'review', ids['quan-jean'], { productId: ids['quan-jean'], ratingAvg: 5, ratingCount: 3 }));
  assert.equal((await search(`shopId=${SHOP_B}`)).items[0].ratingAvg, 5);

  // catalog chết → vẫn index được theo danh mục lá
  catalogDown = true;
  await upsert(snapshot('op-lung', { title: 'Ốp lưng điện thoại', categoryId: CAT_PHONE, price: 50_000 }));
  catalogDown = false;
  assert.equal((await search(`categoryId=${CAT_PHONE}&q=op%20lung`)).total, 1);
  assert.equal((await search(`categoryId=${ROOT_ELEC}&q=op%20lung`)).total, 0);
});

test('stock.changed → inStock theo product (kể cả khi tồn đến trước sản phẩm)', async () => {
  const sku = `${ids['ao-khoac']}-sku1`;
  await handleEvent(deps, createEvent('stock.changed', 'inventory', sku, { skuId: sku, available: 0 }));
  const r = await search('q=ao%20khoac');
  assert.equal(r.items[0].inStock, false);
  assert.equal((await search('q=ao%20khoac&inStock=true')).total, 0);
  await handleEvent(deps, createEvent('stock.changed', 'inventory', sku, { skuId: sku, available: 7 }));
  assert.equal((await search('q=ao%20khoac')).items[0].inStock, true);

  const early = snapshot('mu', { title: 'Mũ lưỡi trai', categoryId: CAT_SHIRT, price: 99_000 });
  await handleEvent(deps, createEvent('stock.changed', 'inventory', `${early.id}-sku1`, { skuId: `${early.id}-sku1`, available: 0 }));
  await upsert(early);
  assert.equal((await search('q=mu%20luoi')).items[0].inStock, false);
});

test('suggest: tiền tố tiêu đề + truy vấn phổ biến', async () => {
  const hits = async () => (await pool.query(`SELECT q, hits FROM search_queries WHERE q_folded = 'ao thun'`)).rows[0];
  const before = (await hits())?.hits ?? 0;
  for (let i = 0; i < 3; i++) await search(`q=${encodeURIComponent('áo thun')}`);
  await search('q=ao%20thun');
  await search('q=ao%20thun&page=2'); // chỉ trang 1 mới đếm
  // recordQuery chạy nền sau khi trả response → chờ ghi xong
  let row = await hits();
  for (let i = 0; i < 100 && row.hits - before < 4; i++) {
    await new Promise((r) => setTimeout(r, 20));
    row = await hits();
  }
  assert.equal(row.q, 'áo thun', 'giữ bản có dấu');
  assert.equal(row.hits - before, 4);
  const s = (await app.inject({ method: 'GET', url: '/suggest?q=ao%20th' })).json();
  assert.equal(s.suggestions[0], 'áo thun');
  assert.ok(s.suggestions.includes('Áo thun cotton nam basic'));
  const mid = (await app.inject({ method: 'GET', url: `/suggest?q=${encodeURIComponent('jean')}` })).json();
  assert.ok(mid.suggestions.includes('Quần jean ống đứng'), 'khớp tiền tố của từ giữa câu');
  const popular = (await app.inject({ method: 'GET', url: '/suggest' })).json();
  assert.equal(popular.suggestions[0], 'áo thun');
  const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  assert.match(metrics, /search_requests_total\{.*engine="postgres"/);
});
