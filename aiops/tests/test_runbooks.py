"""Runbook-as-code: nạp đủ mục, khớp alert (kể cả mẫu *), chọn đúng runbook kèm bước khắc phục, MCP + planner trích làm
bằng chứng; mọi alert khai trong runbook phải có thật (hoặc là alert hệ thống chuẩn)."""

import re
from pathlib import Path

from aiops.runbooks import DEFAULT_DIR, for_incident, load, search

GITOPS = Path(__file__).resolve().parents[3] / "shop-gitops"


def test_load_and_match():
    secs = load()
    ids = {s["id"] for s in secs}
    assert len(ids) == 8 and all({"Triệu chứng", "Khắc phục"} <= {x["section"] for x in secs if x["id"] == i} for i in ids)
    r = for_incident({"service": "warehouse", "alerts": [{"alertname": "WarehousePickSlaBreach"}], "title": "phiếu quá hạn"})
    assert r[0]["runbook"] == "RB-005" and "người ca chiều" in r[0]["fix"] and r[0]["file"].startswith("aiops/runbooks/")
    # mẫu ShopNow*AvailabilityBurn khớp alert burn SLO của từng service
    assert for_incident({"service": "search", "alerts": [{"alertname": "ShopNowSearchAvailabilityBurn"}]})[0]["runbook"] == "RB-001"
    # truy vấn tự do có dấu/không dấu đều ra lệch tồn kho
    assert search("ton kho lech ban vuot ton")[0]["runbook"] == "RB-004"
    assert search("tồn kho lệch bán vượt tồn")[0]["runbook"] == "RB-004"
    assert len({x["runbook"] for x in search("lỗi", k=3)}) == 3          # không để một runbook chiếm hết top-k


def test_runbook_alerts_exist():
    """Alert khai trong front matter phải có trong rule GitOps/chart (hoặc là alert chuẩn kube-prometheus / của AIOps)."""
    if not GITOPS.exists():
        return
    real = set()
    for f in list((GITOPS / "platform").rglob("*.yaml")) + list((GITOPS / "charts").rglob("*.yaml")):
        real |= set(re.findall(r"(?:alert|name):\s*([A-Z][A-Za-z0-9]+)\b", f.read_text(errors="ignore")))
    std = {"CPUThrottlingHigh", "AIOpsAnomaly"}
    for s in load():
        for a in s["alerts"]:
            pat = re.compile("^" + re.escape(a).replace(r"\*", ".*") + "$")
            assert a in std or any(pat.match(x) for x in real), f"{s['id']}: alert {a} không tồn tại"


def test_planner_cites_runbook(tmp_path):
    from .test_agent_api import alert
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        inc = c.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [alert("catalog", name="ShopNowHighErrorRate")]}).json()
        inc_id = inc["incidents"][0]
        inv = c.post(f"/incidents/{inc_id}/agent-investigate").json()
        step = next(s for s in inv["steps"] if s["tool"] == "search_runbooks")
        assert inv["remediation"]["runbook"]["id"] == "RB-001"
        assert step["evidence"] in inv["remediation"]["reason"]                      # được trích làm bằng chứng
        assert c.get(f"/incidents/{inc_id}/runbooks").json()["items"][0]["runbook"] == "RB-001"
