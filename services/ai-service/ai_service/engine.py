"""Mô hình gợi ý + tìm kiếm ngữ nghĩa, dựng lại từ dữ liệu trong store.

- Content-based: TF-IDF từ (1–2 gram) trên tiêu đề/danh mục/thương hiệu/thuộc tính/mô tả đã bỏ dấu → cosine.
- Đồng mua item-item: ma trận đơn × sản phẩm X (nhị phân) → C = XᵀX, chuẩn hoá cosine C_ij/√(n_i n_j);
  thêm tín hiệu yếu hơn theo người mua (cùng người mua ở các đơn khác nhau).
- Tìm kiếm: TF-IDF ký tự (char_wb 2–4 gram, chịu lỗi chính tả/không dấu) + TF-IDF từ, tuỳ chọn embedding.
- Thiếu dữ liệu → bán chạy (soldCount, rồi số lần mua ghi nhận, rồi rating).
"""

from __future__ import annotations

import logging
import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer

from .text import normalize

log = logging.getLogger("ai_service.engine")

W_COOC = 0.6
W_CONTENT = 0.4
W_BUYER = 0.5  # trọng số đồng mua theo người mua so với đồng mua trong cùng đơn


def product_card(p: dict, score: float | None = None, reason: str | None = None) -> dict:
    images = p.get("images") or []
    card = {
        "id": p["id"],
        "productId": p["id"],
        "shopId": p.get("shopId"),
        "shopName": p.get("shopName"),
        "categoryId": p.get("categoryId"),
        "title": p.get("title"),
        "slug": p.get("slug"),
        "image": images[0] if images else None,
        "minPrice": p.get("minPrice"),
        "maxPrice": p.get("maxPrice"),
        "ratingAvg": p.get("ratingAvg", 0),
        "ratingCount": p.get("ratingCount", 0),
        "soldCount": p.get("soldCount", 0),
    }
    if score is not None:
        card["score"] = round(float(score), 4)
    if reason:
        card["reason"] = reason
    return card


def _content_text(p: dict) -> str:
    cat = " ".join(p.get("categoryPath") or [])
    attrs = " ".join(f"{k} {v}" for k, v in (p.get("attributes") or {}).items())
    title = p.get("title") or ""
    parts = [title, title, title, cat, cat, p.get("brand") or "", attrs, (p.get("description") or "")[:2000]]
    return normalize(" ".join(parts))


def _search_text(p: dict) -> str:
    cat = " ".join(p.get("categoryPath") or [])
    attrs = " ".join(str(v) for v in (p.get("attributes") or {}).values())
    return normalize(" ".join([p.get("title") or "", cat, p.get("brand") or "", attrs, (p.get("description") or "")[:300]]))


@dataclass
class CatalogIndex:
    products: list[dict] = field(default_factory=list)
    pos: dict[str, int] = field(default_factory=dict)
    word_vec: TfidfVectorizer | None = None
    word_mat: Any = None
    char_vec: TfidfVectorizer | None = None
    char_mat: Any = None
    cooc: Any = None  # sparse n×n đã chuẩn hoá, đường chéo 0
    history: dict[str, list[tuple[str, float]]] = field(default_factory=dict)  # buyer → [(pid, ts)] mới nhất trước
    popular: list[int] = field(default_factory=list)
    emb: np.ndarray | None = None
    built_at: float = 0.0
    n_orders: int = 0

    # ------------------------------------------------------------------ dựng
    @classmethod
    def build(cls, products: list[dict], purchases: list[tuple], embedder=None) -> "CatalogIndex":
        t0 = time.perf_counter()
        idx = cls(products=[p for p in products if p.get("id")])
        idx.pos = {p["id"]: i for i, p in enumerate(idx.products)}
        n = len(idx.products)
        if n:
            idx.word_vec = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), sublinear_tf=True, min_df=1)
            idx.word_mat = idx.word_vec.fit_transform([_content_text(p) for p in idx.products])
            idx.char_vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), sublinear_tf=True, min_df=1)
            idx.char_mat = idx.char_vec.fit_transform([_search_text(p) for p in idx.products])
        # đồng mua
        orders: dict[str, set[int]] = defaultdict(set)
        buyers: dict[str, set[int]] = defaultdict(set)
        bought_count = np.zeros(n)
        hist: dict[str, list[tuple[str, float]]] = defaultdict(list)
        for order_id, pid, buyer, qty, when in purchases:
            ts = when.timestamp() if hasattr(when, "timestamp") else float(when or 0)
            hist[buyer].append((pid, ts))
            i = idx.pos.get(pid)
            if i is None:
                continue
            orders[order_id].add(i)
            buyers[buyer].add(i)
            bought_count[i] += qty or 1
        idx.history = {b: sorted(v, key=lambda x: -x[1]) for b, v in hist.items()}
        idx.n_orders = len(orders)
        if n:
            idx.cooc = cls._cooc(orders.values(), n) + W_BUYER * cls._cooc(buyers.values(), n)
            sold = np.array([float(p.get("soldCount") or 0) for p in idx.products])
            rating = np.array([float(p.get("ratingAvg") or 0) for p in idx.products])
            idx.popular = list(np.lexsort((-rating, -bought_count, -sold)))
        if embedder is not None and n:
            try:
                idx.emb = _unit(np.array(embedder([_search_text(p) for p in idx.products]), dtype=float))
            except Exception as e:  # noqa: BLE001 - embedding là tuỳ chọn
                log.warning("không tính được embedding sản phẩm, dùng TF-IDF: %s", e)
        idx.built_at = time.time()
        log.info("dựng mô hình: %d sản phẩm, %d đơn, %.0f ms", n, idx.n_orders, (time.perf_counter() - t0) * 1000)
        return idx

    @staticmethod
    def _cooc(groups, n: int):
        rows, cols = [], []
        for g_i, items in enumerate(groups):
            for i in items:
                rows.append(g_i)
                cols.append(i)
        if not rows:
            return sparse.csr_matrix((n, n))
        x = sparse.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(max(rows) + 1, n))
        c = (x.T @ x).tocsr().astype(float)
        diag = c.diagonal()
        c.setdiag(0)
        c.eliminate_zeros()
        inv = np.zeros(n)
        nz = diag > 0
        inv[nz] = 1.0 / np.sqrt(diag[nz])
        d = sparse.diags(inv)
        return (d @ c @ d).tocsr()

    # ------------------------------------------------------------------ truy vấn
    def __len__(self) -> int:
        return len(self.products)

    def _content_row(self, i: int) -> np.ndarray:
        return np.asarray((self.word_mat @ self.word_mat[i].T).todense()).ravel()

    def _cooc_row(self, i: int) -> np.ndarray:
        row = np.asarray(self.cooc[i].todense()).ravel()
        m = row.max() if row.size else 0
        return row / m if m > 0 else row

    def _fill_popular(self, out: list[dict], limit: int, exclude: set[int]) -> list[dict]:
        for i in self.popular:
            if len(out) >= limit:
                break
            if i in exclude:
                continue
            exclude.add(i)
            out.append(product_card(self.products[i], 0.0, "popular"))
        return out

    def popular_items(self, limit: int, exclude_ids: set[str] | None = None) -> list[dict]:
        ex = {self.pos[x] for x in (exclude_ids or set()) if x in self.pos}
        return self._fill_popular([], limit, ex)

    def _rank(self, scores: np.ndarray, reasons: np.ndarray, limit: int, exclude: set[int]) -> list[dict]:
        out = []
        for i in np.argsort(-scores):
            if len(out) >= limit or scores[i] <= 1e-9:
                break
            if int(i) in exclude:
                continue
            exclude.add(int(i))
            out.append(product_card(self.products[i], scores[i], str(reasons[i])))
        return self._fill_popular(out, limit, exclude)

    def for_product(self, product_id: str, limit: int = 10) -> tuple[list[dict], str]:
        i = self.pos.get(product_id)
        if i is None:
            return self.popular_items(limit, {product_id}), "popular"
        cooc, content = self._cooc_row(i), self._content_row(i)
        same_cat = np.array([p.get("categoryId") == self.products[i].get("categoryId") for p in self.products])
        has_cooc = cooc.max() > 0
        scores = (W_COOC * cooc + W_CONTENT * content) if has_cooc else content.copy()
        scores = scores + 0.05 * same_cat * (scores > 0)
        reasons = np.where(cooc > 0, "co_purchase", "similar")
        return self._rank(scores, reasons, limit, {i}), ("hybrid" if has_cooc else "content")

    def for_user(self, user_id: str, limit: int = 10) -> tuple[list[dict], str]:
        hist = [(pid, ts) for pid, ts in self.history.get(user_id, []) if pid in self.pos]
        if not hist:
            return self.popular_items(limit), "popular"
        seen: dict[int, float] = {}
        for rank, (pid, _ts) in enumerate(hist[:20]):
            seen.setdefault(self.pos[pid], 0.85**rank)
        scores = np.zeros(len(self.products))
        cooc_total = np.zeros(len(self.products))
        for i, w in seen.items():
            cooc = self._cooc_row(i)
            cooc_total += w * cooc
            scores += w * (W_COOC * cooc + W_CONTENT * self._content_row(i))
        reasons = np.where(cooc_total > 0, "co_purchase", "similar")
        return self._rank(scores, reasons, limit, set(seen)), "history"

    def search(self, q: str, limit: int = 20, query_embedding: list[float] | None = None) -> tuple[list[dict], str]:
        nq = normalize(q)
        if not nq or not self.products:
            return [], "tfidf"
        char_s = (self.char_mat @ self.char_vec.transform([nq]).T).toarray().ravel()
        word_s = (self.word_mat @ self.word_vec.transform([nq]).T).toarray().ravel()
        scores = 0.6 * char_s + 0.4 * word_s
        mode = "tfidf"
        if query_embedding is not None and self.emb is not None:
            qe = _unit(np.array([query_embedding], dtype=float))[0]
            scores = 0.5 * scores + 0.5 * np.clip(self.emb @ qe, 0, 1)
            mode = "hybrid-embedding"
        pop = np.array([math.log1p(float(p.get("soldCount") or 0)) for p in self.products])
        scores = scores * (1 + 0.03 * pop)
        out = []
        for i in np.argsort(-scores)[:limit]:
            if scores[i] < 0.08:
                break
            out.append(product_card(self.products[i], scores[i], "match"))
        return out, mode


def _unit(m: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return m / norms


@dataclass
class FaqIndex:
    items: list[dict]
    word_vec: TfidfVectorizer
    word_mat: Any
    char_vec: TfidfVectorizer
    char_mat: Any

    @classmethod
    def build(cls, items: list[dict]) -> "FaqIndex":
        def doc(it: dict) -> str:
            tags = " ".join(it.get("tags") or [])
            return normalize(f"{it['question']} {it['question']} {tags} {tags} {it.get('topic', '')} {it['answer']}")

        def key(it: dict) -> str:
            return normalize(f"{it['question']} {' '.join(it.get('tags') or [])}")

        wv = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), sublinear_tf=True)
        cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), sublinear_tf=True)
        return cls(items, wv, wv.fit_transform([doc(i) for i in items]), cv, cv.fit_transform([key(i) for i in items]))

    def search(self, q: str, k: int = 3) -> list[tuple[dict, float]]:
        nq = normalize(q)
        if not nq:
            return []
        w = (self.word_mat @ self.word_vec.transform([nq]).T).toarray().ravel()
        c = (self.char_mat @ self.char_vec.transform([nq]).T).toarray().ravel()
        s = 0.5 * w + 0.5 * c
        order = np.argsort(-s)[:k]
        return [(self.items[i], float(s[i])) for i in order if s[i] > 0]


def load_faq(path: str) -> list[dict]:
    import yaml

    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or []
    for it in data:
        if not {"id", "question", "answer"} <= set(it):
            raise ValueError(f"FAQ thiếu trường: {it}")
    return data
