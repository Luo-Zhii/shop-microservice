"""Thực thi hành động có kiểm soát: allowlist namespace + loại hành động, DRY_RUN mặc định, audit JSONL."""

from __future__ import annotations

import json
import logging
import time

log = logging.getLogger("aiops.executor")


class Executor:
    def __init__(self, backend, allow_namespaces: list[str], allow_actions: list[str], dry_run: bool = True,
                 audit_path: str | None = None, store=None):
        self.backend, self.dry_run = backend, dry_run
        self.allow_ns, self.allow_actions = set(allow_namespaces), set(allow_actions)
        self.audit_path, self.store = audit_path, store

    def _audit(self, event: str, action: dict, details: dict) -> None:
        rec = {"ts": time.time(), "event": event, "action_id": action.get("id"), "incident_id": action.get("incident_id"),
               "type": action.get("type"), "target": action.get("target"), "dry_run": self.dry_run, **details}
        if self.audit_path:
            try:
                with open(self.audit_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            except OSError as e:
                log.error("không ghi được audit log: %s", e)
        if self.store is not None:
            self.store.audit("executor", event, action.get("incident_id"), action.get("id"), details)

    def execute(self, action: dict) -> dict:
        typ, target, params = action["type"], action.get("target") or {}, action.get("params") or {}
        ns, kind, name = target.get("namespace"), target.get("kind", "Deployment"), target.get("name")
        if typ not in self.allow_actions:
            res = {"result": "denied", "detail": f"hành động {typ} không nằm trong allowlist"}
        elif ns not in self.allow_ns:
            res = {"result": "denied", "detail": f"namespace {ns} không nằm trong allowlist"}
        elif not name:
            res = {"result": "denied", "detail": "thiếu tên workload"}
        elif self.dry_run:
            res = {"result": "dry_run", "detail": f"[DRY_RUN] sẽ {typ} {kind}/{name} ở {ns} params={params}"}
        else:
            try:
                if typ == "rollback":
                    out = self.backend.rollback(ns, kind, name)
                elif typ == "scale_up":
                    out = self.backend.scale_up(ns, kind, name, int(params.get("step", 1)), int(params.get("max_replicas", 6)))
                elif typ == "restart":
                    out = self.backend.restart(ns, kind, name)
                else:
                    raise ValueError(f"không hỗ trợ {typ}")
                res = {"result": "executed", "detail": out}
            except Exception as e:  # noqa: BLE001
                log.exception("thực thi %s thất bại", typ)
                res = {"result": "failed", "detail": str(e)}
        self._audit("execute", action, res)
        log.info("hành động %s %s/%s → %s", typ, ns, name, res["result"])
        return res
