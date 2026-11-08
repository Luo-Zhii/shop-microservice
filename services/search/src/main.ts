import '@shopnow/platform/otel';
import { join } from 'node:path';
import { createPool, createService, ensureDatabase, EventBus } from '@shopnow/platform';
import { cfg } from './config';
import type { SearchEngine } from './types';
import { PostgresEngine } from './engines/postgres';
import { OpenSearchEngine } from './engines/opensearch';
import { catalogCategories } from './categories';
import { CONSUMED_TOPICS, registerConsumers } from './indexer';
import { registerRoutes } from './routes';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  let engine: SearchEngine;
  if (cfg.SEARCH_ENGINE === 'opensearch') {
    engine = new OpenSearchEngine({ node: cfg.OPENSEARCH_URL, username: cfg.OPENSEARCH_USERNAME, password: cfg.OPENSEARCH_PASSWORD, prefix: cfg.OPENSEARCH_INDEX_PREFIX });
  } else {
    await ensureDatabase(cfg.DATABASE_URL, log);
    engine = new PostgresEngine(createPool(cfg.DATABASE_URL), join(__dirname, '../migrations'));
  }
  await engine.init();
  log.info({ engine: engine.name }, 'search engine sẵn sàng');

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics(CONSUMED_TOPICS);
  await registerConsumers(bus, { engine, categories: catalogCategories(cfg.CATALOG_URL), log });

  registerRoutes(app, { engine, log });
  svc.addReadiness(engine.name, () => engine.ping());
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    await bus.stop();
    await engine.close();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('search không khởi động được', err);
  process.exit(1);
});
