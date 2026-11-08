import { forbidden, unauthorized, type Auth, type AuthUser, type FastifyReply, type FastifyRequest } from '@shopnow/platform';
import type { Role } from '@shopnow/contracts';
import type { KeyStore } from './keys';

/**
 * identity tự xác minh token bằng khoá của chính nó (không gọi JWKS qua HTTP tới bản thân).
 * Cùng giao diện với createAuth() của platform.
 */
export function createLocalAuth(keys: KeyStore, internalToken: string): Auth {
  async function verify(token: string): Promise<AuthUser> {
    const p = await keys.verify(token);
    return {
      id: String(p.sub),
      email: String(p.email ?? ''),
      roles: (Array.isArray(p.roles) ? p.roles : ['buyer']) as Role[],
      shopId: typeof p.shopId === 'string' ? p.shopId : undefined,
    };
  }
  async function authenticate(req: FastifyRequest, _reply?: FastifyReply) {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw unauthorized();
    try {
      req.user = await verify(h.slice(7));
    } catch {
      throw unauthorized('Token không hợp lệ hoặc đã hết hạn');
    }
  }
  async function optionalAuth(req: FastifyRequest) {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return;
    req.user = await verify(h.slice(7)).catch(() => undefined);
  }
  function requireRole(...roles: Role[]) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) await authenticate(req, reply);
      if (!req.user!.roles.some((r) => roles.includes(r))) throw forbidden();
    };
  }
  async function internalOnly(req: FastifyRequest) {
    if (req.headers['x-internal-token'] !== internalToken) throw forbidden('Chỉ dành cho service nội bộ');
  }
  return { verify, authenticate, optionalAuth, requireRole, internalOnly };
}
