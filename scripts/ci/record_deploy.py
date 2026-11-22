#!/usr/bin/env python3
"""Ghi một lần promote thật vào vòng học change-risk của AIOps (POST /change-risk/deploys).

So images.yaml môi trường đích (trước) với nguồn (sau): service nào đổi tag `sha-<commit>` thì lấy
`git diff --numstat <cũ>..<mới> -- services/<svc> packages/` trong repo ứng dụng → danh sách file + số dòng.
Tag cũ không tồn tại trong lịch sử (vd sha-0000000 lúc khởi tạo) thì bỏ service đó. Không có gì đổi → không gửi.
Lead time (DORA) = trung vị (lúc deploy − lúc commit) của các commit mới trong khoảng đó.

  python scripts/ci/record_deploy.py --before old.yaml --after new.yaml --repo . --url "$AIOPS_URL" --ref "promote dev→staging"

Chế độ cổng (`--gate`, chạy TRƯỚC khi mở PR promote lên prod): gửi diff tới POST /change-risk; đang đóng băng quanh flash
sale mà không khai `--emergency` → thoát mã 2 (chặn). AIOps lỗi/không tới được → cảnh báo, cho qua (fail-open).
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
import urllib.request

import yaml


def tags(path: str) -> dict[str, str]:
    imgs = (yaml.safe_load(open(path)) or {}).get("images") or {}
    return {s: str((v or {}).get("tag") or "") for s, v in imgs.items()}


def commit(tag: str) -> str | None:
    return tag[4:] if tag.startswith("sha-") and tag[4:].strip("0") else None


def changed_files(repo: str, before: dict[str, str], after: dict[str, str]) -> tuple[list[str], list[dict]]:
    svcs, files, _ = changes(repo, before, after)
    return svcs, files


def changes(repo: str, before: dict[str, str], after: dict[str, str]) -> tuple[list[str], list[dict], list[int]]:
    """→ (service đổi tag, file đổi + số dòng, thời điểm commit của các commit mới)."""
    svcs, files, commits = [], {}, {}
    for svc, new in sorted(after.items()):
        old = before.get(svc, "")
        a, b = commit(old), commit(new)
        if new == old or not a or not b:
            continue
        r = subprocess.run(["git", "-C", repo, "diff", "--numstat", f"{a}..{b}", "--", f"services/{svc}", "packages/"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"bỏ {svc}: không diff được {a}..{b}", file=sys.stderr)
            continue
        svcs.append(svc)
        for line in r.stdout.splitlines():
            add, rem, p = line.split("\t", 2)
            files[p] = (int(add) if add.isdigit() else 0) + (int(rem) if rem.isdigit() else 0)
        log = subprocess.run(["git", "-C", repo, "log", "--format=%H %ct", f"{a}..{b}", "--", f"services/{svc}", "packages/"],
                             capture_output=True, text=True).stdout
        for ln in log.splitlines():
            h, ct = ln.split()
            commits[h] = int(ct)
    return svcs, [{"path": p, "lines": n} for p, n in sorted(files.items())], list(commits.values())


def lead_time(commit_ts: list[int], deployed_at: float) -> float | None:
    return round(statistics.median(max(0.0, deployed_at - t) for t in commit_ts), 1) if commit_ts else None


def _post(url: str, path: str, body: dict, token: str) -> dict:
    req = urllib.request.Request(url.rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode() or "{}")


def gate(result: dict) -> tuple[int, str]:
    """Kết quả /change-risk → (mã thoát, thông điệp). 2 = bị đóng băng, 0 = cho qua."""
    fz = result.get("freeze") or {}
    head = f"Rủi ro {result.get('level')} ({result.get('probability')}) · " + "; ".join(result.get("reasons") or [])
    if fz.get("active") and not fz.get("bypassed"):
        return 2, f"CHẶN — {result.get('policy')}. Chạy lại với emergency=true + lý do nếu là bản vá khẩn cấp.\n{head}"
    if fz.get("error"):
        return 0, f"CẢNH BÁO — {fz['error']}\n{head}"
    return 0, head


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--url", required=True, help="gốc AIOps, vd https://aiops.shopnow.internal")
    ap.add_argument("--ref", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--environment", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--gate", action="store_true", help="chấm rủi ro + kiểm đóng băng thay vì ghi deploy")
    ap.add_argument("--emergency", action="store_true")
    ap.add_argument("--reason", default="")
    a = ap.parse_args(argv)
    svcs, files, commit_ts = changes(a.repo, tags(a.before), tags(a.after))
    if not files:
        print("không có service nào đổi tag — bỏ qua")
        return 0
    body = {"files": files, "ref": a.ref or ",".join(svcs), "lead_time_s": lead_time(commit_ts, time.time()),
            "environment": a.environment or None}
    if a.dry_run:
        print(json.dumps(body, ensure_ascii=False))
        return 0
    if a.gate:
        try:
            res = _post(a.url, "/change-risk", {"files": files, "emergency": a.emergency, "reason": a.reason}, a.token)
        except (OSError, ValueError) as e:   # URLError/HTTPError là OSError
            print(f"CẢNH BÁO — không gọi được AIOps ({e}); cho qua (fail-open)")
            return 0
        code, msg = gate(res)
        print(msg)
        return code
    print(json.dumps(_post(a.url, "/change-risk/deploys", body, a.token), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
