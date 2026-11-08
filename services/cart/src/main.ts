import '@shopnow/platform/otel';
import { Redis } from 'ioredis';
import { createAuth, createService, EventBus } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import { cfg } from './config';
import { catalogClient, inventoryClient } from './clients';
import { createCartStore } from './store';
import { registerRoutes } from './routes';
import { registerConsumers } from './consumers';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
  redis.on('error', (err) => log.warn({ err }, 'redis lỗi'));
  const store = createCartStore(redis, cfg.CART_KEY_PREFIX, cfg.CART_GUEST_TTL_DAYS * 86_400);
  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics([Topics.order]);
  await registerConsumers(bus, { store, log });

  registerRoutes(app, {
    store,
    auth,
    catalog: catalogClient(cfg.CATALOG_URL, cfg.INTERNAL_TOKEN),
    inventory: inventoryClient(cfg.INVENTORY_URL, cfg.INTERNAL_TOKEN),
    log,
  });
  svc.addReadiness('redis', () => redis.ping());
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    await bus.stop();
    await redis.quit();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('cart không khởi động được', err);
  process.exit(1);
});
