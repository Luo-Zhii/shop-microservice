import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@shopnow/contracts';
import { forbidden, unauthorized } from './errors';

export interface AuthUser {
  id: string;
  email: string;
  roles: Role[];
  shopId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export interface AuthOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  internalToken: string;
}

export function createAuth(opts: AuthOptions) {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });

  async function verify(token: string): Promise<AuthUser> {
    const { payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audience });
    return toUser(payload);
  }

  function tokenFrom(req: FastifyRequest): string | undefined {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7);
    const q = (req.query as Record<string, unknown> | undefined)?.token;
    return typeof q === 'string' ? q : undefined;
  }

  /** preHandler: bắt buộc đăng nhập. */
  async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    const token = tokenFrom(req);
    if (!token) throw unauthorized();
    try {
      req.user = await verify(token);
    } catch {
      throw unauthorized('Token không hợp lệ hoặc đã hết hạn');
    }
  }

  /** preHandler: có token thì đọc, không có vẫn cho qua. */
  async function optionalAuth(req: FastifyRequest) {
    const token = tokenFrom(req);
    if (!token) return;
    try {
      req.user = await verify(token);
    } catch {
      /* bỏ qua token hỏng ở route công khai */
    }
  }

  function requireRole(...roles: Role[]) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) await authenticate(req, reply);
      if (!req.user!.roles.some((r) => roles.includes(r))) throw forbidden();
    };
  }

  /** preHandler cho /internal/*: chỉ service nội bộ (header x-internal-token). */
  async function internalOnly(req: FastifyRequest) {
    if (req.headers['x-internal-token'] !== opts.internalToken) throw forbidden('Chỉ dành cho service nội bộ');
  }

  return { verify, authenticate, optionalAuth, requireRole, internalOnly };
}
export type Auth = ReturnType<typeof createAuth>;

function toUser(p: JWTPayload): AuthUser {
  return {
    id: String(p.sub),
    email: String(p.email ?? ''),
    roles: (Array.isArray(p.roles) ? p.roles : ['buyer']) as Role[],
    shopId: typeof p.shopId === 'string' ? p.shopId : undefined,
  };
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
