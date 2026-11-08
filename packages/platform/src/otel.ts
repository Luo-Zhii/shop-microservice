// Import file này ĐẦU TIÊN trong main.ts để OpenTelemetry kịp gắn hook vào http/pg/ioredis/kafkajs/mongodb.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
let sdk: NodeSDK | undefined;

if (endpoint && process.env.OTEL_SDK_DISABLED !== 'true') {
  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'shopnow-service',
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? 'dev',
      'deployment.environment': process.env.DEPLOY_ENV ?? 'local',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => /^\/(healthz|readyz|metrics)/.test(req.url ?? '') }),
      new UndiciInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
      new KafkaJsInstrumentation(),
      new MongoDBInstrumentation(),
    ],
  });
  sdk.start();
}

export async function shutdownTelemetry() {
  await sdk?.shutdown().catch(() => undefined);
}
