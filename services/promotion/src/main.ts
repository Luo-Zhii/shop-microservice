import '@shopnow/platform/otel';
import { join } from 'node:path';
import Redis from 'ioredis';
import { createAuth, createPool, createService, ensureDatabase, EventBus, migrate, startOutboxRelay } from '@shopnow/platform';
import { ALL_TOPICS } from '@shopnow/contracts';
import { cfg } from './config';
import { createFlashStore } from './flash';
import { registerRoutes } from './routes';
import { registerConsumers } from './consumers';
import { sweepStaleLocks } from './sweeper';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  await ensureDatabase(cfg.DATABASE_URL, log);
  const pool = createPool(cfg.DATABASE_URL);
  await migrate(pool, join(__dirname, '../migrations'), log);

  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on('error', (err) => log.warn({ err }, 'redis lỗi'));
  const flash = createFlashStore(redis, cfg.REDIS_PREFIX);
  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics(ALL_TOPICS);
  const stopRelay = startOutboxRelay(pool, bus, log);
  await registerConsumers(bus, { pool, flash, log });

  registerRoutes(app, { pool, auth, flash });
  const sweeper = setInterval(() => {
    sweepStaleLocks({ pool, flash }, cfg.LOCK_TTL_SECONDS)
      .then((r) => (r.vouchers || r.flashHolds) && log.info(r, 'đã nhả voucher/suất flash sale bị bỏ quên'))
      .catch((err) => log.warn({ err }, 'sweeper lỗi'));
  }, 60_000);
  svc.addReadiness('postgres', () => pool.query('SELECT 1'));
  svc.addReadiness('redis', () => redis.ping());
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    clearInterval(sweeper);
    stopRelay();
    await bus.stop();
    await pool.end();
    redis.disconnect();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('promotion không khởi động được', err);
  process.exit(1);
});
