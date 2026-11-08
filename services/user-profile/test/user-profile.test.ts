import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Redis from 'ioredis';
import { createAuth, createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import { registerRoutes } from '../src/routes';
import { handleUserEvent } from '../src/consumers';

let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379', {
  keyPrefix: `user-profile-test:${newId()}:`,
  maxRetriesPerRequest: 1,
});
const app = createService('user-profile-test').app;
const A = newId();
const B = newId();
let ta: string;
let tb: string;

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('user_profile_test', join(__dirname, '../migrations'));
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), redis });
  await app.ready();
  ta = await jwks.sign(A);
  tb = await jwks.sign(B);
});
after(async () => {
  await redis.del(`rv:${A}`, `rv:${B}`);
  redis.disconnect();
  await app.close();
  await pool.end();
  await jwks.close();
});

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });

const addr = (i: number, extra: Record<string, unknown> = {}) => ({
  fullName: `Người nhận ${i}`,
  phone: '0912345678',
  line1: `${i} Trần Duy Hưng`,
  ward: 'Trung Hoà',
  district: 'Cầu Giấy',
  province: 'Hà Nội',
  ...extra,
});

test('user.registered → tạo hồ sơ (idempotent); GET/PUT /me/profile', async () => {
  const ev = { id: newId(), type: 'user.registered', source: 'identity', time: new Date().toISOString(), subject: A, data: { userId: A, email: 'a@test.local', fullName: 'Trần Thị A' } };
  await handleUserEvent(pool, ev);
  await handleUserEvent(pool, ev);
  const p = (await req('GET', '/me/profile', ta)).json();
  assert.equal(p.fullName, 'Trần Thị A');
  assert.equal(p.email, 'a@test.local');

  const put = await req('PUT', '/me/profile', ta, { phone: '0987654321', gender: 'female', birthday: '1999-02-28' });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().birthday, '1999-02-28');
  assert.equal(put.json().fullName, 'Trần Thị A');
  assert.equal((await req('PUT', '/me/profile', ta, { birthday: '2999-01-01' })).statusCode, 400);
  assert.equal((await req('PUT', '/me/profile', ta, { phone: 'abc' })).statusCode, 400);
  assert.equal((await req('PUT', '/me/profile', ta, { email: 'hack@x.y' })).statusCode, 400);
  assert.equal((await req('GET', '/me/profile')).statusCode, 401);

  // Hồ sơ tạo lười cho user chưa có sự kiện
  const pb = (await req('GET', '/me/profile', tb)).json();
  assert.equal(pb.userId, B);
  assert.equal(pb.email, `${B}@test.local`);
});

test('sổ địa chỉ: địa chỉ đầu tự mặc định, đổi mặc định bỏ cái cũ, tối đa 10, xoá mặc định thì chuyển', async () => {
  const first = (await req('POST', '/me/addresses', ta, addr(1))).json();
  assert.equal(first.isDefault, true);
  const second = await req('POST', '/me/addresses', ta, addr(2, { isDefault: true }));
  assert.equal(second.statusCode, 201);
  let list = (await req('GET', '/me/addresses', ta)).json().items;
  assert.equal(list.filter((a: { isDefault: boolean }) => a.isDefault).length, 1);
  assert.equal(list[0].id, second.json().id);

  // PUT đặt mặc định lại cho địa chỉ 1
  const upd = await req('PUT', `/me/addresses/${first.id}`, ta, addr(1, { line1: '1A Trần Duy Hưng', isDefault: true }));
  assert.equal(upd.json().isDefault, true);
  assert.equal(upd.json().line1, '1A Trần Duy Hưng');
  list = (await req('GET', '/me/addresses', ta)).json().items;
  assert.deepEqual(list.filter((a: { isDefault: boolean }) => a.isDefault).map((a: { id: string }) => a.id), [first.id]);

  for (let i = 3; i <= 10; i++) assert.equal((await req('POST', '/me/addresses', ta, addr(i))).statusCode, 201);
  const eleventh = await req('POST', '/me/addresses', ta, addr(11));
  assert.equal(eleventh.statusCode, 409);
  assert.equal(eleventh.json().error.code, 'CONFLICT');
  assert.equal((await req('POST', '/me/addresses', ta, addr(1, { phone: '123' }))).statusCode, 400);

  // Xoá địa chỉ mặc định → còn đúng 1 mặc định
  assert.equal((await req('DELETE', `/me/addresses/${first.id}`, ta)).statusCode, 200);
  list = (await req('GET', '/me/addresses', ta)).json().items;
  assert.equal(list.length, 9);
  assert.equal(list.filter((a: { isDefault: boolean }) => a.isDefault).length, 1);

  const setDef = await req('POST', `/me/addresses/${second.json().id}/default`, ta);
  assert.equal(setDef.json().isDefault, true);
});

test('user thứ 2 không thấy / sửa / xoá được địa chỉ của người khác; /internal/addresses', async () => {
  const mine = (await req('GET', '/me/addresses', ta)).json().items[0];
  assert.equal((await req('GET', '/me/addresses', tb)).json().items.length, 0);
  assert.equal((await req('GET', `/me/addresses/${mine.id}`, tb)).statusCode, 404);
  assert.equal((await req('PUT', `/me/addresses/${mine.id}`, tb, addr(9))).statusCode, 404);
  assert.equal((await req('DELETE', `/me/addresses/${mine.id}`, tb)).statusCode, 404);
  assert.equal((await req('GET', '/me/addresses/khong-phai-uuid', ta)).statusCode, 404);

  const internal = (userId: string, token?: string) =>
    app.inject({ method: 'GET', url: `/internal/addresses/${mine.id}?userId=${userId}`, headers: token ? { 'x-internal-token': token } : {} });
  assert.equal((await internal(A)).statusCode, 403);
  const ok = await internal(A, 'test-internal');
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(Object.keys(ok.json()).sort(), ['district', 'fullName', 'id', 'isDefault', 'line1', 'phone', 'province', 'userId', 'ward']);
  assert.equal((await internal(B, 'test-internal')).statusCode, 404);
});

test('wishlist thêm/kiểm tra/xoá, phân trang', async () => {
  assert.equal((await req('POST', '/me/wishlist', ta, { productId: 'p-1' })).statusCode, 201);
  assert.equal((await req('POST', '/me/wishlist', ta, { productId: 'p-1' })).statusCode, 200);
  await req('POST', '/me/wishlist', ta, { productId: 'p-2' });
  const w = (await req('GET', '/me/wishlist?pageSize=1', ta)).json();
  assert.equal(w.total, 2);
  assert.equal(w.items.length, 1);
  assert.equal((await req('GET', '/me/wishlist/p-1', ta)).json().inWishlist, true);
  assert.equal((await req('GET', '/me/wishlist/p-1', tb)).json().inWishlist, false);
  await req('DELETE', '/me/wishlist/p-1', ta);
  assert.equal((await req('GET', '/me/wishlist', ta)).json().total, 1);
  assert.equal((await req('POST', '/me/wishlist', ta, { productId: '../x' })).statusCode, 400);
});

test('recently viewed: mới nhất trước, không trùng, tối đa 50', async () => {
  for (let i = 1; i <= 55; i++) await req('POST', '/me/recently-viewed', ta, { productId: `p-${i}` });
  await req('POST', '/me/recently-viewed', ta, { productId: 'p-10' });
  const items: string[] = (await req('GET', '/me/recently-viewed', ta)).json().items;
  assert.equal(items.length, 50);
  assert.equal(items[0], 'p-10');
  assert.equal(items[1], 'p-55');
  assert.equal(new Set(items).size, 50);
  assert.equal((await req('GET', '/me/recently-viewed?limit=5', ta)).json().items.length, 5);
  assert.deepEqual((await req('GET', '/me/recently-viewed', tb)).json().items, []);
});
