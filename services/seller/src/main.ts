import '@shopnow/platform/otel';
import { join } from 'node:path';
import { createAuth, createPool, createService, ensureDatabase, EventBus, migrate, startOutboxRelay } from '@shopnow/platform';
import { ALL_TOPICS } from '@shopnow/contracts';
import { cfg } from './config';
import { registerRoutes } from './routes';
import { createSealer } from './crypto';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  await ensureDatabase(cfg.DATABASE_URL, log);
  const pool = createPool(cfg.DATABASE_URL);
  await migrate(pool, join(__dirname, '../migrations'), log);

  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });
  if (cfg.NODE_ENV === 'production' && cfg.KYC_ENCRYPTION_KEY.startsWith('dev-only')) {
    throw new Error('KYC_ENCRYPTION_KEY chưa được cấu hình cho production');
  }

  // seller chỉ phát sự kiện (seller.shop.v1), không tiêu thụ topic nào
  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics(ALL_TOPICS);
  await bus.connectProducer();
  const stopRelay = startOutboxRelay(pool, bus, log);

  registerRoutes(app, { pool, auth, sealer: createSealer(cfg.KYC_ENCRYPTION_KEY) });
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
  console.error('seller không khởi động được', err);
  process.exit(1);
});
