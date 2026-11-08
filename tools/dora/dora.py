#!/usr/bin/env python3
"""Tính 4 chỉ số DORA cho ShopNow từ lịch sử GitOps (nguồn sự thật của việc triển khai).

- Deployment frequency : số commit đổi environments/<env>/images.yaml trong repo shop-gitops / ngày.
- Lead time for changes: thời điểm deploy − thời điểm commit nguồn (dòng "Source: .../commit/<sha>").
- Change failure rate  : tỉ lệ deploy bị revert / rollback (commit "Revert" hoặc "rollback") hoặc
                          kéo theo incident AIOps trong 60 phút.
- MTTR                 : trung bình (resolved_at − detected_at) của incident từ aiops API (/incidents).

Chỉ dùng thư viện chuẩn. Ví dụ:
  GITHUB_TOKEN=... python3 tools/dora/dora.py --repo Luo-Zhii/shop-gitops --source-repo Luo-Zhii/shop-microservice \
      --env prod-onprem --days 30 [--aiops-url http://aiops:8120] [--output dora.md]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.github.com"


def gh(path: str, token: str | None):
    req = urllib.request.Request(API + path, headers={"Accept": "application/vnd.github+json", "User-Agent": "shopnow-dora"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def parse_time(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def deployments(repo: str, env: str, since: datetime, token: str | None):
    out, page = [], 1
    while True:
        commits = gh(f"/repos/{repo}/commits?path=environments/{env}/images.yaml&since={since.isoformat()}&per_page=100&page={page}", token)
        if not commits:
            break
        for c in commits:
            msg = c["commit"]["message"]
            out.append({
                "sha": c["sha"],
                "time": parse_time(c["commit"]["committer"]["date"]),
                "message": msg,
                "source": (re.search(r"/commit/([0-9a-f]{7,40})", msg) or [None, None])[1],
                "failure": bool(re.search(r"^(revert|rollback)", msg, re.I | re.M)),
            })
        page += 1
    return sorted(out, key=lambda d: d["time"])


def incidents(aiops_url: str | None):
    if not aiops_url:
        return []
    try:
        with urllib.request.urlopen(f"{aiops_url.rstrip('/')}/incidents?limit=500", timeout=10) as r:
            data = json.loads(r.read())
        return data.get("items", data) if isinstance(data, dict) else data
    except Exception as e:  # noqa: BLE001
        print(f"⚠ không đọc được incident từ aiops: {e}", file=sys.stderr)
        return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--source-repo", required=True)
    ap.add_argument("--env", default="prod-onprem")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--aiops-url")
    ap.add_argument("--output")
    a = ap.parse_args()
    token = os.environ.get("GITHUB_TOKEN")
    since = datetime.now(timezone.utc) - timedelta(days=a.days)

    deps = deployments(a.repo, a.env, since, token)
    lead = []
    for d in deps:
        if d["source"]:
            try:
                src = gh(f"/repos/{a.source_repo}/commits/{d['source']}", token)
                lead.append((d["time"] - parse_time(src["commit"]["author"]["date"])).total_seconds() / 3600)
            except Exception:  # noqa: BLE001
                pass
    incs = incidents(a.aiops_url)
    for d in deps:
        if any(i.get("detected_at") and timedelta(0) <= parse_time(i["detected_at"]) - d["time"] <= timedelta(minutes=60) for i in incs):
            d["failure"] = True
    mttr = [
        (parse_time(i["resolved_at"]) - parse_time(i["detected_at"])).total_seconds() / 60
        for i in incs if i.get("resolved_at") and i.get("detected_at")
    ]

    n = len(deps)
    rows = [
        ("Deployment frequency", f"{n / a.days:.2f} lần/ngày ({n} lần / {a.days} ngày)"),
        ("Lead time for changes (median)", f"{statistics.median(lead):.2f} giờ" if lead else "n/a"),
        ("Change failure rate", f"{100 * sum(d['failure'] for d in deps) / n:.1f}%" if n else "n/a"),
        ("MTTR (mean)", f"{statistics.mean(mttr):.1f} phút ({len(mttr)} incident)" if mttr else "n/a"),
    ]
    md = f"## DORA — `{a.env}` ({a.days} ngày gần nhất)\n\n| Chỉ số | Giá trị |\n|---|---|\n" + "\n".join(f"| {k} | {v} |" for k, v in rows) + "\n"
    print(md)
    if a.output:
        with open(a.output, "w", encoding="utf-8") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
