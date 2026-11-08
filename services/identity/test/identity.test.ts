import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { createService, newId, type Pool } from '@shopnow/platform';
import { freshTestDb } from '@shopnow/platform/testing';
import { registerRoutes } from '../src/routes';
import { loadKeyStore, type KeyStore } from '../src/keys';
import { createLocalAuth } from '../src/local-auth';
import { seedAdmin } from '../src/seed';
import { handleShopEvent } from '../src/consumers';
import { totp } from '../src/totp';
import type { Settings } from '../src/config';

const settings: Settings = {
  JWT_ISSUER: 'shopnow-identity',
  JWT_AUDIENCE: 'shopnow',
  INTERNAL_TOKEN: 'test-internal',
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  OTP_TTL_SECONDS: 600,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_COOLDOWN_SECONDS: 0,
  LOGIN_MAX_FAILED: 5,
  LOGIN_LOCK_MINUTES: 15,
  DEV_EXPOSE_OTP: true,
  TOTP_ISSUER: 'ShopNow',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
};

let pool: Pool;
let keys: KeyStore;
const app = createService('identity-test').app;

before(async () => {
  pool = await freshTestDb('identity_test', join(__dirname, '../migrations'));
  keys = await loadKeyStore(pool, { issuer: settings.JWT_ISSUER, audience: settings.JWT_AUDIENCE });
  await seedAdmin(pool, 'admin@shopnow.local', 'Admin@12345');
  const google = async (code: string) => ({ sub: `g-${code}`, email: `${code}@gmail.com`, emailVerified: true, name: 'Google User' });
  registerRoutes(app, { pool, auth: createLocalAuth(keys, settings.INTERNAL_TOKEN), keys, settings, google });
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
});

const post = (url: string, payload?: unknown, token?: string) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const get = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function registerVerified(email: string, password = 'Matkhau123') {
  const r = await post('/auth/register', { email, password, fullName: 'Nguyễn Văn A' });
  assert.equal(r.statusCode, 201, r.body);
  const { userId, devOtp } = r.json();
  assert.equal((await post('/auth/verify-email', { email, code: devOtp })).statusCode, 200);
  return userId as string;
}
async function login(email: string, password = 'Matkhau123', totpCode?: string) {
  return post('/auth/login', { email, password, ...(totpCode ? { totp: totpCode } : {}) });
}

test('đăng ký → OTP sai 5 lần bị khoá → gửi lại → xác thực → đăng nhập, JWT RS256 hợp lệ qua JWKS', async () => {
  const reg = await post('/auth/register', { email: 'Buyer1@Test.local', password: 'Matkhau123', fullName: 'Người Mua' });
  assert.equal(reg.statusCode, 201, reg.body);
  const { userId, devOtp } = reg.json();
  assert.match(devOtp, /^\d{6}$/);

  const dup = await post('/auth/register', { email: 'buyer1@test.local', password: 'Matkhau123', fullName: 'Trùng' });
  assert.equal(dup.statusCode, 409);
  assert.equal((await post('/auth/register', { email: 'x@test.local', password: 'ngan', fullName: 'AB' })).statusCode, 400);

  const ev = await pool.query(`SELECT payload->>'type' t, payload->'data' d FROM outbox WHERE key = $1 ORDER BY created_at`, [userId]);
  assert.deepEqual(ev.rows.map((r) => r.t), ['user.registered', 'user.otp_requested']);
  assert.equal(ev.rows[1].d.purpose, 'verify_email');
  assert.equal(ev.rows[1].d.code, devOtp);
  // OTP chỉ lưu bản băm
  const stored = await pool.query('SELECT code_hash FROM otp_codes WHERE user_id = $1', [userId]);
  assert.notEqual(stored.rows[0].code_hash, devOtp);

  const notVerified = await login('buyer1@test.local');
  assert.equal(notVerified.statusCode, 403);
  assert.equal(notVerified.json().error.details.reason, 'EMAIL_NOT_VERIFIED');

  const wrong = devOtp === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 5; i++) {
    const r = await post('/auth/verify-email', { email: 'buyer1@test.local', code: wrong });
    assert.equal(r.statusCode, i < 5 ? 400 : 429, `lần ${i}: ${r.body}`);
  }
  // Mã đúng cũng bị từ chối sau 5 lần sai
  const locked = await post('/auth/verify-email', { email: 'buyer1@test.local', code: devOtp });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error.code, 'RATE_LIMITED');

  const resend = await post('/auth/resend-otp', { email: 'buyer1@test.local' });
  assert.equal(resend.statusCode, 200);
  assert.equal((await post('/auth/verify-email', { email: 'buyer1@test.local', code: resend.json().devOtp })).statusCode, 200);

  const ok = await login('buyer1@test.local');
  assert.equal(ok.statusCode, 200, ok.body);
  const s = ok.json();
  assert.equal(s.expiresIn, 900);
  assert.deepEqual(s.user.roles, ['buyer']);

  const jwks = (await get('/.well-known/jwks.json')).json();
  assert.equal(decodeProtectedHeader(s.accessToken).kid, jwks.keys[0].kid);
  const { payload } = await jwtVerify(s.accessToken, createLocalJWKSet(jwks), { issuer: 'shopnow-identity', audience: 'shopnow' });
  assert.equal(payload.sub, userId);
  assert.equal(payload.email, 'buyer1@test.local');
  assert.deepEqual(payload.roles, ['buyer']);
  assert.equal(payload.shopId, undefined);
  assert.equal((payload.exp as number) - (payload.iat as number), 900);

  const me = await get('/auth/me', s.accessToken);
  assert.equal(me.json().email, 'buyer1@test.local');
  assert.equal((await get('/auth/me')).statusCode, 401);
  assert.equal((await get('/auth/me', 'abc.def.ghi')).statusCode, 401);
});

test('refresh xoay vòng; dùng lại token cũ → thu hồi cả family', async () => {
  await registerVerified('rot@test.local');
  const s1 = (await login('rot@test.local')).json();
  const r2 = await post('/auth/refresh', { refreshToken: s1.refreshToken });
  assert.equal(r2.statusCode, 200, r2.body);
  const s2 = r2.json();
  assert.notEqual(s2.refreshToken, s1.refreshToken);

  const reuse = await post('/auth/refresh', { refreshToken: s1.refreshToken });
  assert.equal(reuse.statusCode, 401);
  assert.equal(reuse.json().error.details.reason, 'TOKEN_REUSED');
  // Token mới nhất cùng họ cũng chết
  assert.equal((await post('/auth/refresh', { refreshToken: s2.refreshToken })).statusCode, 401);

  // Phiên khác (family khác) không ảnh hưởng; logout thu hồi phiên đó
  const other = (await login('rot@test.local')).json();
  assert.equal((await post('/auth/logout', { refreshToken: other.refreshToken })).statusCode, 200);
  assert.equal((await post('/auth/refresh', { refreshToken: other.refreshToken })).statusCode, 401);
  assert.equal((await post('/auth/refresh', { refreshToken: 'x'.repeat(43) })).statusCode, 401);
});

test('sai mật khẩu 5 lần → khoá 15 phút, mật khẩu đúng cũng bị chặn', async () => {
  await registerVerified('lock@test.local');
  for (let i = 1; i <= 5; i++) {
    const r = await login('lock@test.local', 'SaiMatKhau1');
    assert.equal(r.statusCode, i < 5 ? 401 : 429, `lần ${i}: ${r.body}`);
  }
  const blocked = await login('lock@test.local');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.details.reason, 'ACCOUNT_LOCKED');
  // Hết 15 phút → đăng nhập lại được
  await pool.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE email = 'lock@test.local'`);
  assert.equal((await login('lock@test.local')).statusCode, 200);
  // Email không tồn tại → 401 chung chung
  assert.equal((await login('khongco@test.local')).statusCode, 401);
});

test('quên mật khẩu → OTP → đặt lại, phiên cũ bị thu hồi', async () => {
  await registerVerified('forgot@test.local');
  const old = (await login('forgot@test.local')).json();
  assert.equal((await post('/auth/forgot-password', { email: 'khongton@test.local' })).json().ok, true);
  const f = await post('/auth/forgot-password', { email: 'forgot@test.local' });
  const code = f.json().devOtp;
  assert.match(code, /^\d{6}$/);
  const ev = await pool.query(`SELECT payload->'data'->>'purpose' p FROM outbox WHERE payload->>'type' = 'user.otp_requested' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(ev.rows[0].p, 'reset_password');

  const bad = await post('/auth/reset-password', { email: 'forgot@test.local', code: code === '999999' ? '123456' : '999999', newPassword: 'MoiMoi456' });
  assert.equal(bad.statusCode, 400);
  assert.equal((await post('/auth/reset-password', { email: 'forgot@test.local', code, newPassword: 'MoiMoi456' })).statusCode, 200);
  // Mã đã dùng không dùng lại được
  assert.equal((await post('/auth/reset-password', { email: 'forgot@test.local', code, newPassword: 'MoiMoi789' })).statusCode, 400);
  assert.equal((await post('/auth/refresh', { refreshToken: old.refreshToken })).statusCode, 401);
  assert.equal((await login('forgot@test.local')).statusCode, 401);
  assert.equal((await login('forgot@test.local', 'MoiMoi456')).statusCode, 200);
});

test('2FA TOTP: setup → enable → đăng nhập bắt buộc mã, không dùng lại mã cũ', async () => {
  await registerVerified('totp@test.local');
  const t = (await login('totp@test.local')).json().accessToken;
  const setup = (await post('/auth/2fa/setup', {}, t)).json();
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.ok(setup.otpauthUrl.startsWith('otpauth://totp/ShopNow%3Atotp%40test.local?secret='));
  assert.equal((await post('/auth/2fa/enable', { code: '000000' }, t)).statusCode, 400);
  const now = totp(setup.secret);
  assert.equal((await post('/auth/2fa/enable', { code: now }, t)).statusCode, 200);

  const need = await login('totp@test.local');
  assert.equal(need.statusCode, 401);
  assert.equal(need.json().error.details.reason, 'TOTP_REQUIRED');
  // Cùng mã vừa dùng để bật → bị từ chối (chống replay)
  assert.equal((await login('totp@test.local', 'Matkhau123', now)).statusCode, 401);
  const next = totp(setup.secret, Date.now() + 30_000);
  const ok = await login('totp@test.local', 'Matkhau123', next);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().user.totpEnabled, true);
});

test('consumer shop.approved → role seller + shopId (idempotent); shop.suspended → thu role', async () => {
  const userId = await registerVerified('owner@test.local');
  const s1 = (await login('owner@test.local')).json();
  const shopId = newId();
  const shop = { id: shopId, ownerId: userId, name: 'Shop A', slug: 'shop-a', status: 'APPROVED' as const, pickupProvince: 'Hà Nội', createdAt: new Date().toISOString() };
  const ev = { id: newId(), type: 'shop.approved', source: 'seller', time: new Date().toISOString(), subject: shopId, data: shop };
  await handleShopEvent(pool, ev);
  await handleShopEvent(pool, ev); // bản trùng
  const granted = await pool.query(`SELECT payload->'data' d FROM outbox WHERE payload->>'type' = 'user.role_granted' AND key = $1`, [userId]);
  assert.equal(granted.rows.length, 1);
  assert.deepEqual(granted.rows[0].d, { userId, role: 'seller', shopId });

  // refresh đọc lại roles từ DB
  const s2 = (await post('/auth/refresh', { refreshToken: s1.refreshToken })).json();
  const p = await keys.verify(s2.accessToken);
  assert.deepEqual(p.roles, ['buyer', 'seller']);
  assert.equal(p.shopId, shopId);

  await handleShopEvent(pool, { ...ev, id: newId(), type: 'shop.suspended', data: { ...shop, status: 'SUSPENDED' } });
  const s3 = (await post('/auth/refresh', { refreshToken: s2.refreshToken })).json();
  const p3 = await keys.verify(s3.accessToken);
  assert.deepEqual(p3.roles, ['buyer']);
  assert.equal(p3.shopId, undefined);
});

test('admin: liệt kê / tìm user, khoá & mở khoá; buyer bị 403; /internal/users', async () => {
  const victimId = await registerVerified('victim@test.local');
  const victim = (await login('victim@test.local')).json();
  const adminLogin = await login('admin@shopnow.local', 'Admin@12345');
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  const adminToken = adminLogin.json().accessToken;
  assert.deepEqual(adminLogin.json().user.roles, ['admin']);

  assert.equal((await get('/admin/users', victim.accessToken)).statusCode, 403);
  const list = (await get('/admin/users?q=victim&page=1&pageSize=5', adminToken)).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].email, 'victim@test.local');
  assert.equal(list.pageSize, 5);

  assert.equal((await post(`/admin/users/${victimId}/lock`, {}, adminToken)).statusCode, 200);
  assert.equal((await login('victim@test.local')).statusCode, 403);
  assert.equal((await post('/auth/refresh', { refreshToken: victim.refreshToken })).statusCode, 401);
  assert.equal((await post(`/admin/users/${victimId}/unlock`, {}, adminToken)).statusCode, 200);
  assert.equal((await login('victim@test.local')).statusCode, 200);
  assert.equal((await post(`/admin/users/${newId()}/lock`, {}, adminToken)).statusCode, 404);

  assert.equal((await get(`/internal/users/${victimId}`)).statusCode, 403);
  const internal = await app.inject({ method: 'GET', url: `/internal/users/${victimId}`, headers: { 'x-internal-token': 'test-internal' } });
  assert.deepEqual(internal.json(), { id: victimId, email: 'victim@test.local', fullName: 'Nguyễn Văn A', roles: ['buyer'] });
});

test('Google OAuth: url + callback tạo user mới, lần 2 đăng nhập cùng tài khoản', async () => {
  const u = (await get('/auth/google/url')).json();
  assert.ok(u.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?client_id=google-client'));
  const r1 = await post('/auth/google/callback', { code: 'gnew01' });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().user.email, 'gnew01@gmail.com');
  assert.equal(r1.json().user.emailVerified, true);
  const r2 = await post('/auth/google/callback', { code: 'gnew01' });
  assert.equal(r2.json().user.id, r1.json().user.id);
  const reg = await pool.query(`SELECT count(*)::int n FROM outbox WHERE payload->>'type' = 'user.registered' AND key = $1`, [r1.json().user.id]);
  assert.equal(reg.rows[0].n, 1);

  // Không cấu hình Google → 404
  const off = createService('identity-test-nogoogle').app;
  registerRoutes(off, { pool, auth: createLocalAuth(keys, 'x'), keys, settings: { ...settings, GOOGLE_CLIENT_ID: undefined } });
  await off.ready();
  assert.equal((await off.inject({ method: 'GET', url: '/auth/google/url' })).statusCode, 404);
  await off.close();
});

test('khoá ký được lưu DB: nạp lại vẫn cùng kid', async () => {
  const again = await loadKeyStore(pool, { issuer: 'shopnow-identity', audience: 'shopnow' });
  assert.equal(again.kid, keys.kid);
  const n = await pool.query('SELECT count(*)::int n FROM signing_keys');
  assert.equal(n.rows[0].n, 1);
});
