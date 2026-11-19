"""Khắc phục qua GitOps: đề xuất của tác tử → bản vá repo shop-gitops → cổng xác minh → PR (người duyệt merge).

Cổng xác minh ("PR không được nói dối"): diff phải khớp đúng hành động + service đã nêu, chỉ chạm file được phép,
số dòng đổi nhỏ, và lý do phải trích evidence id có thật. Không qua cổng → không mở PR.
"""

from __future__ import annotations

import base64
import difflib
import logging
import re
import time

import httpx

log = logging.getLogger("aiops.gitops_pr")

IMAGE_LINE = re.compile(r'^(?P<indent>\s+)(?P<svc>[\w-]+):\s*\{tag:\s*"(?P<tag>[^"]*)",\s*digest:\s*"(?P<digest>[^"]*)"\}\s*$')
REPLICA_LINE = re.compile(r"^(?P<indent>\s*)replicas:\s*(?P<n>\d+)\s*$")


class PatchError(ValueError):
    pass


def _tag_of(image: str) -> str:
    return image.rsplit(":", 1)[1] if ":" in image.rsplit("/", 1)[-1] else ""


def patch_rollback(text: str, service: str, previous_tag: str) -> str:
    out, hit = [], False
    for line in text.splitlines():
        m = IMAGE_LINE.match(line)
        if m and m["svc"] == service:
            hit = True
            # digest cũ không còn khớp tag cũ → bỏ trống để Argo kéo theo tag (Kyverno vẫn kiểm chữ ký)
            line = f'{m["indent"]}{service}: {{tag: "{previous_tag}", digest: ""}}'
        out.append(line)
    if not hit:
        raise PatchError(f"không thấy {service} trong images.yaml")
    return "\n".join(out) + "\n"


def patch_replicas(text: str, add: int, ceiling: int) -> str:
    out, hit = [], False
    for line in text.splitlines():
        m = REPLICA_LINE.match(line)
        if m and not hit:
            hit = True
            line = f'{m["indent"]}replicas: {min(ceiling, int(m["n"]) + add)}'
        out.append(line)
    if not hit:
        out.append(f"replicas: {min(ceiling, 2 + add)}")
    return "\n".join(out) + "\n"


def build_change(remediation: dict, files: dict[str, str], env: str, deploys: list[dict], ceiling: int = 20) -> dict:
    """Trả {path, before, after, diff, title}. `files` = nội dung hiện tại theo đường dẫn trong repo gitops."""
    action, svc = remediation["action"], remediation["service"]
    if action == "rollback":
        path = f"environments/{env}/images.yaml"
        dep = next((d for d in deploys if d.get("name") == svc), None)
        prev = _tag_of((dep or {}).get("previous_images", [""])[0]) if dep else ""
        if not prev:
            raise PatchError(f"không biết image trước đó của {svc}")
        after = patch_rollback(files[path], svc, prev)
        title = f"fix({svc}): AIOps đề xuất rollback về {prev}"
    elif action == "scale_up":
        path = f"environments/{env}/services/{svc}.yaml"
        after = patch_replicas(files.get(path, ""), 2, ceiling)
        title = f"fix({svc}): AIOps đề xuất tăng replica"
    else:
        raise PatchError(f"hành động {action} không cần PR GitOps")
    before = files.get(path, "")
    diff = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), f"a/{path}", f"b/{path}"))
    return {"path": path, "before": before, "after": after, "diff": diff, "title": title}


def verify(change: dict, remediation: dict, evidence_ids: set[str], env: str, max_lines: int = 4) -> list[str]:
    """Cổng xác minh — trả danh sách lý do từ chối (rỗng = qua)."""
    problems: list[str] = []
    action, svc = remediation["action"], remediation["service"]
    allowed = {"rollback": f"environments/{env}/images.yaml", "scale_up": f"environments/{env}/services/{svc}.yaml"}
    if change["path"] != allowed.get(action):
        problems.append(f"file {change['path']} không khớp hành động {action}")
    changed = [ln for ln in change["diff"].splitlines() if ln[:1] in "+-" and not ln.startswith(("+++", "---"))]
    if not changed:
        problems.append("diff rỗng")
    if len(changed) > max_lines:
        problems.append(f"diff đổi {len(changed)} dòng > {max_lines}")
    if action == "rollback":
        for ln in changed:
            m = IMAGE_LINE.match(ln[1:])
            if not m or m["svc"] != svc:
                problems.append(f"dòng đổi không thuộc {svc}: {ln.strip()[:80]}")
    cites = set(re.findall(r"ev-\d+", remediation.get("reason", "")))
    if not cites:
        problems.append("lý do không trích bằng chứng (ev-N)")
    elif not cites <= evidence_ids:
        problems.append(f"trích bằng chứng không tồn tại: {sorted(cites - evidence_ids)}")
    return problems


class GitHubGitOps:
    """Đọc/ghi repo gitops qua GitHub REST. Không có token → chỉ dry-run (trả diff, không tạo PR)."""

    def __init__(self, repo: str, token: str | None, base: str = "main", transport: httpx.BaseTransport | None = None):
        self.repo, self.base, self.token = repo, base, token
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self.c = httpx.Client(base_url="https://api.github.com", headers=headers, timeout=15, transport=transport)

    def read(self, path: str) -> tuple[str, str | None]:
        r = self.c.get(f"/repos/{self.repo}/contents/{path}", params={"ref": self.base})
        if r.status_code == 404:
            return "", None
        r.raise_for_status()
        j = r.json()
        return base64.b64decode(j["content"]).decode(), j["sha"]

    def open_pr(self, change: dict, body: str, sha: str | None) -> dict:
        if not self.token:
            return {"dry_run": True}
        head = self.c.get(f"/repos/{self.repo}/git/ref/heads/{self.base}")
        head.raise_for_status()
        branch = f"aiops/{change['path'].split('/')[-1].split('.')[0]}-{int(time.time())}"
        self.c.post(f"/repos/{self.repo}/git/refs",
                    json={"ref": f"refs/heads/{branch}", "sha": head.json()["object"]["sha"]}).raise_for_status()
        put = {"message": change["title"], "branch": branch, "content": base64.b64encode(change["after"].encode()).decode()}
        if sha:
            put["sha"] = sha
        self.c.put(f"/repos/{self.repo}/contents/{change['path']}", json=put).raise_for_status()
        pr = self.c.post(f"/repos/{self.repo}/pulls",
                         json={"title": change["title"], "head": branch, "base": self.base, "body": body, "draft": False})
        pr.raise_for_status()
        return {"dry_run": False, "number": pr.json()["number"], "url": pr.json()["html_url"], "branch": branch}


def propose_pr(investigation: dict, gh: GitHubGitOps, env: str, ceiling: int = 20) -> dict:
    from ..metrics import GITOPS_PRS

    rem = investigation["remediation"]
    if not rem.get("allowed") or rem["action"] not in ("rollback", "scale_up"):
        return {"status": "skipped", "reason": rem.get("interlock") or f"{rem['action']} không cần PR"}
    deploys = next((e["data"].get("changes", []) for e in investigation["evidence"]
                    if e["tool"] == "recent_deployments" and e["ok"]), [])
    path = (f"environments/{env}/images.yaml" if rem["action"] == "rollback"
            else f"environments/{env}/services/{rem['service']}.yaml")
    text, sha = gh.read(path)
    try:
        change = build_change(rem, {path: text}, env, deploys, ceiling)
    except PatchError as e:
        GITOPS_PRS.labels(rem["action"], "patch_error").inc()
        return {"status": "rejected", "problems": [str(e)]}
    problems = verify(change, rem, {e["id"] for e in investigation["evidence"] if e["ok"]}, env)
    if problems:
        GITOPS_PRS.labels(rem["action"], "rejected").inc()
        return {"status": "rejected", "problems": problems, "diff": change["diff"]}
    hyp = "\n".join(f"- **{h['service']}**: {h['cause']} (độ tin {h['confidence']:.0%}, bằng chứng {', '.join(h['evidence'])})"
                    for h in investigation["hypotheses"]) or "- (không có)"
    body = (f"PR do tác tử AIOps tạo cho sự cố `{investigation['incident_id']}` — **cần người duyệt**.\n\n"
            f"### Giả thuyết\n{hyp}\n\n### Hành động\n`{rem['action']}` {rem['service']}: {rem['reason']}\n\n"
            f"Cổng xác minh: diff khớp hành động, chỉ đổi `{change['path']}`, bằng chứng tồn tại. "
            f"Grounding {investigation['grounding']:.0%}, chi phí {investigation['cost']}.")
    pr = gh.open_pr(change, body, sha)
    GITOPS_PRS.labels(rem["action"], "dry_run" if pr.get("dry_run") else "opened").inc()
    return {"status": "proposed", "diff": change["diff"], "title": change["title"], **pr}
