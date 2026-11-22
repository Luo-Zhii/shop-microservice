import '@shopnow/platform/otel';
import { createService } from '@shopnow/platform';
import { cfg } from './config';
import { createProbe } from './probe';

async function main() {
  const svc = createService(cfg.SERVICE_NAME, { corsOrigins: cfg.CORS_ORIGINS });
  const { app, log } = svc;
  const probe = createProbe({ baseUrl: cfg.GATEWAY_URL, token: cfg.SYNTHETIC_TOKEN || undefined, query: cfg.SEARCH_QUERY,
    timeoutMs: cfg.STEP_TIMEOUT_MS, location: cfg.SYNTHETIC_LOCATION });
  let running = false;
  const tick = async () => {
    if (running) return; // lần trước chưa xong (gateway treo) → bỏ lượt, không chồng request
    running = true;
    try {
      const r = await probe.runOnce();
      if (!r.ok) log.warn({ failedStep: r.failedStep, steps: r.steps }, 'hành trình tổng hợp thất bại');
    } catch (err) {
      log.error({ err }, 'robot tổng hợp lỗi');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, cfg.INTERVAL_SECONDS * 1000);
  void tick();

  // nội bộ cụm: AIOps/admin xem chi tiết các lần chạy gần nhất (không qua gateway công khai)
  app.get('/results', async () => ({ location: cfg.SYNTHETIC_LOCATION, intervalSeconds: cfg.INTERVAL_SECONDS, items: probe.history }));
  svc.addReadiness('probe', () => {
    if (probe.history.length === 0) throw new Error('chưa chạy lần nào');
  });
  svc.onShutdown(async () => clearInterval(timer));
  await svc.start(cfg.PORT);
}

main().catch((err) => {
  console.error('synthetic không khởi động được', err);
  process.exit(1);
});
