import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

TEST_DB_URL = os.getenv("AI_TEST_DATABASE_URL", "postgresql://shopnow:shopnow@localhost:55432/ai_test")


def _ensure_db(url: str) -> None:
    import psycopg

    base, name = url.rsplit("/", 1)
    with psycopg.connect(f"{base}/postgres", autocommit=True, connect_timeout=5) as c:
        if not c.execute("SELECT 1 FROM pg_database WHERE datname=%s", (name,)).fetchone():
            c.execute(f'CREATE DATABASE "{name}"')


def P(pid, title, cat, catname, desc="", sold=0, rating=4.5, price=100000, brand=None, attrs=None, status="APPROVED"):
    now = datetime.now(timezone.utc).isoformat()
    return {"id": pid, "shopId": "shop-1", "shopName": "Shop Một", "categoryId": cat, "categoryPath": catname.split("/"),
            "title": title, "slug": pid, "description": desc, "brand": brand, "attributes": attrs or {},
            "images": [f"https://img/{pid}.jpg"], "status": status, "minPrice": price, "maxPrice": price,
            "ratingAvg": rating, "ratingCount": 10, "soldCount": sold, "variants": [], "createdAt": now, "updatedAt": now}


PRODUCTS = [
    P("p-ao-thun", "Áo thun nam cotton cổ tròn", "c-ao", "Thời trang/Áo nam", "Áo thun 100% cotton thoáng mát", 500,
      attrs={"Chất liệu": "Cotton", "Màu": "Đen"}),
    P("p-ao-polo", "Áo polo nam vải cá sấu", "c-ao", "Thời trang/Áo nam", "Áo polo lịch sự, vải cá sấu co giãn", 120),
    P("p-quan-jean", "Quần jean nam ống đứng", "c-quan", "Thời trang/Quần nam", "Quần jean denim bền màu", 300),
    P("p-tai-nghe", "Tai nghe bluetooth chống ồn", "c-audio", "Điện tử/Âm thanh", "Tai nghe không dây pin 30 giờ", 800,
      brand="Sony", price=1500000),
    P("p-loa", "Loa bluetooth mini chống nước", "c-audio", "Điện tử/Âm thanh", "Loa di động âm bass mạnh", 50),
    P("p-sac", "Củ sạc nhanh 20W USB-C", "c-phukien", "Điện tử/Phụ kiện", "Sạc nhanh cho điện thoại", 1000),
    P("p-cap", "Cáp sạc USB-C to Lightning 1m", "c-phukien", "Điện tử/Phụ kiện", "Cáp sạc bọc dù bền", 700),
    P("p-noi", "Nồi chiên không dầu 5 lít", "c-bep", "Nhà cửa/Đồ bếp", "Nồi chiên không dầu dung tích lớn", 60),
]


def order_completed(order_id, buyer, pids, days_ago=1):
    t = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    return {"id": str(uuid.uuid4()), "type": "order.completed", "source": "order", "time": t, "subject": order_id,
            "data": {"id": order_id, "checkoutId": "ck", "buyerId": buyer, "shopId": "shop-1", "status": "COMPLETED",
                     "items": [{"skuId": f"s-{p}", "productId": p, "title": p, "variantLabel": "", "unitPrice": 1,
                                "qty": 1, "lineTotal": 1} for p in pids],
                     "subtotal": 1, "shippingFee": 0, "discount": 0, "total": 1, "paymentMethod": "COD",
                     "shippingAddress": {}, "createdAt": t}}


def product_event(p, etype="product.upserted"):
    return {"id": str(uuid.uuid4()), "type": etype, "source": "catalog", "time": p.get("updatedAt"),
            "subject": p["id"], "data": p if etype == "product.upserted" else {"productId": p["id"]}}


ORDERS = [
    order_completed("o1", "u-a", ["p-sac", "p-cap"]),
    order_completed("o2", "u-b", ["p-sac", "p-cap", "p-tai-nghe"]),
    order_completed("o3", "u-c", ["p-ao-thun", "p-quan-jean"]),
    order_completed("o4", "u-d", ["p-ao-thun", "p-quan-jean"]),
    order_completed("o5", "u-e", ["p-tai-nghe", "p-loa"]),
    order_completed("o6", "u-a", ["p-ao-thun"], days_ago=0),
]


@pytest.fixture(scope="session")
def pg_store():
    from ai_service.store import PgStore

    _ensure_db(TEST_DB_URL)
    st = PgStore(TEST_DB_URL)
    st.migrate()
    yield st
    st.close()


@pytest.fixture()
def store(pg_store):
    pg_store.truncate()
    for p in PRODUCTS:
        assert pg_store.apply_event("catalog.product.v1", product_event(p))
    for o in ORDERS:
        assert pg_store.apply_event("order.v1", o)
    return pg_store


@pytest.fixture()
def client(store, monkeypatch):
    from fastapi.testclient import TestClient

    from ai_service.app import create_app
    from ai_service.config import Settings
    from ai_service.llm import NoneProvider

    s = Settings()
    s.kafka_enabled = False
    s.database_url = TEST_DB_URL
    s.rebuild_interval_s = 3600
    app = create_app(s, store=store, llm=NoneProvider())
    with TestClient(app) as c:
        yield c
