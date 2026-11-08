from aiops.agent.executor import Executor
from aiops.agent.kube import RecordingBackend, changes_from_replicasets, pod_health_from_pods, previous_template
from aiops.agent.runbook import choose_action
from aiops.config import load_settings


def rs(rev, created, image, owner="order", kind="Deployment"):
    return {"metadata": {"name": f"{owner}-{rev}", "annotations": {"deployment.kubernetes.io/revision": str(rev)},
                         "creationTimestamp": created, "ownerReferences": [{"kind": kind, "name": owner, "uid": "u1"}]},
            "spec": {"template": {"metadata": {"labels": {"app": owner, "pod-template-hash": f"h{rev}"}},
                                  "spec": {"containers": [{"name": owner, "image": image}]}}}}


def test_recent_changes_and_previous_template():
    items = [rs(1, "2026-11-08T08:00:00Z", "order:1"), rs(2, "2026-11-08T10:00:00Z", "order:2"),
             rs(1, "2026-11-08T07:00:00Z", "cat:1", owner="catalog")]
    since = 1794125000.0  # 2026-11-08T09:23Z
    ch = changes_from_replicasets(items, since)
    assert [c["name"] for c in ch] == ["order"] and ch[0]["previous_images"] == ["order:1"]
    tpl = previous_template(items[:2], 2)
    assert tpl["spec"]["containers"][0]["image"] == "order:1" and "pod-template-hash" not in tpl["metadata"]["labels"]


def test_pod_health_crashloop():
    pods = [{"status": {"conditions": [{"type": "Ready", "status": "False"}], "containerStatuses": [
        {"restartCount": 5, "state": {"waiting": {"reason": "CrashLoopBackOff"}},
         "lastState": {"terminated": {"reason": "OOMKilled", "finishedAt": "2026-11-08T10:00:00Z"}}}]}}]
    h = pod_health_from_pods(pods, now=1794132000.0)
    assert h["crashloop"] and h["pod_restarted"] and "OOMKilled" in h["reasons"] and h["ready"] == 0


def test_runbook_rules():
    rb = load_settings().runbook
    assert choose_action(rb, {"recent_deploy": True, "symptoms": ["p95"]})["action"] == "rollback"
    assert choose_action(rb, {"crashloop": True})["action"] == "restart"
    assert choose_action(rb, {"pod_restarted": True})["action"] == "notify"
    d = choose_action(rb, {"symptoms": ["cpu"]})
    assert d["action"] == "scale_up" and d["params"] == {"step": 1, "max_replicas": 6}
    assert choose_action(rb, {"symptoms": ["err"]})["action"] == "notify"


def test_executor_allowlist_and_dry_run(tmp_path):
    be = RecordingBackend()
    a = {"id": "a1", "type": "scale_up", "target": {"namespace": "shopnow", "kind": "Deployment", "name": "order"},
         "params": {"step": 1, "max_replicas": 3}}
    ex = Executor(be, ["shopnow"], ["rollback", "scale_up", "restart"], dry_run=True, audit_path=str(tmp_path / "a.jsonl"))
    assert ex.execute(a)["result"] == "dry_run" and be.calls == []
    assert ex.execute({**a, "target": {**a["target"], "namespace": "kube-system"}})["result"] == "denied"
    assert ex.execute({**a, "type": "delete_namespace"})["result"] == "denied"
    ex.dry_run = False
    assert ex.execute(a)["detail"] == {"from": 2, "to": 3}
    assert ex.execute(a)["detail"] == {"from": 3, "to": 3}  # chặn bởi max_replicas
    assert len((tmp_path / "a.jsonl").read_text().splitlines()) == 5
