import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAuth, createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb, startTestJwks } from '@shopnow/platform/testing';
import { registerRoutes } from '../src/routes';
import { createSealer } from '../src/crypto';

let pool: Pool;
let jwks: Awaited<ReturnType<typeof startTestJwks>>;
const sealer = createSealer('test-kyc-key-0123456789');
const app = createService('seller-test').app;
const OWNER = newId();
const OTHER = newId();
let owner: string;
let other: string;
let adminT: string;

before(async () => {
  jwks = await startTestJwks();
  pool = await freshTestDb('seller_test', join(__dirname, '../migrations'));
  registerRoutes(app, { pool, auth: createAuth(jwks.authOptions), sealer });
  await app.ready();
  owner = await jwks.sign(OWNER);
  other = await jwks.sign(OTHER);
  adminT = await jwks.sign(newId(), ['admin']);
});
after(async () => {
  await app.close();
  await pool.end();
  await jwks.close();
});

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });

const application = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: 'Chuyên đồ công nghệ chính hãng',
  phone: '0912345678',
  pickupAddress: { line1: '1 Lê Lợi', ward: 'Bến Nghé', district: 'Quận 1', province: 'TP. Hồ Chí Minh' },
  kyc: { legalName: 'Công ty TNHH ABC', taxCode: '0312345678', idNumber: '001099012345' },
  bankAccount: { bankName: 'Vietcombank', accountNumber: '0071000123456', holder: 'NGUYEN VAN A' },
  ...extra,
});

const events = async (shopId: string) =>
  (await pool.query(`SELECT payload->>'type' t, payload->'data' d FROM outbox WHERE key = $1 ORDER BY created_at`, [shopId])).rows;

test('mở shop: KYC che + mã hoá, slug từ tên, mỗi user 1 shop, shop.submitted', async () => {
  const r = await req('POST', '/shops', owner, application('Đồ Công Nghệ Xịn'));
  assert.equal(r.statusCode, 201, r.body);
  const s = r.json();
  assert.equal(s.slug, 'do-cong-nghe-xin');
  assert.equal(s.status, 'PENDING');
  assert.equal(s.kyc.idNumber, '****2345');
  assert.equal(s.bankAccount.accountNumber, '****3456');
  assert.equal(s.pickupProvince, 'TP. Hồ Chí Minh');
  assert.ok(!r.body.includes('001099012345') && !r.body.includes('0071000123456'));

  // Lưu dạng mã hoá, giải mã được bằng đúng khoá
  const raw = (await pool.query('SELECT id_number_enc, bank_account_enc FROM shops WHERE id = $1', [s.id])).rows[0];
  assert.ok(raw.id_number_enc.startsWith('v1:'));
  assert.equal(sealer.open(raw.id_number_enc), '001099012345');
  assert.equal(sealer.open(raw.bank_account_enc), '0071000123456');

  assert.equal((await req('POST', '/shops', owner, application('Shop Thứ Hai'))).statusCode, 409);
  // KYC dạng phẳng cũng nhận; trùng tên → slug có hậu tố
  const flat = application('Đồ Công Nghệ Xịn', { kyc: undefined, legalName: 'Hộ KD B', idNumber: '123456789' });
  const r2 = await req('POST', '/shops', other, flat);
  assert.equal(r2.statusCode, 201, r2.body);
  assert.equal(r2.json().slug, 'do-cong-nghe-xin-2');
  assert.equal(r2.json().kyc.idNumber, '****6789');

  const bad = await req('POST', '/shops', await jwks.sign(newId()), application('X'));
  assert.equal(bad.statusCode, 400);
  assert.equal((await req('POST', '/shops', undefined, application('Không token'))).statusCode, 401);

  const ev = await events(s.id);
  assert.deepEqual(ev.map((e) => e.t), ['shop.submitted']);
  assert.deepEqual(Object.keys(ev[0].d).sort(), ['createdAt', 'id', 'name', 'ownerId', 'pickupProvince', 'slug', 'status']);
  assert.equal(ev[0].d.ownerId, OWNER);

  assert.equal((await req('GET', '/shops/me', owner)).json().id, s.id);
  assert.equal((await req('GET', '/shops/me', await jwks.sign(newId()))).statusCode, 404);
});

test('buyer không duyệt được; admin từ chối (lý do) → sửa → nộp lại → duyệt → khoá → mở lại', async () => {
  const me = (await req('GET', '/shops/me', owner)).json();
  assert.equal((await req('POST', `/admin/shops/${me.id}/approve`, owner)).statusCode, 403);
  assert.equal((await req('GET', '/admin/shops?status=PENDING', other)).statusCode, 403);
  // Chưa duyệt → không công khai
  assert.equal((await req('GET', `/shops/${me.slug}`)).statusCode, 404);

  assert.equal((await req('POST', `/admin/shops/${me.id}/reject`, adminT, {})).statusCode, 400);
  const rej = await req('POST', `/admin/shops/${me.id}/reject`, adminT, { reason: 'Ảnh CCCD mờ' });
  assert.equal(rej.statusCode, 200, rej.body);
  assert.equal(rej.json().rejectReason, 'Ảnh CCCD mờ');
  assert.equal((await req('POST', `/admin/shops/${me.id}/suspend`, adminT)).statusCode, 409);

  const upd = await req('PUT', '/shops/me', owner, { name: 'Đồ Công Nghệ Chuẩn', kyc: { legalName: 'Công ty TNHH ABC', idNumber: '001099099999' } });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().status, 'PENDING');
  assert.equal(upd.json().slug, 'do-cong-nghe-chuan');
  assert.equal(upd.json().kyc.idNumber, '****9999');

  const pending = (await req('GET', '/admin/shops?status=PENDING', adminT)).json();
  assert.ok(pending.items.some((x: { id: string }) => x.id === me.id));

  const ok = await req('POST', `/admin/shops/${me.id}/approve`, adminT);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'APPROVED');
  assert.equal((await req('POST', `/admin/shops/${me.id}/approve`, adminT)).statusCode, 409);

  const pub = await req('GET', '/shops/do-cong-nghe-chuan');
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.json().kyc, undefined);
  assert.equal(pub.json().ownerId, undefined);
  assert.equal((await req('GET', `/shops/${me.id}`)).statusCode, 200);

  // Đã duyệt: đổi tên giữ slug, phát shop.updated
  const renamed = (await req('PUT', '/shops/me', owner, { name: 'Đồ Công Nghệ Chuẩn VN' })).json();
  assert.equal(renamed.slug, 'do-cong-nghe-chuan');

  assert.equal((await req('POST', `/admin/shops/${me.id}/suspend`, adminT, { reason: 'Bán hàng giả' })).json().status, 'SUSPENDED');
  assert.equal((await req('GET', `/shops/${me.id}`)).statusCode, 404);
  assert.equal((await req('POST', `/admin/shops/${me.id}/approve`, adminT)).json().status, 'APPROVED');

  const ev = await events(me.id);
  assert.deepEqual(ev.map((e) => e.t), ['shop.submitted', 'shop.rejected', 'shop.submitted', 'shop.approved', 'shop.updated', 'shop.suspended', 'shop.approved']);
  assert.equal(ev[1].d.reason, 'Ảnh CCCD mờ');
  assert.equal(ev[3].d.status, 'APPROVED');

  const detail = (await req('GET', `/admin/shops/${me.id}`, adminT)).json();
  assert.equal(detail.history.length, 6);

  const internal = await app.inject({ method: 'GET', url: `/internal/shops/${me.id}`, headers: { 'x-internal-token': 'test-internal' } });
  assert.deepEqual(internal.json(), { id: me.id, ownerId: OWNER, name: 'Đồ Công Nghệ Chuẩn VN', status: 'APPROVED', pickupProvince: 'TP. Hồ Chí Minh' });
  assert.equal((await req('GET', `/internal/shops/${me.id}`, adminT)).statusCode, 403);
});

test('theo dõi shop: followerCount, idempotent, không tự theo dõi, shop chưa duyệt → 404', async () => {
  const me = (await req('GET', '/shops/me', owner)).json();
  const pendingShop = (await req('GET', '/shops/me', other)).json();
  const f1 = await req('POST', `/shops/${me.id}/follow`, other);
  assert.equal(f1.statusCode, 200, f1.body);
  assert.deepEqual(f1.json(), { following: true, followerCount: 1 });
  assert.equal((await req('POST', `/shops/${me.id}/follow`, other)).json().followerCount, 1);
  const third = await jwks.sign(newId());
  assert.equal((await req('POST', `/shops/${me.id}/follow`, third)).json().followerCount, 2);
  assert.equal((await req('POST', `/shops/${me.id}/follow`, owner)).statusCode, 400);
  assert.equal((await req('POST', `/shops/${pendingShop.id}/follow`, owner)).statusCode, 404);

  assert.equal((await req('GET', `/shops/${me.id}`, other)).json().following, true);
  assert.equal((await req('GET', `/shops/${me.id}`)).json().following, false);
  assert.equal((await req('GET', '/me/following-shops', other)).json().total, 1);

  assert.deepEqual((await req('DELETE', `/shops/${me.id}/follow`, other)).json(), { following: false, followerCount: 1 });
  assert.equal((await req('DELETE', `/shops/${me.id}/follow`, other)).json().followerCount, 1);
  assert.equal((await req('GET', '/shops?q=chuẩn')).json().total, 1);
});
