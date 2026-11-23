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


KEV = {"vulnerabilities": [{"cveID": "CVE-3", "dateAdded": "2027-01-20", "knownRansomwareCampaignUse": "Known"},
                           {"cveID": "CVE-999", "dateAdded": "2020-01-01"}]}


def fake_fetch(calls, kev=KEV, epss=None, fail_kev=False):
    def fetch(url, params):
        calls.append(url)
        if "cisa" in url:
            if fail_kev:
                raise OSError("mất mạng")
            return kev
        got = epss or {"CVE-1": "0.02", "CVE-2": "0.35"}
        return {"data": [{"cve": c, "epss": got[c], "percentile": "0.9"} for c in params["cve"].split(",") if c in got]}
    return fetch


def test_threat_intel_priority(tmp_path):
    from aiops.threatintel import kev_epoch, refresh

    st = IncidentStore(f"sqlite:///{tmp_path / 't.db'}")
    sync(st, R1, T0)                                      # T0 ≈ 2027-01-15
    calls = []
    out = refresh(st, fake_fetch(calls), T0)
    assert out["refreshed"] and out["kev"] == 1 and out["epss_high"] == 1 and not out["errors"]
    assert refresh(st, fake_fetch(calls), T0 + 3600)["refreshed"] is False and len(calls) == 2     # ≤ 1 lần/ngày
    r = report(st, T0 + 2 * DAY)
    by = {i["vuln_id"]: i for i in r["items"]}
    # CVE-3: HIGH (30 ngày) nhưng vào KEV ngày 20/01 — SAU lúc phát hiện → hạn = ngày vào KEV + 3 ngày, P1, ransomware
    kev_start = kev_epoch("2027-01-20")
    assert kev_start > T0 and by["CVE-3"]["priority"] == "P1" and by["CVE-3"]["kev_ransomware"]
    assert by["CVE-3"]["sla_days"] == round((kev_start + 3 * DAY - T0) / DAY, 1)
    # CVE-2: HIGH, EPSS 0.35 → P2, hạn 7 ngày; chưa có bản sửa → không phạt; không KEV → không cần mitigation
    assert by["CVE-2"]["priority"] == "P2" and by["CVE-2"]["sla_days"] == 7.0 and not by["CVE-2"]["needs_mitigation"]
    # CVE-1: CRITICAL, EPSS thấp → vẫn 7 ngày (tình báo không bao giờ NỚI hạn)
    assert by["CVE-1"]["priority"] == "P2" and by["CVE-1"]["sla_days"] == 7.0
    assert r["items"][0]["vuln_id"] == "CVE-3" and r["kev_open"] == 1 and r["open_by_priority"] == {"P1": 1, "P2": 2}
    later = report(st, kev_start + 4 * DAY)
    assert next(i for i in later["items"] if i["vuln_id"] == "CVE-3")["breach"]
    # KEV chưa có bản sửa → cần biện pháp tạm; lần làm mới sau mất mạng KEV → giữ cờ KEV cũ, EPSS vẫn cập nhật
    st2 = IncidentStore(f"sqlite:///{tmp_path / 't2.db'}")
    sync(st2, [rep("cart-5c6d7e8f9a", "cart", "ghcr.io/x/cart:sha-1", [("CVE-999", "HIGH", "busybox", "")])], T0)
    refresh(st2, fake_fetch([], epss={"CVE-999": "0.5"}), T0)
    assert report(st2, T0)["needs_mitigation"] == 1
    out = refresh(st2, fake_fetch([], epss={"CVE-999": "0.6"}, fail_kev=True), T0 + 2 * DAY)
    assert out["errors"] and st2.threat_intel()["CVE-999"]["kev"] == 1 and st2.threat_intel()["CVE-999"]["epss"] == 0.6


def test_api_threat_intel(tmp_path):
    from aiops.agent.kube import StaticInspector

    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        c.app.state.responder.inspector = StaticInspector(vulns=R1)
        c.app.state.responder.threat_fetch = fake_fetch([])
        r = c.post("/security/vulns/sync").json()
        assert r["threat_intel"]["kev"] == 1
        body = c.get("/security/vulns").json()
        assert body["kev_open"] == 1 and body["items"][0]["reasons"][-1].startswith("CISA KEV")
        assert "aiops_vuln_kev_open 1.0" in c.get("/metrics").text
