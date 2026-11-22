"""Runbook-as-code + truy xuất (RAG không cần LLM): gợi ý ĐÚNG mục runbook cho sự cố đang mở.

Runbook là file markdown trong aiops/runbooks/ (front matter: services, alerts, tags; mục ## Triệu chứng / Chẩn đoán /
Khắc phục / Xác minh), được đóng gói vào image AIOps. Chỉ mục TF-IDF (unigram + bigram, bỏ dấu tiếng Việt) theo TỪNG MỤC;
điểm = cosine(truy vấn, mục) + thưởng khớp chính xác: alert (hỗ trợ `*`) +0.5, service +0.25. Kết quả là BẰNG CHỨNG cho
tác tử (công cụ MCP search_runbooks) và gợi ý cho người trực — không thực thi gì.
"""

from __future__ import annotations

import fnmatch
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import yaml

DEFAULT_DIR = Path(__file__).resolve().parent / "runbooks"
FRONT = re.compile(r"^---\n(.*?)\n---\n", re.S)


def fold(text: str) -> str:
    t = unicodedata.normalize("NFD", text.lower()).replace("đ", "d")
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def load(directory: Path = DEFAULT_DIR) -> list[dict]:
    sections = []
    for f in sorted(directory.glob("rb-*.md")):
        raw = f.read_text(encoding="utf-8")
        m = FRONT.match(raw)
        meta = yaml.safe_load(m.group(1)) if m else {}
        body = raw[m.end():] if m else raw
        for part in re.split(r"^## ", body, flags=re.M)[1:]:
            heading, _, text = part.partition("\n")
            sections.append({"id": meta.get("id", f.stem), "title": meta.get("title", f.stem), "file": f.name,
                             "section": heading.strip(), "text": " ".join(text.split()),
                             "services": list(meta.get("services") or []), "alerts": list(meta.get("alerts") or []),
                             "tags": list(meta.get("tags") or [])})
    return sections


@lru_cache(maxsize=4)
def _index(directory: str):
    from sklearn.feature_extraction.text import TfidfVectorizer

    secs = load(Path(directory))
    docs = [fold(f"{s['title']} {s['section']} {' '.join(s['tags'])} {' '.join(s['services'])} {' '.join(s['alerts'])} {s['text']}")
            for s in secs]
    vec = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, token_pattern=r"(?u)\b[\w-]{2,}\b")
    return secs, vec, vec.fit_transform(docs) if docs else None


def search(query: str, services: list[str] | None = None, alerts: list[str] | None = None, k: int = 3,
           directory: Path = DEFAULT_DIR) -> list[dict]:
    secs, vec, mat = _index(str(directory))
    if mat is None:
        return []
    sims = (mat @ vec.transform([fold(query)]).T).toarray().ravel()
    out = []
    for s, sim in zip(secs, sims):
        bonus = 0.0
        if alerts and any(fnmatch.fnmatch(a, pat) for a in alerts for pat in s["alerts"]):
            bonus += 0.5
        if services and set(services) & set(s["services"]):
            bonus += 0.25
        score = float(sim) + bonus
        if score > 0.05:
            out.append({"runbook": s["id"], "title": s["title"], "section": s["section"], "file": f"aiops/runbooks/{s['file']}",
                        "score": round(score, 3), "text": s["text"][:400]})
    out.sort(key=lambda r: -r["score"])
    # mỗi runbook chỉ lấy mục tốt nhất ở vòng đầu, rồi mới tới mục thứ hai — tránh một runbook chiếm hết top-k
    seen, first, rest = set(), [], []
    for r in out:
        (rest if r["runbook"] in seen else first).append(r)
        seen.add(r["runbook"])
    # người trực cần nhất mục "Khắc phục" — gắn kèm dù mục khớp tốt nhất là triệu chứng/chẩn đoán
    fix = {x["id"]: x["text"] for x in secs if x["section"].lower().startswith("khắc phục")}
    return [{**r, "fix": fix.get(r["runbook"], "")[:500]} for r in (first + rest)[:k]]


def for_incident(inc: dict, symptoms: list[str] | None = None, k: int = 3) -> list[dict]:
    alerts = [a.get("alertname") for a in (inc.get("alerts") or []) if a.get("alertname")]
    root = (inc.get("root_causes") or [{}])[0].get("service")
    svcs = [x for x in {inc.get("service"), root} if x]
    query = " ".join([*svcs, *alerts, *(symptoms or []), inc.get("title") or ""])
    return search(query, services=svcs, alerts=alerts, k=k)
