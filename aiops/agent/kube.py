"""Kubernetes: đọc triển khai gần đây / sức khoẻ pod (inspector) và thực thi hành động (backend).

Hỗ trợ Deployment và Argo Rollout (CRD argoproj.io/v1alpha1). Các hàm thuần (`changes_from_replicasets`,
`previous_template`, `pod_health_from_pods`) làm việc trên dict đã serialize nên test được không cần cluster.
"""

from __future__ import annotations

import copy
import logging
import time
from datetime import datetime, timezone
from typing import Protocol

from ..util import parse_ts

log = logging.getLogger("aiops.kube")

ARGO = dict(group="argoproj.io", version="v1alpha1", plural="rollouts")
REV_ANN = ("deployment.kubernetes.io/revision", "rollout.argoproj.io/revision")


# ---------------------------------------------------------------- hàm thuần
def _rev(obj: dict) -> int:
    ann = (obj.get("metadata") or {}).get("annotations") or {}
    for k in REV_ANN:
        if k in ann:
            try:
                return int(ann[k])
            except ValueError:
                pass
    return 0


def _owner(obj: dict) -> tuple[str, str] | None:
    for ref in (obj.get("metadata") or {}).get("ownerReferences") or []:
        if ref.get("kind") in ("Deployment", "Rollout"):
            return ref["kind"], ref["name"]
    return None


def _images(rs: dict) -> list[str]:
    return [c.get("image") for c in (((rs.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers", [])]


def changes_from_replicasets(rs_items: list[dict], since: float) -> list[dict]:
    """ReplicaSet mới nhất của mỗi workload được tạo sau `since` (và revision > 1) = một lần triển khai mới."""
    by_owner: dict[tuple[str, str], list[dict]] = {}
    for rs in rs_items:
        o = _owner(rs)
        if o:
            by_owner.setdefault(o, []).append(rs)
    out = []
    for (kind, name), items in by_owner.items():
        items.sort(key=_rev)
        newest = items[-1]
        created = parse_ts((newest.get("metadata") or {}).get("creationTimestamp"))
        if created is None or created < since or _rev(newest) <= 1:
            continue
        prev = items[-2] if len(items) > 1 else None
        out.append({"kind": kind, "name": name, "revision": _rev(newest), "changed_at": created,
                    "images": _images(newest), "previous_images": _images(prev) if prev else []})
    return sorted(out, key=lambda c: -c["changed_at"])


def previous_template(rs_items: list[dict], current_revision: int) -> dict | None:
    """Pod template của revision liền trước (giống `kubectl rollout undo`), bỏ nhãn pod-template-hash."""
    older = [rs for rs in rs_items if 0 < _rev(rs) < current_revision]
    if not older:
        return None
    tpl = copy.deepcopy(max(older, key=_rev)["spec"]["template"])
    labels = (tpl.get("metadata") or {}).get("labels") or {}
    labels.pop("pod-template-hash", None)
    labels.pop("rollouts-pod-template-hash", None)
    return tpl


def pod_health_from_pods(pods: list[dict], now: float, recent_s: float = 900) -> dict:
    crash, restarted, ready, total, restarts = False, False, 0, 0, 0
    reasons: list[str] = []
    for p in pods:
        total += 1
        st = p.get("status") or {}
        if any(c.get("type") == "Ready" and c.get("status") == "True" for c in st.get("conditions") or []):
            ready += 1
        for cs in st.get("containerStatuses") or []:
            restarts += int(cs.get("restartCount") or 0)
            waiting = ((cs.get("state") or {}).get("waiting") or {}).get("reason")
            if waiting == "CrashLoopBackOff":
                crash = True
                reasons.append(waiting)
            term = (cs.get("lastState") or {}).get("terminated") or {}
            fin = parse_ts(term.get("finishedAt"))
            if fin and now - fin <= recent_s:
                restarted = True
                if term.get("reason"):
                    reasons.append(term["reason"])
        started = parse_ts(st.get("startTime"))
        if started and now - started <= recent_s and (p.get("metadata") or {}).get("ownerReferences"):
            restarted = True
    return {"pods": total, "ready": ready, "restarts": restarts, "crashloop": crash, "pod_restarted": restarted,
            "reasons": sorted(set(reasons))}


# ---------------------------------------------------------------- giao diện
class ClusterInspector(Protocol):
    def recent_changes(self, namespace: str, since: float) -> list[dict]: ...
    def pod_health(self, namespace: str, service: str) -> dict: ...
    def workload(self, namespace: str, service: str) -> dict | None: ...


class NullInspector:
    """KUBE_ENABLED=false: không có thông tin cluster."""

    def recent_changes(self, namespace, since):
        return []

    def pod_health(self, namespace, service):
        return {}

    def workload(self, namespace, service):
        return {"kind": "Deployment", "name": service}


class StaticInspector:
    """Dùng cho test/dry-run: dữ liệu khai báo sẵn."""

    def __init__(self, changes: list[dict] | None = None, health: dict[str, dict] | None = None):
        self.changes, self.health = changes or [], health or {}

    def recent_changes(self, namespace, since):
        return [c for c in self.changes if c.get("changed_at", 0) >= since]

    def pod_health(self, namespace, service):
        return self.health.get(service, {})

    def workload(self, namespace, service):
        return {"kind": "Deployment", "name": service}


def _load_kube():
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except Exception:  # noqa: BLE001
        config.load_kube_config()
    return client


class KubeInspector:
    def __init__(self, label_key: str = "app.kubernetes.io/name"):
        self.k = _load_kube()
        self.api = self.k.ApiClient()
        self.apps, self.core, self.co = self.k.AppsV1Api(), self.k.CoreV1Api(), self.k.CustomObjectsApi()
        self.label_key = label_key

    def _ser(self, obj):
        return self.api.sanitize_for_serialization(obj)

    def recent_changes(self, namespace, since):
        rs = self._ser(self.apps.list_namespaced_replica_set(namespace).items)
        return changes_from_replicasets(rs, since)

    def pod_health(self, namespace, service):
        pods = self._ser(self.core.list_namespaced_pod(namespace, label_selector=f"{self.label_key}={service}").items)
        return pod_health_from_pods(pods, time.time())

    def workload(self, namespace, service):
        try:
            self.co.get_namespaced_custom_object(namespace=namespace, name=service, **ARGO)
            return {"kind": "Rollout", "name": service}
        except Exception:  # noqa: BLE001 - không có CRD hoặc không có Rollout
            return {"kind": "Deployment", "name": service}


# ---------------------------------------------------------------- thực thi
class ActionBackend(Protocol):
    def rollback(self, namespace: str, kind: str, name: str) -> dict: ...
    def scale_up(self, namespace: str, kind: str, name: str, step: int, max_replicas: int) -> dict: ...
    def restart(self, namespace: str, kind: str, name: str) -> dict: ...


class RecordingBackend:
    """Backend giả: ghi lại lời gọi (test, demo)."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.replicas: dict[str, int] = {}

    def rollback(self, namespace, kind, name):
        self.calls.append(("rollback", namespace, kind, name))
        return {"rolled_back": name}

    def scale_up(self, namespace, kind, name, step, max_replicas):
        cur = self.replicas.get(name, 2)
        new = min(cur + step, max_replicas)
        self.replicas[name] = new
        self.calls.append(("scale_up", namespace, kind, name, new))
        return {"from": cur, "to": new}

    def restart(self, namespace, kind, name):
        self.calls.append(("restart", namespace, kind, name))
        return {"restarted": name}


class KubeBackend:
    def __init__(self):
        self.k = _load_kube()
        self.api = self.k.ApiClient()
        self.apps, self.co = self.k.AppsV1Api(), self.k.CustomObjectsApi()
        self.hpa = self.k.AutoscalingV2Api()

    def _owned_rs(self, namespace: str, kind: str, uid: str) -> list[dict]:
        items = self.api.sanitize_for_serialization(self.apps.list_namespaced_replica_set(namespace).items)
        return [rs for rs in items if any(r.get("uid") == uid and r.get("kind") == kind
                                          for r in rs["metadata"].get("ownerReferences") or [])]

    def rollback(self, namespace, kind, name):
        if kind == "Rollout":
            ro = self.co.get_namespaced_custom_object(namespace=namespace, name=name, **ARGO)
            st = ro.get("status") or {}
            if st.get("currentPodHash") and st.get("stableRS") and st["currentPodHash"] != st["stableRS"]:
                # canary/blue-green đang dở → abort (Argo đưa traffic về bản stable)
                self.co.patch_namespaced_custom_object_status(namespace=namespace, name=name,
                                                              body={"status": {"abort": True}}, **ARGO)
                return {"mode": "abort", "stable": st["stableRS"]}
            rs = self._owned_rs(namespace, "Rollout", ro["metadata"]["uid"])
            tpl = previous_template(rs, _rev(ro))
            if tpl is None:
                raise RuntimeError("không có revision trước để undo")
            self.co.patch_namespaced_custom_object(namespace=namespace, name=name, body={"spec": {"template": tpl}}, **ARGO)
            return {"mode": "undo", "to_revision": _rev(ro) - 1}
        dep = self.api.sanitize_for_serialization(self.apps.read_namespaced_deployment(name, namespace))
        rs = self._owned_rs(namespace, "Deployment", dep["metadata"]["uid"])
        tpl = previous_template(rs, _rev(dep))
        if tpl is None:
            raise RuntimeError("không có revision trước để rollback")
        self.apps.patch_namespaced_deployment(name, namespace, {"spec": {"template": tpl}})
        return {"mode": "undo", "from_revision": _rev(dep)}

    def scale_up(self, namespace, kind, name, step, max_replicas):
        try:  # có HPA → nâng minReplicas để HPA không kéo xuống lại
            h = self.hpa.read_namespaced_horizontal_pod_autoscaler(name, namespace)
            cur = h.spec.min_replicas or 1
            new = min(cur + step, max_replicas, h.spec.max_replicas)
            self.hpa.patch_namespaced_horizontal_pod_autoscaler(name, namespace, {"spec": {"minReplicas": new}})
            return {"hpa": name, "from": cur, "to": new}
        except self.k.exceptions.ApiException as e:
            if e.status != 404:
                raise
        if kind == "Rollout":
            ro = self.co.get_namespaced_custom_object(namespace=namespace, name=name, **ARGO)
            cur = int((ro.get("spec") or {}).get("replicas") or 1)
            new = min(cur + step, max_replicas)
            self.co.patch_namespaced_custom_object(namespace=namespace, name=name, body={"spec": {"replicas": new}}, **ARGO)
            return {"from": cur, "to": new}
        sc = self.apps.read_namespaced_deployment_scale(name, namespace)
        cur = sc.spec.replicas or 1
        new = min(cur + step, max_replicas)
        self.apps.patch_namespaced_deployment_scale(name, namespace, {"spec": {"replicas": new}})
        return {"from": cur, "to": new}

    def restart(self, namespace, kind, name):
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if kind == "Rollout":
            self.co.patch_namespaced_custom_object(namespace=namespace, name=name, body={"spec": {"restartAt": now}}, **ARGO)
        else:
            self.apps.patch_namespaced_deployment(name, namespace, {"spec": {"template": {"metadata": {
                "annotations": {"kubectl.kubernetes.io/restartedAt": now}}}}})
        return {"restartedAt": now}
