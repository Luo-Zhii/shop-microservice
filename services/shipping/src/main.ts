import '@shopnow/platform/otel';
import { join } from 'node:path';
import { createAuth, createPool, createService, ensureDatabase, EventBus, migrate, startOutboxRelay } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import { cfg } from './config';
import { catalogWeights, sellerClient } from './clients';
import { registerRoutes, startAutoAdvance } from './routes';
import { registerConsumers } from './consumers';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  await ensureDatabase(cfg.DATABASE_URL, log);
  const pool = createPool(cfg.DATABASE_URL);
  await migrate(pool, join(__dirname, '../migrations'), log);
  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics([Topics.order, Topics.shipping]);
  const stopRelay = startOutboxRelay(pool, bus, log);
  await registerConsumers(bus, {
    pool,
    log,
    shops: sellerClient(cfg.SELLER_URL, cfg.INTERNAL_TOKEN),
    weights: catalogWeights(cfg.CATALOG_URL, cfg.INTERNAL_TOKEN),
    defaultPickupProvince: cfg.DEFAULT_PICKUP_PROVINCE,
  });

  registerRoutes(app, { pool, auth, webhookSecret: cfg.CARRIER_WEBHOOK_SECRET, devSimulator: cfg.DEV_SIMULATOR });
  const stopSim = cfg.DEV_SIMULATOR ? startAutoAdvance(pool, cfg.DEV_AUTO_ADVANCE_SECONDS, log) : () => undefined;
  if (cfg.DEV_SIMULATOR) log.warn({ autoAdvanceSeconds: cfg.DEV_AUTO_ADVANCE_SECONDS }, 'DEV_SIMULATOR bật — có route /dev/*');

  svc.addReadiness('postgres', () => pool.query('SELECT 1'));
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    stopSim();
    stopRelay();
    await bus.stop();
    await pool.end();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('shipping không khởi động được', err);
  process.exit(1);
});
