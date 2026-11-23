"""SLA vá lỗ hổng workload đang chạy: chuẩn hoá VulnerabilityReport, mới/đã vá/mở lại (giữ first_seen), chỉ phạt lỗ hổng
CÓ bản sửa, MTTR vá; endpoint đồng bộ + gauge."""

from aiops.agent.store import IncidentStore
from aiops.vulns import normalize, report, sync

DAY = 86400.0
T0 = 1_800_000_000.0


def rep(workload, container, image, vulns):
    return {"metadata": {"labels": {"trivy-operator.resource.kind": "ReplicaSet", "trivy-operator.resource.name": workload,
                                    "trivy-operator.container.name": container}},
            "report": {"artifact": {"repository": image.split(":")[0], "tag": image.split(":")[1]},
                       "vulnerabilities": [{"vulnerabilityID": i, "severity": s, "resource": p, "installedVersion": "1.0",
                                            "fixedVersion": fx, "title": f"{i} title"} for i, s, p, fx in vulns]}}


R1 = [rep("order-7d9f8b6c5d", "order", "ghcr.io/x/order:sha-a1", [("CVE-1", "CRITICAL", "openssl", "3.0.9"),
                                                           ("CVE-2", "HIGH", "zlib", ""),          # chưa có bản sửa
                                                           ("CVE-3", "HIGH", "glibc", "2.39")])]


def test_normalize():
    f = normalize(R1)
    assert len(f) == 3 and f[0]["workload"] == "order" and f[0]["image"] == "ghcr.io/x/order:sha-a1"   # bỏ hash ReplicaSet
    assert f[1]["fixed"] == "" and f[0]["severity"] == "CRITICAL"


def test_sync_and_sla(tmp_path):
    st = IncidentStore(f"sqlite:///{tmp_path / 'v.db'}")
    assert sync(st, R1, T0) == {"open": 3, "new": 3, "resolved": 0, "reopened": 0}
    r = report(st, T0 + 8 * DAY)
    by = {i["vuln_id"]: i for i in r["items"]}
    assert by["CVE-1"]["breach"] and by["CVE-1"]["due_in_days"] == -1.0           # CRITICAL quá 7 ngày
    assert not by["CVE-2"]["breach"] and by["CVE-2"]["fixable"] is False           # chưa có bản sửa → không phạt
    assert not by["CVE-3"]["breach"] and by["CVE-3"]["due_in_days"] == 22.0
    assert r["breaches"] == {"CRITICAL": 1} and r["items"][0]["vuln_id"] == "CVE-1"
    # deploy bản mới (ReplicaSet mới) đã vá CVE-1, CVE-2/3 vẫn còn → chỉ CVE-1 được tính đã vá; CVE-3 GIỮ tuổi
    R2 = [rep("order-8aa1b2c3d4", "order", "ghcr.io/x/order:sha-b2", [("CVE-2", "HIGH", "zlib", ""), ("CVE-3", "HIGH", "glibc", "2.39")])]
    out = sync(st, R2, T0 + 9 * DAY)
    assert out == {"open": 2, "new": 0, "resolved": 1, "reopened": 0}
    r = report(st, T0 + 9 * DAY)
    assert r["mttr_days"] == 9.0
    assert next(i for i in r["items"] if i["vuln_id"] == "CVE-3")["age_days"] == 9.0      # không bị reset bởi deploy
    # rollback về image cũ → CVE-1 mở lại, GIỮ first_seen (rollback không reset đồng hồ SLA)
    out = sync(st, R1, T0 + 10 * DAY)
    assert out["reopened"] == 1
    cve1 = next(i for i in report(st, T0 + 10 * DAY)["items"] if i["vuln_id"] == "CVE-1")
    assert cve1["age_days"] == 10.0 and cve1["breach"]


def test_api_sync(tmp_path):
    from aiops.agent.kube import StaticInspector

    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        c.app.state.responder.inspector = StaticInspector(vulns=R1)
        r = c.post("/security/vulns/sync").json()
        assert r["open"] == 3 and r["breaches"] == {}
        assert c.get("/security/vulns").json()["open_by_severity"] == {"CRITICAL": 1, "HIGH": 2}
        m = c.get("/metrics").text
        assert 'aiops_vuln_open{severity="CRITICAL"} 1.0' in m and 'aiops_vuln_sla_breaches{severity="CRITICAL"} 0.0' in m
