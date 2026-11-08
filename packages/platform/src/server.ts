import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { createLogger, type Logger } from './logger';
import { httpDuration, initMetrics, registry } from './metrics';
import { newId } from './ids';
import { shutdownTelemetry } from './otel-shutdown';

export type ReadinessCheck = () => Promise<unknown> | unknown;

export interface ServiceContext {
  app: FastifyInstance;
  log: Logger;
  addReadiness(name: string, check: ReadinessCheck): void;
  onShutdown(fn: () => Promise<unknown> | unknown): void;
  start(port: number): Promise<void>;
}

/** Fastify chuẩn hoá cho mọi service: log JSON, request-id, lỗi thống nhất, /healthz /readyz /metrics, tắt êm. */
export function createService(name: string, opts: { corsOrigins?: string; fastify?: FastifyServerOptions } = {}): ServiceContext {
  initMetrics(name);
  const log = createLogger(name);
  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: true,
    genReqId: (req) => (req.headers['x-request-id'] as string) || newId(),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    ...opts.fastify,
  });
  const checks = new Map<string, ReadinessCheck>();
  const shutdowns: Array<() => Promise<unknown> | unknown> = [];
  let shuttingDown = false;

  const origins = opts.corsOrigins ?? process.env.CORS_ORIGINS ?? '*';
  app.register(cors, { origin: origins === '*' ? true : origins.split(','), credentials: true });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    if (route === '/metrics' || route === '/healthz' || route === '/readyz') return;
    httpDuration().observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) req.log.error({ method: req.method, url: req.url, status: reply.statusCode, ms: reply.elapsedTime }, 'request failed');
    else req.log.info({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ', details: err.flatten() } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; details?: unknown; validation?: unknown; passthrough?: boolean };
    if (err instanceof AppError || e.passthrough) {
      return reply.status(e.statusCode ?? 500).send({ error: { code: e.code, message: e.message, details: e.details } });
    }
    if (e.validation) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Không có route này' } }));

  app.get('/healthz', async () => ({ status: 'ok', service: name }));
  app.get('/readyz', async (_req, reply) => {
    if (shuttingDown) return reply.status(503).send({ status: 'shutting_down' });
    const results: Record<string, string> = {};
    let ok = true;
    for (const [k, fn] of checks) {
      try {
        await fn();
        results[k] = 'ok';
      } catch (e) {
        ok = false;
        results[k] = (e as Error).message;
      }
    }
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks: results });
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'đang tắt êm (graceful shutdown)');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      for (const fn of shutdowns.reverse()) await Promise.resolve(fn()).catch((err) => log.warn({ err }, 'shutdown hook lỗi'));
      await shutdownTelemetry();
    } finally {
      process.exit(0);
    }
  }

  return {
    app,
    log,
    addReadiness: (n, c) => checks.set(n, c),
    onShutdown: (fn) => shutdowns.push(fn),
    async start(port: number) {
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
      await app.listen({ port, host: '0.0.0.0' });
      log.info({ port }, `${name} sẵn sàng`);
    },
  };
}
