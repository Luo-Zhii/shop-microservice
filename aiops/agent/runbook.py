"""Chọn hành động từ runbook YAML (luật đầu tiên khớp)."""

from __future__ import annotations

ACTIONS = {"rollback", "scale_up", "restart", "toggle_flag", "notify"}


def _match(when: dict, ctx: dict) -> bool:
    for key, want in (when or {}).items():
        if key in ("recent_deploy", "crashloop", "pod_restarted", "degradable"):
            if bool(ctx.get(key, False)) != bool(want):
                return False
        elif key == "symptoms_any":
            if not set(want or []) & set(ctx.get("symptoms") or []):
                return False
        elif key == "min_score":
            if float(ctx.get("score", 0)) < float(want):
                return False
        elif key == "services":
            if ctx.get("service") not in (want or []):
                return False
        else:
            raise ValueError(f"điều kiện runbook không hỗ trợ: {key}")
    return True


def choose_action(runbook: dict, ctx: dict) -> dict:
    """ctx = {service, recent_deploy, crashloop, pod_restarted, symptoms: [p95|err|cpu|rps|mem|dlq], score}.
    `degradable` tự suy từ runbook.degradable: service quá tải có tính năng phụ tắt được (kill switch) hay không."""
    degradable = runbook.get("degradable") or {}
    ctx = {**ctx, "degradable": ctx.get("service") in degradable}
    for rule in runbook.get("rules", []):
        if _match(rule.get("when") or {}, ctx):
            action = rule.get("action", "notify")
            if action not in ACTIONS:
                raise ValueError(f"hành động runbook không hợp lệ: {action}")
            params = dict(rule.get("params") or {})
            if action == "scale_up":
                params.setdefault("max_replicas", int(runbook.get("max_replicas", 6)))
            if action == "toggle_flag":   # chỉ TẮT (giảm tải); bật lại là quyết định của người, không tự động
                params.update(flag=degradable[ctx["service"]], variant="off")
            return {"rule": rule.get("name", action), "action": action, "params": params,
                    "approval": rule.get("approval", "required"), "reason": rule.get("reason", "")}
    return {"rule": "default", "action": "notify", "params": {}, "approval": "auto", "reason": "Không luật nào khớp."}
