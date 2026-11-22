#!/usr/bin/env python3
"""Ghi một lần promote thật vào vòng học change-risk của AIOps (POST /change-risk/deploys).

So images.yaml môi trường đích (trước) với nguồn (sau): service nào đổi tag `sha-<commit>` thì lấy
`git diff --numstat <cũ>..<mới> -- services/<svc> packages/` trong repo ứng dụng → danh sách file + số dòng.
Tag cũ không tồn tại trong lịch sử (vd sha-0000000 lúc khởi tạo) thì bỏ service đó. Không có gì đổi → không gửi.

  python scripts/ci/record_deploy.py --before old.yaml --after new.yaml --repo . --url "$AIOPS_URL" --ref "promote dev→staging"
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request

import yaml


def tags(path: str) -> dict[str, str]:
    imgs = (yaml.safe_load(open(path)) or {}).get("images") or {}
    return {s: str((v or {}).get("tag") or "") for s, v in imgs.items()}


def commit(tag: str) -> str | None:
    return tag[4:] if tag.startswith("sha-") and tag[4:].strip("0") else None


def changed_files(repo: str, before: dict[str, str], after: dict[str, str]) -> tuple[list[str], list[dict]]:
    svcs, files = [], {}
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
    return svcs, [{"path": p, "lines": n} for p, n in sorted(files.items())]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--url", required=True, help="gốc AIOps, vd https://aiops.shopnow.internal")
    ap.add_argument("--ref", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    svcs, files = changed_files(a.repo, tags(a.before), tags(a.after))
    if not files:
        print("không có service nào đổi tag — bỏ qua")
        return 0
    body = {"files": files, "ref": a.ref or ",".join(svcs)}
    if a.dry_run:
        print(json.dumps(body, ensure_ascii=False))
        return 0
    req = urllib.request.Request(a.url.rstrip("/") + "/change-risk/deploys", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {a.token}"} if a.token else {})})
    with urllib.request.urlopen(req, timeout=15) as r:
        print(r.read().decode())
    return 0


if __name__ == "__main__":
    sys.exit(main())
