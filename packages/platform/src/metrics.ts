import client from 'prom-client';

export const registry = new client.Registry();
let initialised = false;

export function initMetrics(service: string) {
  if (initialised) return;
  initialised = true;
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
}

const cache = new Map<string, unknown>();
function memo<T>(name: string, make: () => T): T {
  if (!cache.has(name)) cache.set(name, make());
  return cache.get(name) as T;
}

export const counter = (name: string, help: string, labelNames: string[] = []) =>
  memo(name, () => new client.Counter({ name, help, labelNames, registers: [registry] }));
export const gauge = (name: string, help: string, labelNames: string[] = []) =>
  memo(name, () => new client.Gauge({ name, help, labelNames, registers: [registry] }));
export const histogram = (name: string, help: string, labelNames: string[] = [], buckets?: number[]) =>
  memo(name, () => new client.Histogram({ name, help, labelNames, buckets, registers: [registry] }));

export const httpDuration = () =>
  histogram('http_server_requests_seconds', 'Thời gian xử lý HTTP (RED)', ['method', 'route', 'status'], [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 1.5, 2.5, 5, 10,
  ]);
export const kafkaConsumed = () =>
  counter('kafka_messages_consumed_total', 'Số message Kafka đã xử lý', ['topic', 'type', 'result']);
export const kafkaProduced = () => counter('kafka_messages_produced_total', 'Số message Kafka đã gửi', ['topic']);
export const outboxPending = () => gauge('outbox_pending', 'Số sự kiện outbox chưa gửi');
