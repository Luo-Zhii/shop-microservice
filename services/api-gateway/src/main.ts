import '@shopnow/platform/otel';
import Redis from 'ioredis';
import { createAuth, createService } from '@shopnow/platform';
import { cfg, upstreamsFrom } from './config';
import { buildGateway } from './gateway';

async function main() {
  // SSE cần kết nối dài: tắt requestTimeout mặc định của Node cho gateway
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS, fastify: { requestTimeout: 0, keepAliveTimeout: 65_000 } });
  const { app, log } = svc;

  // enableOfflineQueue=false: Redis chết thì lệnh lỗi ngay → rate limit bỏ qua (skipOnError) thay vì treo request
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 });
  redis.on('error', (err) => log.warn({ err: err.message }, 'redis lỗi'));

  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });
  await buildGateway(app, {
    auth,
    upstreams: upstreamsFrom(cfg),
    redis,
    rateLimit: { enabled: cfg.RATE_LIMIT_ENABLED, globalMax: cfg.RATE_LIMIT_GLOBAL, authMax: cfg.RATE_LIMIT_AUTH },
    bffTimeoutMs: cfg.BFF_TIMEOUT_MS,
    statusTimeoutMs: cfg.STATUS_TIMEOUT_MS,
  });

  // Không gắn Redis vào readiness: Redis chết gateway vẫn phục vụ (rate limit tạm bỏ qua)
  svc.onShutdown(() => redis.disconnect());
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('api-gateway không khởi động được', err);
  process.exit(1);
});
