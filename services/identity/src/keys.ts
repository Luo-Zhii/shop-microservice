import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, createLocalJWKSet, exportJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';
import { newId, withTx, type Logger, type Pool } from '@shopnow/platform';

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JWK;
}

export interface AccessClaims {
  sub: string;
  email: string;
  roles: string[];
  shopId?: string | null;
}

async function fromPem(pem: string): Promise<SigningKey> {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('JWT_PRIVATE_KEY phải là khoá RSA');
  const jwk = await exportJWK(createPublicKey(privateKey));
  const kid = await calculateJwkThumbprint(jwk);
  return { kid, privateKey, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

/**
 * Nạp khoá ký JWT: ưu tiên JWT_PRIVATE_KEY (PEM), không có thì đọc bảng signing_keys,
 * bảng trống thì sinh RSA-2048 dưới advisory lock (nhiều replica khởi động cùng lúc vẫn chỉ sinh 1 khoá).
 */
export async function loadKeyStore(pool: Pool, opts: { privateKeyPem?: string; issuer: string; audience: string; log?: Logger }) {
  let keys: SigningKey[];
  if (opts.privateKeyPem?.trim()) {
    keys = [await fromPem(opts.privateKeyPem.replace(/\\n/g, '\n'))];
    opts.log?.info({ kid: keys[0].kid }, 'dùng khoá ký từ JWT_PRIVATE_KEY');
  } else {
    const pems = await withTx(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727275)');
      let { rows } = await c.query('SELECT private_pem FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC');
      if (rows.length === 0) {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const k = await fromPem(pem);
        await c.query('INSERT INTO signing_keys (kid, private_pem) VALUES ($1,$2)', [k.kid, pem]);
        opts.log?.info({ kid: k.kid }, 'đã sinh khoá ký JWT mới');
        rows = [{ private_pem: pem }];
      }
      return rows.map((r) => r.private_pem as string);
    });
    keys = await Promise.all(pems.map(fromPem));
  }
  const active = keys[0];
  const jwks = { keys: keys.map((k) => k.publicJwk) };
  const keySet = createLocalJWKSet(jwks);

  async function signAccess(claims: AccessClaims, ttlSeconds: number) {
    return new SignJWT({ email: claims.email, roles: claims.roles, ...(claims.shopId ? { shopId: claims.shopId } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: active.kid, typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(opts.issuer)
      .setAudience(opts.audience)
      .setIssuedAt()
      .setJti(newId())
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(active.privateKey);
  }

  async function verify(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, keySet, { issuer: opts.issuer, audience: opts.audience, algorithms: ['RS256'] });
    return payload;
  }

  return { kid: active.kid, jwks: () => jwks, signAccess, verify };
}
export type KeyStore = Awaited<ReturnType<typeof loadKeyStore>>;
