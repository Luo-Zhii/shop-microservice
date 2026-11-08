import '@shopnow/platform/otel';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { createAuth, createService, EventBus } from '@shopnow/platform';
import { cfg } from './config';
import { cachedShopOwners, identityClient, sellerClient } from './clients';
import { collections, ensureIndexes } from './store';
import { redisFanout, SseHub } from './realtime';
import { createNotifier } from './notifier';
import { smtpMailer } from './mailer';
import { registerRoutes } from './routes';
import { CONSUMED_TOPICS, registerConsumers } from './consumers';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  const mongo = new MongoClient(cfg.MONGO_URL, { serverSelectionTimeoutMS: 5_000, appName: cfg.SERVICE_NAME });
  await mongo.connect();
  const col = collections(mongo.db(cfg.MONGO_DB));
  await ensureIndexes(col);

  const pub = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2 });
  const sub = new Redis(cfg.REDIS_URL);
  for (const r of [pub, sub]) r.on('error', (err) => log.warn({ err }, 'redis lỗi'));
  const hub = new SseHub();
  const fanout = await redisFanout(pub, sub, cfg.NOTIFY_CHANNEL, hub, log);

  const mailer = smtpMailer(cfg.SMTP_URL, cfg.MAIL_FROM);
  mailer.verify().catch((err) => log.warn({ err }, 'SMTP chưa sẵn sàng — email sẽ được thử lại khi gửi'));
  const notifier = createNotifier({ col, fanout, mailer, from: cfg.MAIL_FROM, log });
  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics(CONSUMED_TOPICS);
  await registerConsumers(bus, {
    col,
    notifier,
    users: identityClient(cfg.IDENTITY_URL, cfg.INTERNAL_TOKEN),
    shops: cachedShopOwners(sellerClient(cfg.SELLER_URL, cfg.INTERNAL_TOKEN)),
    webUrl: cfg.WEB_URL,
    log,
  });

  registerRoutes(app, { col, auth, hub, fanout });
  app.addHook('preClose', async () => hub.closeAll()); // đóng SSE trước để server tắt êm không bị treo
  svc.addReadiness('mongo', () => mongo.db(cfg.MONGO_DB).command({ ping: 1 }));
  svc.addReadiness('redis', () => pub.ping());
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    await bus.stop();
    await fanout.close();
    mailer.close();
    await Promise.allSettled([pub.quit(), sub.quit()]);
    await mongo.close();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('notification không khởi động được', err);
  process.exit(1);
});
