import '@shopnow/platform/otel';
import { join } from 'node:path';
import { createPool, createService, ensureDatabase, EventBus, migrate, startOutboxRelay } from '@shopnow/platform';
import { ALL_TOPICS } from '@shopnow/contracts';
import { cfg } from './config';
import { registerRoutes } from './routes';
import { registerConsumers } from './consumers';
import { loadKeyStore } from './keys';
import { createLocalAuth } from './local-auth';
import { createGoogleExchanger } from './google';
import { seedAdmin } from './seed';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  await ensureDatabase(cfg.DATABASE_URL, log);
  const pool = createPool(cfg.DATABASE_URL);
  await migrate(pool, join(__dirname, '../migrations'), log);

  const keys = await loadKeyStore(pool, { privateKeyPem: cfg.JWT_PRIVATE_KEY, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, log });
  const auth = createLocalAuth(keys, cfg.INTERNAL_TOKEN);
  const google =
    cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET ? createGoogleExchanger(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET) : undefined;
  if (cfg.DEV_EXPOSE_OTP) log.warn('DEV_EXPOSE_OTP=true — OTP được trả trong response, KHÔNG dùng ở production');

  // Seed admin ghi outbox (user.registered) nên chạy trước relay là đủ
  await seedAdmin(pool, cfg.ADMIN_EMAIL, cfg.ADMIN_PASSWORD, log);

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics(ALL_TOPICS);
  const stopRelay = startOutboxRelay(pool, bus, log);
  await registerConsumers(bus, pool);

  registerRoutes(app, { pool, auth, keys, settings: cfg, google });
  svc.addReadiness('postgres', () => pool.query('SELECT 1'));
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    stopRelay();
    await bus.stop();
    await pool.end();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('identity không khởi động được', err);
  process.exit(1);
});
