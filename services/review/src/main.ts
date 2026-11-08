import '@shopnow/platform/otel';
import { MongoClient } from 'mongodb';
import { createAuth, createService, EventBus, newId } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import { cfg } from './config';
import { collections, ensureIndexes, startRelay } from './store';
import { aiModerator } from './moderation';
import { registerRoutes } from './routes';
import { registerConsumers } from './consumers';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  const mongo = new MongoClient(cfg.MONGO_URL, { serverSelectionTimeoutMS: 5_000, appName: cfg.SERVICE_NAME });
  await mongo.connect();
  const col = collections(mongo.db(cfg.MONGO_DB));
  await ensureIndexes(col);
  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics([Topics.order, Topics.review]);
  const stopRelay = startRelay(col, bus, log, `${cfg.SERVICE_NAME}-${newId()}`);
  await registerConsumers(bus, { col, log });

  registerRoutes(app, { col, auth, moderator: aiModerator(cfg.AI_URL, cfg.AI_MODERATION_TIMEOUT_MS), log });
  svc.addReadiness('mongo', () => mongo.db(cfg.MONGO_DB).command({ ping: 1 }));
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    stopRelay();
    await bus.stop();
    await mongo.close();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('review không khởi động được', err);
  process.exit(1);
});
