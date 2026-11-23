import '@shopnow/platform/otel';
import { join } from 'node:path';
import { createAuth, createPool, createService, ensureDatabase, EventBus, migrate, startOutboxRelay } from '@shopnow/platform';
import { Topics } from '@shopnow/contracts';
import { cfg } from './config';
import { registerConsumers } from './consumers';
import { createReconciler, type InvStock } from './reconcile';
import { registerRoutes } from './routes';
import { refreshPickSla } from './sla';
import { refreshSpotGauge } from './spot-count';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;

  await ensureDatabase(cfg.DATABASE_URL, log);
  const pool = createPool(cfg.DATABASE_URL);
  await migrate(pool, join(__dirname, '../migrations'), log);
  const auth = createAuth({ jwksUrl: cfg.JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, internalToken: cfg.INTERNAL_TOKEN });

  const bus = new EventBus({ brokers: cfg.KAFKA_BROKERS, clientId: cfg.SERVICE_NAME, enabled: cfg.KAFKA_ENABLED, log });
  await bus.ensureTopics([Topics.order, Topics.warehouse]);
  const stopRelay = startOutboxRelay(pool, bus, log);
  await registerConsumers(bus, pool, log);
  const reconciler = createReconciler({
    pool,
    fetchStock: async (ids) => {
      const r = await fetch(`${cfg.INVENTORY_URL}/stock?skuIds=${ids.map(encodeURIComponent).join(',')}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`inventory /stock HTTP ${r.status}`);
      const body = (await r.json()) as InvStock[] | { items?: InvStock[] };
      return Array.isArray(body) ? body : body.items ?? [];
    },
  });
  registerRoutes(app, { pool, auth, countThreshold: cfg.COUNT_APPROVAL_THRESHOLD, storageRate: cfg.STORAGE_FEE_PER_UNIT_DAY, reconciler, cutoffHour: cfg.PICK_CUTOFF_HOUR });
  const slaTimer = setInterval(() => {
    refreshPickSla(pool, new Date(), cfg.PICK_CUTOFF_HOUR).catch((err) => log.warn({ err }, 'tính SLA xuất kho lỗi'));
    refreshSpotGauge(pool).catch((err) => log.warn({ err }, 'đếm phiếu kiểm kê đột xuất lỗi'));
  }, 60_000);
  const reconTimer = cfg.RECONCILE_INTERVAL_SECONDS > 0
    ? setInterval(() => { reconciler.runOnce().then((r) => { if (!r.ok) log.warn({ persistent: r.persistent, error: r.error }, 'lệch tồn với inventory'); }); }, cfg.RECONCILE_INTERVAL_SECONDS * 1000)
    : null;

  svc.addReadiness('postgres', () => pool.query('SELECT 1'));
  svc.addReadiness('kafka', () => {
    if (!bus.isConnected) throw new Error('kafka chưa kết nối');
  });
  svc.onShutdown(async () => {
    clearInterval(slaTimer);
    if (reconTimer) clearInterval(reconTimer);
    stopRelay();
    await bus.stop();
    await pool.end();
  });
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('warehouse không khởi động được', err);
  process.exit(1);
});
