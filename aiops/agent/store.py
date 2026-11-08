"""Lưu sự cố, hành động, audit — SQLite (mặc định) hoặc Postgres (AIOPS_DB_URL=postgresql://…)."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from ..util import iso, uuid7

DDL = [
    """CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, service TEXT, namespace TEXT, status TEXT, severity TEXT, title TEXT, summary TEXT,
        source TEXT, fault_start DOUBLE PRECISION, fault_start_source TEXT, detected_at DOUBLE PRECISION,
        acknowledged_at DOUBLE PRECISION, mitigated_at DOUBLE PRECISION, resolved_at DOUBLE PRECISION,
        root_causes TEXT, context TEXT, decision TEXT, alerts TEXT, created_at DOUBLE PRECISION, updated_at DOUBLE PRECISION)""",
    "CREATE INDEX IF NOT EXISTS incidents_service_idx ON incidents (service, status)",
    """CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, incident_id TEXT, type TEXT, target TEXT, params TEXT, status TEXT, approval TEXT,
        rule TEXT, reason TEXT, result TEXT, created_at DOUBLE PRECISION, decided_at DOUBLE PRECISION,
        decided_by TEXT, executed_at DOUBLE PRECISION)""",
    """CREATE TABLE IF NOT EXISTS audit (
        ts DOUBLE PRECISION, actor TEXT, event TEXT, incident_id TEXT, action_id TEXT, details TEXT)""",
]
JSON_COLS = {"root_causes", "context", "decision", "alerts", "target", "params", "result", "details"}
TS_COLS = {"fault_start", "detected_at", "acknowledged_at", "mitigated_at", "resolved_at", "created_at", "updated_at",
           "decided_at", "executed_at", "ts"}
OPEN = ("open", "acknowledged", "mitigated")


class IncidentStore:
    def __init__(self, url: str = "sqlite:///aiops.db"):
        self.url = url
        self.pg = url.startswith(("postgres://", "postgresql://"))
        self._lock = threading.RLock()
        if self.pg:
            import psycopg

            self.conn = psycopg.connect(url, autocommit=True)
        else:
            path = url.removeprefix("sqlite:///") if url.startswith("sqlite:///") else url
            self.conn = sqlite3.connect(path or ":memory:", check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
        for stmt in DDL:
            self._exec(stmt)

    # ---- tầng SQL ----
    def _exec(self, sql: str, params: tuple = ()) -> list[dict]:
        if self.pg:
            sql = sql.replace("?", "%s")
        with self._lock:
            if self.pg:
                with self.conn.cursor() as cur:
                    cur.execute(sql, params)
                    if cur.description is None:
                        return []
                    cols = [c.name for c in cur.description]
                    return [dict(zip(cols, r)) for r in cur.fetchall()]
            cur = self.conn.execute(sql, params)
            rows = [dict(r) for r in cur.fetchall()] if cur.description else []
            self.conn.commit()
            return rows

    @staticmethod
    def _enc(k: str, v: Any):
        return json.dumps(v, ensure_ascii=False, default=str) if k in JSON_COLS and v is not None else v

    @staticmethod
    def _dec(row: dict) -> dict:
        out = {}
        for k, v in row.items():
            if k in JSON_COLS and isinstance(v, str):
                try:
                    v = json.loads(v)
                except ValueError:
                    pass
            out[k] = v
        return out

    def _insert(self, table: str, data: dict) -> None:
        cols = list(data)
        self._exec(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                   tuple(self._enc(k, data[k]) for k in cols))

    def _update(self, table: str, id_: str, data: dict) -> None:
        if not data:
            return
        sets = ", ".join(f"{k} = ?" for k in data)
        self._exec(f"UPDATE {table} SET {sets} WHERE id = ?", tuple(self._enc(k, v) for k, v in data.items()) + (id_,))

    # ---- sự cố ----
    def create_incident(self, **fields) -> dict:
        now = time.time()
        inc = {"id": uuid7(), "status": "open", "created_at": now, "updated_at": now, "alerts": [], **fields}
        self._insert("incidents", inc)
        return self.get_incident(inc["id"])

    def update_incident(self, id_: str, **fields) -> dict | None:
        fields["updated_at"] = time.time()
        self._update("incidents", id_, fields)
        return self.get_incident(id_)

    def get_incident(self, id_: str) -> dict | None:
        rows = self._exec("SELECT * FROM incidents WHERE id = ?", (id_,))
        return self._dec(rows[0]) if rows else None

    def find_open(self, service: str, since: float) -> dict | None:
        rows = self._exec(
            f"SELECT * FROM incidents WHERE service = ? AND status IN ({', '.join('?' for _ in OPEN)}) "
            "AND detected_at >= ? ORDER BY detected_at DESC LIMIT 1", (service, *OPEN, since))
        return self._dec(rows[0]) if rows else None

    def find_by_fingerprint(self, fingerprint: str) -> dict | None:
        rows = self._exec(f"SELECT * FROM incidents WHERE status IN ({', '.join('?' for _ in OPEN)}) "
                          "AND alerts LIKE ? ORDER BY detected_at DESC LIMIT 1", (*OPEN, f'%"{fingerprint}"%'))
        return self._dec(rows[0]) if rows else None

    def count_open(self) -> int:
        rows = self._exec(f"SELECT count(*) AS n FROM incidents WHERE status IN ({', '.join('?' for _ in OPEN)})", OPEN)
        return int(rows[0]["n"]) if rows else 0

    def list_incidents(self, status: str | None = None, service: str | None = None, since: float | None = None,
                       limit: int = 50) -> list[dict]:
        where, params = [], []
        if status:
            where.append("status = ?")
            params.append(status)
        if service:
            where.append("service = ?")
            params.append(service)
        if since is not None:
            where.append("detected_at >= ?")
            params.append(since)
        sql = "SELECT * FROM incidents" + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY detected_at DESC LIMIT ?"
        return [self._dec(r) for r in self._exec(sql, (*params, limit))]

    # ---- hành động ----
    def create_action(self, **fields) -> dict:
        a = {"id": uuid7(), "created_at": time.time(), **fields}
        self._insert("actions", a)
        return self.get_action(a["id"])

    def update_action(self, id_: str, **fields) -> dict | None:
        self._update("actions", id_, fields)
        return self.get_action(id_)

    def get_action(self, id_: str) -> dict | None:
        rows = self._exec("SELECT * FROM actions WHERE id = ?", (id_,))
        return self._dec(rows[0]) if rows else None

    def actions_for(self, incident_id: str) -> list[dict]:
        return [self._dec(r) for r in self._exec("SELECT * FROM actions WHERE incident_id = ? ORDER BY created_at",
                                                 (incident_id,))]

    # ---- audit ----
    def audit(self, actor: str, event: str, incident_id: str | None = None, action_id: str | None = None,
              details: dict | None = None) -> dict:
        row = {"ts": time.time(), "actor": actor, "event": event, "incident_id": incident_id, "action_id": action_id,
               "details": details or {}}
        self._insert("audit", row)
        return row

    def audit_for(self, incident_id: str) -> list[dict]:
        return [self._dec(r) for r in self._exec("SELECT * FROM audit WHERE incident_id = ? ORDER BY ts", (incident_id,))]

    def close(self) -> None:
        with self._lock:
            self.conn.close()


def to_api(row: dict | None) -> dict | None:
    """Đổi mốc epoch → ISO-8601 cho API."""
    if row is None:
        return None
    return {k: (iso(v) if k in TS_COLS and isinstance(v, (int, float)) else v) for k, v in row.items()}
