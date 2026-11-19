import '@shopnow/platform/otel';
import { join } from 'node:path';
import { createAuth, createPool, createService, ensureDatabase, EventBus, migrate, startOutboxRelay } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import { cfg } from './config';
import { registerConsumers } from './posting';
import { registerRoutes } from './routes';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  await ensureDatabase(cfg.DATABASE_URL, log);
  const pool = createPool(cfg.DATABASE_URL);
  await migrate(pool, join(__dirname, '../migrations'), log);
  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics([Topics.paymentEvent, Topics.order, Topics.warehouse, Topics.accounting]);
  const stopRelay = startOutboxRelay(pool, bus, log);
  await registerConsumers(bus, pool, {
    commissionRate: cfg.COMMISSION_RATE, vatRate: cfg.VAT_RATE, invoiceSeries: cfg.INVOICE_SERIES, tz: cfg.TIMEZONE,
  }, log);
  registerRoutes(app, { pool, auth, tz: cfg.TIMEZONE });

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
  console.error('accounting không khởi động được', err);
  process.exit(1);
});
