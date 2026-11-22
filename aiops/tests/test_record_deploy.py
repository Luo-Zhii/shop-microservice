"""scripts/ci/record_deploy.py: chỉ lấy diff của service đổi tag, bỏ tag khởi tạo sha-0000000."""

import importlib.util
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _mod():
    spec = importlib.util.spec_from_file_location("record_deploy", ROOT / "scripts/ci/record_deploy.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_changed_files_from_image_tags(tmp_path):
    m = _mod()
    g = lambda *a: subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True, text=True).stdout.strip()
    g("init", "-q")
    g("config", "user.email", "t@t"), g("config", "user.name", "t")
    for p in ("services/order/src/a.ts", "services/cart/src/b.ts"):
        (tmp_path / p).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / p).write_text("x\n")
    g("add", "."), g("commit", "-qm", "c1")
    c1 = g("rev-parse", "--short", "HEAD")
    (tmp_path / "services/order/src/a.ts").write_text("x\ny\nz\n")
    (tmp_path / "services/order/migrations").mkdir()
    (tmp_path / "services/order/migrations/002.sql").write_text("alter table t add c int;\n")
    (tmp_path / "services/cart/src/b.ts").write_text("changed\n")
    g("add", "."), g("commit", "-qm", "c2")
    c2 = g("rev-parse", "--short", "HEAD")
    before = {"order": f"sha-{c1}", "cart": f"sha-{c1}", "search": "sha-0000000"}
    after = {"order": f"sha-{c2}", "cart": f"sha-{c1}", "search": f"sha-{c2}"}
    svcs, files = m.changed_files(str(tmp_path), before, after)
    assert svcs == ["order"]   # cart không đổi tag, search từ tag khởi tạo → bỏ
    assert files == [{"path": "services/order/migrations/002.sql", "lines": 1}, {"path": "services/order/src/a.ts", "lines": 2}]
