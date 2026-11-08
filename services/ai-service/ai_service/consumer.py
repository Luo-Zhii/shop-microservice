"""Consumer Kafka (aiokafka): catalog.product.v1 + order.v1 (order.completed).

Đúng một lần nhờ inbox `processed_events` (ghi cùng transaction với thay đổi). Lỗi xử lý: thử lại 3 lần
(backoff 0.4s, 0.8s) rồi đẩy sang `<topic>.dlq`, commit offset sau mỗi lô để không chặn partition.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Callable

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.propagate import extract

from .observability import KAFKA_CONSUMED, KAFKA_PRODUCED

log = logging.getLogger("ai_service.consumer")
tracer = trace.get_tracer("ai_service.kafka")

TOPICS = ("catalog.product.v1", "order.v1")
HANDLED = {"product.upserted", "product.deleted", "order.completed"}


def handle_message(store, topic: str, raw: bytes | None, service: str, on_change: Callable[[], None]) -> str:
    """Xử lý đồng bộ một message; trả về kết quả cho metric. Ném lỗi để vòng ngoài thử lại/DLQ."""
    try:
        event = json.loads(raw or b"{}")
    except ValueError:
        KAFKA_CONSUMED.labels(service, topic, "invalid", "dropped").inc()
        return "dropped"
    etype = event.get("type", "unknown")
    if etype not in HANDLED:
        KAFKA_CONSUMED.labels(service, topic, etype, "ignored").inc()
        return "ignored"
    changed = store.apply_event(topic, event)
    if changed:
        on_change()
    result = "ok" if changed else "duplicate"
    KAFKA_CONSUMED.labels(service, topic, etype, result).inc()
    return result


class EventConsumer:
    def __init__(self, store, brokers: str, group_id: str, service: str, on_change: Callable[[], None]):
        self.store, self.brokers, self.group_id, self.service, self.on_change = store, brokers, group_id, service, on_change
        self.connected = False
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="kafka-consumer")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _run(self) -> None:
        from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

        backoff = 1.0
        while not self._stop.is_set():
            consumer = AIOKafkaConsumer(*TOPICS, bootstrap_servers=self.brokers, group_id=self.group_id,
                                        enable_auto_commit=False, auto_offset_reset="earliest")
            producer = AIOKafkaProducer(bootstrap_servers=self.brokers)
            try:
                await consumer.start()
                await producer.start()
                self.connected, backoff = True, 1.0
                log.info("kafka consumer đã kết nối %s, topics=%s", self.brokers, TOPICS)
                while not self._stop.is_set():
                    batches = await consumer.getmany(timeout_ms=1000, max_records=200)
                    for _tp, msgs in batches.items():
                        for m in msgs:
                            await self._process(m, producer)
                    if batches:
                        await consumer.commit()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - mất broker → thử lại
                log.warning("kafka consumer lỗi, thử lại sau %.0fs: %s", backoff, e)
            finally:
                self.connected = False
                await asyncio.gather(consumer.stop(), producer.stop(), return_exceptions=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _process(self, msg, producer) -> None:
        try:
            env = json.loads(msg.value or b"{}")
        except ValueError:
            env = {}
        parent = extract({"traceparent": env["traceparent"]}) if env.get("traceparent") else otel_context.get_current()
        with tracer.start_as_current_span(f"consume {env.get('type', 'unknown')}", context=parent,
                                          kind=trace.SpanKind.CONSUMER,
                                          attributes={"messaging.system": "kafka",
                                                      "messaging.destination.name": msg.topic,
                                                      "event.id": str(env.get("id"))}) as span:
            for attempt in range(1, 4):
                try:
                    await asyncio.to_thread(handle_message, self.store, msg.topic, msg.value, self.service, self.on_change)
                    return
                except Exception as e:  # noqa: BLE001
                    if attempt == 3:
                        log.error("xử lý sự kiện thất bại → DLQ: topic=%s type=%s id=%s err=%s",
                                  msg.topic, env.get("type"), env.get("id"), e)
                        span.record_exception(e)
                        span.set_status(trace.Status(trace.StatusCode.ERROR))
                        KAFKA_CONSUMED.labels(self.service, msg.topic, env.get("type", "unknown"), "dlq").inc()
                        payload = dict(env, error=str(e), consumer=self.group_id) if env else {"raw": (msg.value or b"").decode(errors="replace")}
                        try:
                            await producer.send_and_wait(f"{msg.topic}.dlq", json.dumps(payload).encode(), key=msg.key)
                            KAFKA_PRODUCED.labels(self.service, f"{msg.topic}.dlq").inc()
                        except Exception as de:  # noqa: BLE001
                            log.error("không ghi được DLQ: %s", de)
                        return
                    await asyncio.sleep(0.2 * 2**attempt)
