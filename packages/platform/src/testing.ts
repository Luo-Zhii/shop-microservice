// Tiện ích cho test tích hợp: JWKS giả + ký JWT như identity, database test riêng.
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AddressInfo } from 'node:net';
import type { Role } from '@shopnow/contracts';
import { createPool, ensureDatabase, migrate } from './db';

export async function startTestJwks() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  const server: Server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
  async function sign(sub: string, roles: Role[] = ['buyer'], extra: Record<string, unknown> = {}) {
    return new SignJWT({ email: `${sub}@test.local`, roles, ...extra })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject(sub)
      .setIssuer('shopnow-identity')
      .setAudience('shopnow')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
  }
  return {
    url,
    sign,
    authOptions: { jwksUrl: url, issuer: 'shopnow-identity', audience: 'shopnow', internalToken: 'test-internal' },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Tạo database test sạch (DROP + CREATE) trên Postgres dev rồi chạy migrations. */
export async function freshTestDb(name: string, migrationsDir: string) {
  const base = process.env.TEST_DATABASE_URL ?? 'postgres://shopnow:shopnow@localhost:55432/postgres';
  const admin = createPool(base, 1);
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  const u = new URL(base);
  u.pathname = `/${name}`;
  await ensureDatabase(u.toString());
  const pool = createPool(u.toString(), 5);
  await migrate(pool, migrationsDir);
  return pool;
}
