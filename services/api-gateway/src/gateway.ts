import { createHash, timingSafeEqual } from 'node:crypto';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import type Redis from 'ioredis';
import { AppError, unauthorized, type Auth, type FastifyInstance, type FastifyRequest } from '@shopnow/platform';
import type { UpstreamName, Upstreams } from './config';
import { registerRum } from './rum';
import { registerBff } from './bff';

export interface GatewayOptions {
  auth: Pick<Auth, 'verify'>;
  upstreams: Upstreams;
  /** Không truyền → rate limit lưu trong bộ nhớ (chỉ đúng khi chạy 1 replica). */
  redis?: Redis;
  rateLimit: { enabled: boolean; globalMax: number; authMax: number; nameSpace?: string };
  bffTimeoutMs: number;
  statusTimeoutMs: number;
  /** Token robot giám sát tổng hợp; client thường không tự gắn được x-synthetic (header bị xoá nếu token sai/thiếu). */
  syntheticToken?: string;
}

/** So token hằng thời gian (không lộ độ dài khớp qua thời gian phản hồi). */
export function tokenMatches(given: unknown, expected: string | undefined): boolean {
  if (!expected || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const AUTH_PATH = /^\/api\/identity\/auth\//;
// Endpoint công khai của identity: FE hay gắn token cũ/hết hạn vào cả lúc refresh — không chặn 401 ở gateway
const PUBLIC_AUTH = /^\/api\/identity\/(auth\/(register|verify-email|resend-otp|login|refresh|logout|forgot-password|reset-password|google\/)|\.well-known\/)/;
const SSE_PATH = /^\/api\/notification\/notifications\/stream(\/|$)/;

const pathOf = (url: string) => url.split('?')[0];

/**
 * true nếu URL (sau khi giải mã, gộp "//", xử lý "." / "..") trỏ vào /api/<svc>/internal…
 * URL giải mã lỗi hoặc có "\" / "%2f" cũng chặn luôn cho chắc.
 */
export function isInternalPath(url: string): boolean {
  const raw = pathOf(url);
  if (/%2f|%5c|\\/i.test(raw)) return /internal/i.test(raw);
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return true;
  }
  p = p.replace(/\/{2,}/g, '/');
  const normalized = new URL(p, 'http://gateway.local').pathname.toLowerCase();
  return /^\/api\/[^/]+\/internal(\/|$)/.test(normalized);
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  // EventSource không gửi được header → SSE dùng ?token=
  if (SSE_PATH.test(pathOf(req.url))) {
    const t = (req.query as Record<string, unknown> | undefined)?.token;
    if (typeof t === 'string') return t;
  }
  return undefined;
}

export async function buildGateway(app: FastifyInstance, opts: GatewayOptions) {
  // 1) Rate limit (đăng ký trước mọi route để hook onRoute gắn vào tất cả)
  if (opts.rateLimit.enabled) {
    await app.register(rateLimit, {
      global: true,
      redis: opts.redis,
      nameSpace: opts.rateLimit.nameSpace ?? 'gw-rl:',
      skipOnError: true, // Redis chết thì cho qua, không làm sập gateway
      timeWindow: 60_000,
      max: async (req) => (AUTH_PATH.test(pathOf(req.url)) ? opts.rateLimit.authMax : opts.rateLimit.globalMax),
      keyGenerator: (req) => (AUTH_PATH.test(pathOf(req.url)) ? `auth:${req.ip}` : `ip:${req.ip}`),
      allowList: (req) => !req.url.startsWith('/api/'),
      errorResponseBuilder: (_req, ctx) =>
        new AppError('RATE_LIMITED', `Quá nhiều yêu cầu, vui lòng thử lại sau ${Math.max(1, Math.ceil(ctx.ttl / 1000))} giây`, {
          limit: ctx.max,
          retryAfterSeconds: Math.max(1, Math.ceil(ctx.ttl / 1000)),
        }),
    });
  }

  // 2) Chặn API nội bộ
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') && isInternalPath(req.url)) {
      throw new AppError('FORBIDDEN', 'Không được truy cập API nội bộ qua gateway');
    }
  });

  // 3) Có token thì phải hợp lệ (service phía sau vẫn tự xác minh — zero trust)
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || PUBLIC_AUTH.test(pathOf(req.url))) return;
    const token = bearer(req);
    if (!token) return;
    try {
      req.user = await opts.auth.verify(token);
    } catch {
      throw unauthorized('Token không hợp lệ hoặc đã hết hạn');
    }
  });

  // 3b) Cổng vận hành AIOps: chỉ admin, và không mở webhook/MCP ra ngoài (chỉ gọi trong cụm)
  app.addHook('preHandler', async (req) => {
    const path = pathOf(req.url);
    if (!path.startsWith('/api/aiops/')) return;
    // ngoại lệ DUY NHẤT: trang trạng thái cho khách — so khớp tuyệt đối (biến thể mã hoá / dot-segment vẫn bị chặn)
    if (req.method === 'GET' && path === '/api/aiops/status/public') return;
    if (/^\/api\/aiops\/(mcp|webhooks|metrics)(\/|$)/.test(path)) throw new AppError('FORBIDDEN', 'Endpoint chỉ dùng trong cụm');
    if (!req.user) throw unauthorized();
    if (!req.user.roles.includes('admin')) throw new AppError('FORBIDDEN', 'Chỉ quản trị viên');
  });

  // 4) Reverse proxy /api/<svc>/* → upstream (bỏ prefix)
  for (const [name, upstream] of Object.entries(opts.upstreams) as [UpstreamName, string][]) {
    const sse = name === 'notification';
    await app.register(proxy, {
      upstream,
      prefix: `/api/${name}`,
      rewritePrefix: '',
      http2: false,
      // SSE giữ kết nối lâu → không đặt bodyTimeout cho notification
      undici: { connections: 64, headersTimeout: 30_000, bodyTimeout: sse ? 0 : 60_000 },
      replyOptions: {
        rewriteRequestHeaders: (req, headers) => {
          const h: Record<string, string | string[] | undefined> = { ...headers };
          // Không tin header nhận dạng / bí mật nội bộ do client gửi
          delete h['x-internal-token'];
          delete h['x-user-id'];
          delete h['x-user-roles'];
          delete h['x-actor'];
          // lưu lượng robot tổng hợp: chỉ tin khi token đúng → upstream loại khỏi thống kê nghiệp vụ (vd truy vấn phổ biến)
          const synthetic = tokenMatches(headers['x-synthetic-token'], opts.syntheticToken);
          delete h['x-synthetic'];
          delete h['x-synthetic-token'];
          if (synthetic) h['x-synthetic'] = '1';
          h['x-request-id'] = req.id;
          h['x-forwarded-for'] = [headers['x-forwarded-for'], req.ip].filter(Boolean).join(', ');
          if (req.user) {
            h['x-user-id'] = req.user.id;
            h['x-user-roles'] = req.user.roles.join(',');
            if (name === 'aiops') h['x-actor'] = req.user.email || req.user.id; // audit trail của AIOps
          }
          return h;
        },
        rewriteHeaders: (headers) => {
          const h: Record<string, string | string[] | undefined> = {};
          // CORS do gateway quản lý; bỏ header CORS của upstream để không bị trùng
          for (const [k, v] of Object.entries(headers)) if (!k.toLowerCase().startsWith('access-control-')) h[k] = v as string | string[];
          if (String(headers['content-type'] ?? '').startsWith('text/event-stream')) {
            h['cache-control'] = 'no-cache, no-transform';
            h['x-accel-buffering'] = 'no'; // nginx/ingress không buffer SSE
          }
          return h;
        },
        onError: (reply, { error }) => {
          const timeout = /timeout/i.test(error.message) || (error as { code?: string }).code?.includes('TIMEOUT');
          reply.log.warn({ err: error, upstream: name }, 'proxy lỗi');
          void reply.status(timeout ? 504 : 502).send({
            error: { code: 'UPSTREAM_ERROR', message: `Dịch vụ ${name} ${timeout ? 'phản hồi quá chậm' : 'không khả dụng'}` },
          });
        },
      },
    });
  }

  // 5) BFF + trang trạng thái
  registerBff(app, { upstreams: opts.upstreams, timeoutMs: opts.bffTimeoutMs });
  registerRum(app);

  app.get('/api/status', async () => {
    const started = Date.now();
    const services = await Promise.all(
      (Object.entries(opts.upstreams) as [UpstreamName, string][]).map(async ([name, url]) => {
        const t0 = Date.now();
        try {
          const res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(opts.statusTimeoutMs) });
          const body = (await res.json().catch(() => null)) as { checks?: Record<string, string> } | null;
          return { name, url, status: res.ok ? 'up' : 'degraded', httpStatus: res.status, latencyMs: Date.now() - t0, checks: body?.checks ?? null };
        } catch (e) {
          return { name, url, status: 'down', httpStatus: null, latencyMs: Date.now() - t0, error: (e as Error).message };
        }
      }),
    );
    const up = services.filter((s) => s.status === 'up').length;
    return {
      status: up === services.length ? 'ok' : 'degraded',
      up,
      total: services.length,
      services,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  });
}
