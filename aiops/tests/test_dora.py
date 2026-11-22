"""DORA: ngưỡng xếp mức, cửa sổ hiện tại so với trước, lọc môi trường, mức tổng = chỉ số yếu nhất; migration cột trên DB cũ."""

import sqlite3

from aiops.agent.store import IncidentStore
from aiops.dora import DAY, band, report

NOW = 1_800_000_000.0


def test_band_thresholds():
    assert band("deployment_frequency", 3) == "elite" and band("deployment_frequency", 0.2) == "high"
    assert band("deployment_frequency", 0.05) == "medium" and band("deployment_frequency", 0.01) == "low"
    assert band("lead_time", 3600) == "elite" and band("lead_time", 3 * DAY) == "high" and band("lead_time", 40 * DAY) == "low"
    assert band("change_failure_rate", 0.05) == "elite" and band("change_failure_rate", 0.12) == "medium"
    assert band("change_failure_rate", 0.3) == "low" and band("time_to_restore", 1800) == "elite"
    assert band("time_to_restore", 2 * DAY) == "medium" and band("lead_time", None) is None


def test_report_windows_and_environment(tmp_path):
    st = IncidentStore(f"sqlite:///{tmp_path / 'd.db'}")
    # 30 ngày gần: 60 deploy prod (2/ngày), lead time 2h, 3/60 hỏng = 5%; thêm 30 deploy staging không tính khi lọc prod
    for k in range(60):
        d = st.add_deploy(f"p{k}", ["catalog"], {}, 0.1, NOW - k * 12 * 3600 - 60, lead_time_s=7200, environment="prod-onprem")
        st.label_deploy(d["id"], int(k < 3), NOW)
    for k in range(30):
        st.add_deploy(f"s{k}", ["catalog"], {}, 0.1, NOW - k * DAY - 60, lead_time_s=99 * DAY, environment="staging")
    # 30 ngày trước đó: 3 deploy prod, lead time 10 ngày, 1/3 hỏng
    for k in range(3):
        d = st.add_deploy(f"o{k}", ["order"], {}, 0.5, NOW - 35 * DAY - k * DAY, lead_time_s=10 * DAY, environment="prod-onprem")
        st.label_deploy(d["id"], int(k == 0), NOW)
    # sự cố: khôi phục 40 phút (tính từ fault_start) và 20 phút
    st.create_incident(service="catalog", status="resolved", detected_at=NOW - 5 * DAY, fault_start=NOW - 5 * DAY - 600,
                       resolved_at=NOW - 5 * DAY + 1800)
    st.create_incident(service="catalog", status="resolved", detected_at=NOW - 3 * DAY, resolved_at=NOW - 3 * DAY + 1200)
    r = report(st, NOW, 30, "prod-onprem")
    m = r["metrics"]
    assert m["deployment_frequency"]["value"] == 2.0 and m["deployment_frequency"]["band"] == "elite"
    assert m["lead_time"]["value"] == 7200 and m["lead_time"]["band"] == "elite"
    assert m["change_failure_rate"]["value"] == 0.05 and m["change_failure_rate"]["band"] == "elite"
    assert m["time_to_restore"]["value"] == 1800 and m["time_to_restore"]["band"] == "elite"   # trung vị (2400, 1200)
    assert m["lead_time"]["previous"] == 10 * DAY and m["lead_time"]["previous_band"] == "medium"
    assert m["change_failure_rate"]["previous"] == 0.333 and r["overall"] == "elite" and r["counts"]["deploys"] == 60
    # không lọc môi trường: staging lead time 99 ngày kéo trung vị lên, vẫn đủ 4 chỉ số
    assert report(st, NOW, 30)["counts"]["deploys"] == 90
    # thiếu dữ liệu một chỉ số → không xếp mức tổng
    assert report(st, NOW, 30, "prod-aws")["overall"] is None


def test_add_column_migration_on_old_db(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE deploy_records (id TEXT PRIMARY KEY, ref TEXT, services TEXT, features TEXT, "
                "probability DOUBLE PRECISION, deployed_at DOUBLE PRECISION, label INTEGER, labeled_at DOUBLE PRECISION)")
    con.execute("INSERT INTO deploy_records VALUES ('old', 'r', '[]', '{}', 0.1, 1.0, NULL, NULL)")
    con.commit()
    con.close()
    st = IncidentStore(f"sqlite:///{path}")
    IncidentStore(f"sqlite:///{path}")   # chạy lại không lỗi
    st.add_deploy("new", ["x"], {}, 0.2, 2.0, lead_time_s=60, environment="staging")
    rows = {d["id"] if d["id"] == "old" else "new": d for d in st.deploys()}
    assert rows["old"]["lead_time_s"] is None and rows["new"]["environment"] == "staging"
