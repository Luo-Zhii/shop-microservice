import { Kafka, logLevel, type Consumer, type Producer, CompressionTypes } from 'kafkajs';
process.env.KAFKAJS_NO_PARTITIONER_WARNING ??= '1';
import { context, propagation, trace, SpanKind, SpanStatusCode, type Context } from '@opentelemetry/api';
import type { EventEnvelope } from '@shopnow/contracts';
import type { Pool, PoolClient } from './db';
import { newId } from './ids';
import type { Logger } from './logger';
import { kafkaConsumed, kafkaProduced, outboxPending } from './metrics';

const tracer = trace.getTracer('shopnow-kafka');

/** Tạo phong bì sự kiện; tự gắn traceparent của span hiện tại để consumer nối tiếp trace. */
export function createEvent<T>(type: string, source: string, subject: string, data: T): EventEnvelope<T> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { id: newId(), type, source, time: new Date().toISOString(), subject, traceparent: carrier.traceparent, data };
}

export type EventHandler = (event: EventEnvelope<any>, meta: { topic: string; partition: number }) => Promise<void>;

export interface BusOptions {
  brokers: string;
  clientId: string;
  enabled?: boolean;
  log: Logger;
}

export class EventBus {
  private kafka: Kafka;
  private producer?: Producer;
  private consumers: Consumer[] = [];
  readonly enabled: boolean;
  private connected = false;

  constructor(private opts: BusOptions) {
    this.enabled = opts.enabled !== false;
    const log = opts.log;
    this.kafka = new Kafka({
      clientId: opts.clientId,
      brokers: opts.brokers.split(',').map((b) => b.trim()),
      logLevel: logLevel.WARN,
      retry: { retries: 8, initialRetryTime: 300 },
      logCreator: () => ({ level, log: entry }) => {
        const { message, ...rest } = entry;
        if (level <= logLevel.ERROR) log.error(rest, `kafka: ${message}`);
        else log.warn(rest, `kafka: ${message}`);
      },
    });
  }

  get isConnected() {
    return !this.enabled || this.connected;
  }

  async ensureTopics(topics: string[], numPartitions = 3) {
    if (!this.enabled) return;
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const existing = new Set(await admin.listTopics());
      const missing = [...new Set(topics.flatMap((t) => [t, `${t}.dlq`]))].filter((t) => !existing.has(t));
      if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions })) });
    } catch (e) {
      this.opts.log.warn({ err: e }, 'không tạo được topic (bỏ qua — broker có thể tự tạo)');
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }

  async connectProducer() {
    if (!this.enabled || this.producer) return;
    this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: true });
    await this.producer.connect();
    this.connected = true;
  }

  /** Gửi trực tiếp (service không có Postgres outbox, vd cart/review/notification). */
  async publish(topic: string, events: EventEnvelope<any> | EventEnvelope<any>[]) {
    const list = Array.isArray(events) ? events : [events];
    if (!this.enabled || list.length === 0) return;
    await this.connectProducer();
    await this.producer!.send({
      topic,
      compression: CompressionTypes.GZIP,
      messages: list.map((e) => ({ key: e.subject, value: JSON.stringify(e), headers: { 'ce-type': e.type } })),
    });
    kafkaProduced().inc({ topic }, list.length);
  }

  /**
   * Đăng ký consumer. Mỗi message: dựng lại trace context từ traceparent, gọi handler,
   * thử lại 3 lần (backoff) rồi đẩy sang <topic>.dlq để không chặn partition.
   */
  async subscribe(groupId: string, topics: string[], handler: EventHandler) {
    if (!this.enabled) return;
    await this.connectProducer();
    const consumer = this.kafka.consumer({ groupId, sessionTimeout: 30_000, heartbeatInterval: 3_000 });
    await consumer.connect();
    for (const topic of topics) await consumer.subscribe({ topic, fromBeginning: true });
    this.consumers.push(consumer);
    const log = this.opts.log;
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        let event: EventEnvelope<any>;
        try {
          event = JSON.parse(message.value?.toString() ?? '{}');
        } catch {
          kafkaConsumed().inc({ topic, type: 'invalid', result: 'dropped' });
          return;
        }
        const parent: Context = event.traceparent
          ? propagation.extract(context.active(), { traceparent: event.traceparent })
          : context.active();
        await tracer.startActiveSpan(
          `consume ${event.type}`,
          { kind: SpanKind.CONSUMER, attributes: { 'messaging.system': 'kafka', 'messaging.destination.name': topic, 'event.type': event.type, 'event.id': event.id } },
          parent,
          async (span) => {
            let attempt = 0;
            for (;;) {
              try {
                await handler(event, { topic, partition });
                kafkaConsumed().inc({ topic, type: event.type, result: 'ok' });
                break;
              } catch (err) {
                attempt += 1;
                if (attempt >= 3) {
                  log.error({ err, topic, type: event.type, eventId: event.id }, 'xử lý sự kiện thất bại → DLQ');
                  span.recordException(err as Error);
                  span.setStatus({ code: SpanStatusCode.ERROR });
                  kafkaConsumed().inc({ topic, type: event.type, result: 'dlq' });
                  await this.producer!.send({
                    topic: `${topic}.dlq`,
                    messages: [{ key: event.subject, value: JSON.stringify({ ...event, error: String((err as Error).message), consumer: groupId }) }],
                  }).catch((e) => log.error({ err: e }, 'không ghi được DLQ'));
                  break;
                }
                await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
              }
            }
            span.end();
          },
        );
      },
    });
  }

  async stop() {
    await Promise.allSettled(this.consumers.map((c) => c.disconnect()));
    await this.producer?.disconnect().catch(() => undefined);
  }
}

// ---------------- Transactional Outbox ----------------

/** Ghi sự kiện vào bảng outbox TRONG CÙNG transaction với thay đổi nghiệp vụ. */
export async function enqueue(c: PoolClient, topic: string, events: EventEnvelope<any> | EventEnvelope<any>[]) {
  for (const e of Array.isArray(events) ? events : [events]) {
    await c.query('INSERT INTO outbox (id, topic, key, payload) VALUES ($1,$2,$3,$4)', [e.id, topic, e.subject, JSON.stringify(e)]);
  }
}

/** Relay: đọc outbox (FOR UPDATE SKIP LOCKED → chạy nhiều replica an toàn) và đẩy lên Kafka. */
export function startOutboxRelay(pool: Pool, bus: EventBus, log: Logger, intervalMs = 250) {
  if (!bus.enabled) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    let sent = 0;
    const c = await pool.connect().catch(() => undefined);
    if (c) {
      try {
        await c.query('BEGIN');
        const { rows } = await c.query(
          'SELECT id, topic, payload FROM outbox ORDER BY created_at LIMIT 200 FOR UPDATE SKIP LOCKED',
        );
        if (rows.length) {
          const byTopic = new Map<string, EventEnvelope<any>[]>();
          for (const r of rows) byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r.payload]);
          for (const [topic, evs] of byTopic) await bus.publish(topic, evs);
          await c.query('DELETE FROM outbox WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
          sent = rows.length;
        }
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        log.warn({ err }, 'outbox relay lỗi, sẽ thử lại');
      } finally {
        c.release();
      }
    }
    timer = setTimeout(tick, sent > 0 ? 0 : intervalMs);
  };
  const gaugeTimer = setInterval(async () => {
    const r = await pool.query('SELECT count(*)::int AS n FROM outbox').catch(() => undefined);
    if (r) outboxPending().set(r.rows[0].n);
  }, 5_000);
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(gaugeTimer);
  };
}

/**
 * Inbox / idempotent consumer: chạy fn trong transaction chỉ khi event chưa được consumer này xử lý.
 * Trả false nếu là bản trùng (Kafka at-least-once).
 */
export async function processOnce(
  pool: Pool,
  consumer: string,
  eventId: string,
  fn: (c: PoolClient) => Promise<void>,
): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      'INSERT INTO processed_events (event_id, consumer) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',
      [`${consumer}:${eventId}`, consumer],
    );
    if (r.rowCount === 0) {
      await c.query('ROLLBACK');
      return false;
    }
    await fn(c);
    await c.query('COMMIT');
    return true;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
