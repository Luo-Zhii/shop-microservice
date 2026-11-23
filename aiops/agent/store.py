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
    """CREATE TABLE IF NOT EXISTS investigations (
        id TEXT PRIMARY KEY, incident_id TEXT, mode TEXT, steps TEXT, hypotheses TEXT, dropped_hypotheses TEXT,
        remediation TEXT, evidence TEXT, grounding DOUBLE PRECISION, cost TEXT, pr TEXT, created_at DOUBLE PRECISION,
        updated_at DOUBLE PRECISION)""",
    "CREATE INDEX IF NOT EXISTS investigations_incident_idx ON investigations (incident_id)",
    """CREATE TABLE IF NOT EXISTS deploy_records (
        id TEXT PRIMARY KEY, ref TEXT, services TEXT, features TEXT, probability DOUBLE PRECISION,
        deployed_at DOUBLE PRECISION, label INTEGER, labeled_at DOUBLE PRECISION)""",
    """CREATE TABLE IF NOT EXISTS risk_models (
        id TEXT PRIMARY KEY, weights TEXT, n INTEGER, positives INTEGER, logloss_prior DOUBLE PRECISION,
        logloss_fit DOUBLE PRECISION, created_at DOUBLE PRECISION)""",
    # thông báo sự cố CÔNG KHAI do người trực viết (trang trạng thái) — tách hẳn khỏi dữ liệu vận hành nội bộ
    """CREATE TABLE IF NOT EXISTS status_updates (
        id TEXT PRIMARY KEY, incident_id TEXT, status TEXT, impact TEXT, title TEXT, message TEXT, author TEXT,
        created_at DOUBLE PRECISION)""",
    "CREATE INDEX IF NOT EXISTS status_updates_incident_idx ON status_updates (incident_id, created_at)",
    # diễn tập sự cố (game day) — chống "deskilling": mỗi runbook phải được tập định kỳ, đo TTD/TTM/TTR như sự cố thật
    """CREATE TABLE IF NOT EXISTS drills (
        id TEXT PRIMARY KEY, runbook TEXT, chaos TEXT, mode TEXT, environment TEXT, status TEXT, started_by TEXT, started_at DOUBLE PRECISION,
        detected_at DOUBLE PRECISION, mitigated_at DOUBLE PRECISION, resolved_at DOUBLE PRECISION,
        followed_runbook INTEGER, notes TEXT, created_at DOUBLE PRECISION)""",
    # lỗ hổng của workload ĐANG CHẠY (Trivy Operator) — theo dõi lần đầu thấy / đã khắc phục để đo SLA vá lỗ hổng
    """CREATE TABLE IF NOT EXISTS vuln_findings (
        id TEXT PRIMARY KEY, workload TEXT, container TEXT, image TEXT, vuln_id TEXT, severity TEXT, pkg TEXT,
        installed TEXT, fixed TEXT, title TEXT, first_seen DOUBLE PRECISION, last_seen DOUBLE PRECISION,
        resolved_at DOUBLE PRECISION)""",
    # tình báo mối đe doạ cho đúng các CVE đang có: CISA KEV (đang bị khai thác) + FIRST EPSS (xác suất bị khai thác 30 ngày)
    """CREATE TABLE IF NOT EXISTS threat_intel (
        id TEXT PRIMARY KEY, kev INTEGER, kev_added TEXT, kev_ransomware TEXT, epss DOUBLE PRECISION,
        epss_percentile DOUBLE PRECISION, updated_at DOUBLE PRECISION)""",
    """CREATE TABLE IF NOT EXISTS audit (
        ts DOUBLE PRECISION, actor TEXT, event TEXT, incident_id TEXT, action_id TEXT, details TEXT)""",
]
# migration cộng dồn (chỉ thêm cột, không sửa/xoá) cho DB đã tạo từ phiên bản trước — chạy lặp lại vô hại
ADD_COLUMNS = [("deploy_records", "lead_time_s", "DOUBLE PRECISION"), ("deploy_records", "environment", "TEXT"),
               ("incidents", "drill_id", "TEXT"),   # sự cố sinh ra trong buổi diễn tập (loại khỏi MTTR/DORA/SLA)
               ("incidents", "assignee", "TEXT")]   # người trực chính lúc sự cố mở (oncall.py)
JSON_COLS = {"services", "features", "weights", "steps", "hypotheses", "dropped_hypotheses", "remediation", "evidence", "cost", "pr", "root_causes", "context", "decision", "alerts", "target", "params", "result", "details"}
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
        for table, col, typ in ADD_COLUMNS:
            if self.pg:
                self._exec(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {typ}")
            elif col not in {r["name"] for r in self._exec(f"PRAGMA table_info({table})")}:
                self._exec(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")

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
                       limit: int = 50, exclude_drills: bool = False) -> list[dict]:
        where, params = [], []
        if exclude_drills:
            where.append("drill_id IS NULL")
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

    def list_actions(self, since: float = 0.0) -> list[dict]:
        return [self._dec(r) for r in self._exec("SELECT * FROM actions WHERE created_at >= ? ORDER BY created_at", (since,))]

    def actions_for(self, incident_id: str) -> list[dict]:
        return [self._dec(r) for r in self._exec("SELECT * FROM actions WHERE incident_id = ? ORDER BY created_at",
                                                 (incident_id,))]

    # ---- audit ----
    def save_investigation(self, inv: dict) -> dict:
        row = {k: inv.get(k) for k in ("incident_id", "mode", "steps", "hypotheses", "dropped_hypotheses", "remediation",
                                       "evidence", "grounding", "cost", "pr")}
        row["id"] = uuid7()
        now = time.time()
        row["created_at"] = row["updated_at"] = now
        self._insert("investigations", row)
        return self.get_investigation(row["id"])

    def get_investigation(self, id_: str) -> dict | None:
        rows = self._exec("SELECT * FROM investigations WHERE id = ?", (id_,))
        return self._dec(rows[0]) if rows else None

    def update_investigation(self, id_: str, **fields) -> dict | None:
        self._update("investigations", id_, fields)
        return self.get_investigation(id_)

    def investigations_for(self, incident_id: str) -> list[dict]:
        rows = self._exec("SELECT * FROM investigations WHERE incident_id = ? ORDER BY created_at DESC",
                          (incident_id,))
        return [self._dec(r) for r in rows]

    # ---- học trọng số rủi ro thay đổi ----
    def add_deploy(self, ref: str, services: list[str], features: dict, probability: float, deployed_at: float,
                   lead_time_s: float | None = None, environment: str | None = None) -> dict:
        row = {"id": uuid7(), "ref": ref, "services": services, "features": features, "probability": probability,
               "deployed_at": deployed_at, "label": None, "labeled_at": None, "lead_time_s": lead_time_s, "environment": environment}
        self._insert("deploy_records", row)
        return row

    def deploys(self, unlabeled_before: float | None = None) -> list[dict]:
        if unlabeled_before is None:
            return [self._dec(r) for r in self._exec("SELECT * FROM deploy_records ORDER BY deployed_at")]
        return [self._dec(r) for r in self._exec(
            "SELECT * FROM deploy_records WHERE label IS NULL AND deployed_at < ? ORDER BY deployed_at", (unlabeled_before,))]

    def label_deploy(self, id_: str, label: int, at: float) -> None:
        self._update("deploy_records", id_, {"label": label, "labeled_at": at})

    def save_model(self, weights: dict, n: int, positives: int, ll_prior: float, ll_fit: float, at: float) -> dict:
        row = {"id": uuid7(), "weights": weights, "n": n, "positives": positives, "logloss_prior": ll_prior,
               "logloss_fit": ll_fit, "created_at": at}
        self._insert("risk_models", row)
        return row

    def latest_model(self) -> dict | None:
        rows = self._exec("SELECT * FROM risk_models ORDER BY created_at DESC LIMIT 1")
        return self._dec(rows[0]) if rows else None

    def add_status_update(self, incident_id: str, status: str, message: str, author: str, at: float,
                          title: str | None = None, impact: str | None = None) -> dict:
        row = {"id": uuid7(), "incident_id": incident_id, "status": status, "impact": impact, "title": title,
               "message": message, "author": author, "created_at": at}
        self._insert("status_updates", row)
        return row

    def status_updates(self, incident_id: str) -> list[dict]:
        return self._exec("SELECT * FROM status_updates WHERE incident_id = ? ORDER BY created_at, id", (incident_id,))

    def add_drill(self, **fields) -> dict:
        row = {"id": uuid7(), "status": "running", "created_at": time.time(), **fields}
        self._insert("drills", row)
        return self.get_drill(row["id"])

    def get_drill(self, id_: str) -> dict | None:
        rows = self._exec("SELECT * FROM drills WHERE id = ?", (id_,))
        return rows[0] if rows else None

    def update_drill(self, id_: str, **fields) -> dict | None:
        self._update("drills", id_, fields)
        return self.get_drill(id_)

    def vuln_findings(self, open_only: bool = False) -> list[dict]:
        sql = "SELECT * FROM vuln_findings" + (" WHERE resolved_at IS NULL" if open_only else "")
        return self._exec(sql + " ORDER BY first_seen")

    def upsert_vuln(self, key: str, fields: dict, now: float) -> None:
        if self._exec("SELECT id FROM vuln_findings WHERE id = ?", (key,)):
            self._update("vuln_findings", key, {**fields, "last_seen": now, "resolved_at": None})
        else:
            self._insert("vuln_findings", {"id": key, **fields, "first_seen": now, "last_seen": now, "resolved_at": None})

    def resolve_vuln(self, key: str, now: float) -> None:
        self._update("vuln_findings", key, {"resolved_at": now})

    def threat_intel(self) -> dict[str, dict]:
        return {r["id"]: r for r in self._exec("SELECT * FROM threat_intel")}

    def put_threat_intel(self, rows: dict[str, dict], now: float) -> None:
        known = set(self.threat_intel())
        for cve, f in rows.items():
            if cve in known:
                self._update("threat_intel", cve, {**f, "updated_at": now})
            else:
                self._insert("threat_intel", {"id": cve, **f, "updated_at": now})

    def running_drill(self) -> dict | None:
        rows = self._exec("SELECT * FROM drills WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
        return rows[0] if rows else None

    def drills(self, limit: int = 200) -> list[dict]:
        return self._exec("SELECT * FROM drills ORDER BY started_at DESC LIMIT ?", (limit,))

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
