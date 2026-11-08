import pino from 'pino';
import { trace } from '@opentelemetry/api';

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Gắn trace_id/span_id để Grafana nhảy từ log sang trace (Loki → Tempo).
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
    redact: { paths: ['req.headers.authorization', 'password', '*.password', 'refreshToken', '*.refreshToken'], remove: true },
  });
}
export type Logger = ReturnType<typeof createLogger>;
