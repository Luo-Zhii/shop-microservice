import '@shopnow/platform/otel';
import { join } from 'node:path';
import Redis from 'ioredis';
import { createAuth, createPool, createService, ensureDatabase, EventBus, migrate, startOutboxRelay } from '@shopnow/platform';
import { ALL_TOPICS } from '@shopnow/contracts';
import { cfg } from './config';
import { registerRoutes } from './routes';
import { registerConsumers } from './consumers';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  await ensureDatabase(cfg.DATABASE_URL, log);
  const pool = createPool(cfg.DATABASE_URL);
  await migrate(pool, join(__dirname, '../migrations'), log);

  const redis = new Redis(cfg.REDIS_URL, { keyPrefix: cfg.REDIS_KEY_PREFIX, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
  redis.on('error', (err) => log.warn({ err: err.message }, 'redis lỗi'));

  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });
  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics(ALL_TOPICS);
  const stopRelay = startOutboxRelay(pool, bus, log);
  await registerConsumers(bus, pool);

  registerRoutes(app, { pool, auth, redis });
  svc.addReadiness('postgres', () => pool.query('SELECT 1'));
  svc.addReadiness('redis', () => redis.ping());
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    stopRelay();
    await bus.stop();
    redis.disconnect();
    await pool.end();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('user-profile không khởi động được', err);
  process.exit(1);
});
