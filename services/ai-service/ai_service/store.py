"""Lưu trữ của ai-service: sản phẩm APPROVED (bản sao từ catalog), lịch sử mua (order.completed), inbox idempotent.

`PgStore` (Postgres, db `ai`) là mặc định; `MemoryStore` (DATABASE_URL=memory://) để chạy thử không cần DB.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Iterable, Protocol

log = logging.getLogger("ai_service.store")

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchases (
  order_id     text NOT NULL,
  product_id   text NOT NULL,
  buyer_id     text NOT NULL,
  shop_id      text,
  qty          integer NOT NULL DEFAULT 1,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS purchases_buyer_idx ON purchases (buyer_id, completed_at DESC);
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     text PRIMARY KEY,
  topic        text NOT NULL,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
"""


def _ts(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(timezone.utc)


class Store(Protocol):
    def migrate(self) -> None: ...
    def ping(self) -> bool: ...
    def apply_event(self, topic: str, event: dict) -> bool: ...
    def all_products(self) -> list[dict]: ...
    def all_purchases(self) -> list[tuple[str, str, str, int, datetime]]: ...
    def version(self) -> tuple: ...
    def close(self) -> None: ...


def _purchase_rows(event: dict) -> list[tuple[str, str, str, str | None, int, datetime]]:
    order = event.get("data") or {}
    order_id, buyer = order.get("id"), order.get("buyerId")
    if not order_id or not buyer:
        raise ValueError("order.completed thiếu id/buyerId")
    when = _ts(event.get("time") or order.get("createdAt"))
    qty_by_product: dict[str, int] = {}
    for it in order.get("items") or []:
        pid = it.get("productId")
        if pid:
            qty_by_product[pid] = qty_by_product.get(pid, 0) + int(it.get("qty") or 1)
    return [(order_id, pid, buyer, order.get("shopId"), q, when) for pid, q in qty_by_product.items()]


class PgStore:
    def __init__(self, url: str):
        self.url = url
        self._conn = None
        self._lock = threading.RLock()

    # ---- kết nối ----
    def _connect(self):
        import psycopg

        if self._conn is None or self._conn.closed or self._conn.broken:
            self._conn = psycopg.connect(self.url, connect_timeout=5)
        return self._conn

    def _run(self, fn):
        with self._lock:
            for attempt in (1, 2):
                conn = self._connect()
                try:
                    with conn.transaction():
                        with conn.cursor() as cur:
                            return fn(cur)
                except Exception as e:  # noqa: BLE001 - kết nối hỏng thì thử lại 1 lần
                    import psycopg

                    if attempt == 1 and isinstance(e, psycopg.OperationalError):
                        log.warning("mất kết nối Postgres, kết nối lại: %s", e)
                        self._conn = None
                        continue
                    raise

    def migrate(self) -> None:
        self._run(lambda cur: cur.execute(SCHEMA))

    def ping(self) -> bool:
        try:
            return self._run(lambda cur: cur.execute("SELECT 1").fetchone()[0] == 1)
        except Exception:  # noqa: BLE001
            return False

    # ---- sự kiện (inbox idempotent: ghi event_id cùng transaction với thay đổi) ----
    def apply_event(self, topic: str, event: dict) -> bool:
        etype, eid = event.get("type", ""), event.get("id")
        if not eid:
            raise ValueError("sự kiện thiếu id")

        def tx(cur) -> bool:
            cur.execute(
                "INSERT INTO processed_events (event_id, topic, type) VALUES (%s,%s,%s) "
                "ON CONFLICT DO NOTHING RETURNING event_id",
                (eid, topic, etype),
            )
            if cur.fetchone() is None:
                return False  # đã xử lý
            data = event.get("data") or {}
            if etype == "product.upserted":
                pid = data.get("id")
                if not pid:
                    raise ValueError("product.upserted thiếu id")
                if data.get("status") == "APPROVED":
                    cur.execute(
                        "INSERT INTO products (id, data, updated_at) VALUES (%s, %s::jsonb, %s) "
                        "ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at "
                        "WHERE products.updated_at <= EXCLUDED.updated_at",
                        (pid, json.dumps(data), _ts(data.get("updatedAt"))),
                    )
                else:
                    cur.execute("DELETE FROM products WHERE id = %s", (pid,))
            elif etype == "product.deleted":
                cur.execute("DELETE FROM products WHERE id = %s", (data.get("productId") or event.get("subject"),))
            elif etype == "order.completed":
                for row in _purchase_rows(event):
                    cur.execute(
                        "INSERT INTO purchases (order_id, product_id, buyer_id, shop_id, qty, completed_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                        row,
                    )
            return True

        return self._run(tx)

    # ---- đọc để dựng mô hình ----
    def all_products(self) -> list[dict]:
        return self._run(lambda cur: [r[0] for r in cur.execute("SELECT data FROM products ORDER BY id").fetchall()])

    def all_purchases(self):
        return self._run(
            lambda cur: cur.execute(
                "SELECT order_id, product_id, buyer_id, qty, completed_at FROM purchases"
            ).fetchall()
        )

    def version(self) -> tuple:
        return self._run(
            lambda cur: cur.execute(
                "SELECT (SELECT count(*) FROM products), (SELECT max(updated_at) FROM products), "
                "(SELECT count(*) FROM purchases), (SELECT count(*) FROM processed_events)"
            ).fetchone()
        )

    def upsert_products(self, products: Iterable[dict]) -> None:
        """Nạp hàng loạt (seed/test) — không qua inbox."""

        def tx(cur):
            for p in products:
                cur.execute(
                    "INSERT INTO products (id, data, updated_at) VALUES (%s,%s::jsonb,%s) "
                    "ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at",
                    (p["id"], json.dumps(p), _ts(p.get("updatedAt"))),
                )

        self._run(tx)

    def truncate(self) -> None:
        self._run(lambda cur: cur.execute("DELETE FROM products; DELETE FROM purchases; DELETE FROM processed_events"))

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None


class MemoryStore:
    def __init__(self):
        self.products: dict[str, dict] = {}
        self.purchases: dict[tuple[str, str], tuple] = {}
        self.processed: set[str] = set()
        self._lock = threading.Lock()

    def migrate(self):
        pass

    def ping(self):
        return True

    def apply_event(self, topic, event):
        with self._lock:
            eid = event.get("id")
            if not eid:
                raise ValueError("sự kiện thiếu id")
            if eid in self.processed:
                return False
            etype, data = event.get("type"), event.get("data") or {}
            if etype == "product.upserted":
                if data.get("status") == "APPROVED":
                    old = self.products.get(data["id"])
                    if old is None or _ts(old.get("updatedAt")) <= _ts(data.get("updatedAt")):
                        self.products[data["id"]] = data
                else:
                    self.products.pop(data.get("id"), None)
            elif etype == "product.deleted":
                self.products.pop(data.get("productId") or event.get("subject"), None)
            elif etype == "order.completed":
                for o, p, b, _s, q, t in _purchase_rows(event):
                    self.purchases.setdefault((o, p), (o, p, b, q, t))
            self.processed.add(eid)
            return True

    def all_products(self):
        return [self.products[k] for k in sorted(self.products)]

    def all_purchases(self):
        return list(self.purchases.values())

    def version(self):
        return (len(self.products), len(self.purchases), len(self.processed))

    def upsert_products(self, products):
        for p in products:
            self.products[p["id"]] = p

    def truncate(self):
        self.products.clear()
        self.purchases.clear()
        self.processed.clear()

    def close(self):
        pass


def make_store(url: str):
    return MemoryStore() if url.startswith("memory") else PgStore(url)
