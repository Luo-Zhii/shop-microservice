def test_health_ready_metrics(client):
    assert client.get("/healthz").json()["status"] == "ok"
    r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["checks"]["db"]
    client.get("/search/semantic", params={"q": "ao"})
    m = client.get("/metrics").text
    assert 'http_server_requests_seconds_bucket{le="0.005",method="GET",route="/search/semantic",service="ai-service",status="200"}' in m


def test_recommend_product_co_purchase(client):
    r = client.get("/recommendations/product/p-sac", params={"limit": 3}).json()
    assert r["strategy"] == "hybrid"
    assert r["items"][0]["id"] == "p-cap" and r["items"][0]["reason"] == "co_purchase"
    assert all(i["id"] != "p-sac" for i in r["items"])


def test_recommend_product_content_when_no_cooc(client):
    r = client.get("/recommendations/product/p-ao-polo", params={"limit": 3}).json()
    assert r["strategy"] == "content"
    assert r["items"][0]["id"] == "p-ao-thun"  # cùng danh mục áo nam


def test_recommend_unknown_product_popular(client):
    r = client.get("/recommendations/product/khong-co", params={"limit": 3}).json()
    assert r["strategy"] == "popular"
    assert [i["id"] for i in r["items"]] == ["p-sac", "p-tai-nghe", "p-cap"]


def test_recommend_user_history(client):
    r = client.get("/recommendations/user/u-c", params={"limit": 4}).json()
    assert r["strategy"] == "history"
    ids = [i["id"] for i in r["items"]]
    assert "p-ao-thun" not in ids and "p-quan-jean" not in ids  # loại đồ đã mua
    assert ids[0] == "p-ao-polo"


def test_recommend_new_user_popular(client):
    r = client.get("/recommendations/user/u-new").json()
    assert r["strategy"] == "popular" and len(r["items"]) == 8


def test_semantic_search_no_accents_and_typo(client):
    r = client.get("/search/semantic", params={"q": "tai nghe khong day"}).json()
    assert r["items"][0]["id"] == "p-tai-nghe"
    r = client.get("/search/semantic", params={"q": "noi chien khong dau"}).json()
    assert r["items"][0]["id"] == "p-noi"
    r = client.get("/search/semantic", params={"q": "quan jeen"}).json()  # gõ sai
    assert r["items"][0]["id"] == "p-quan-jean"


def test_chat_faq_fallback(client):
    r = client.post("/chat", json={"message": "Tôi muốn trả hàng thì làm thế nào?", "history": []}).json()
    assert r["provider"] == "none"
    assert r["sources"][0]["type"] == "faq" and r["sources"][0]["id"] == "return-policy"
    assert "7 ngày" in r["reply"]


def test_chat_unaccented_payment(client):
    r = client.post("/chat", json={"message": "thanh toan bang vnpay duoc khong"}).json()
    assert r["sources"][0]["id"] == "payment-methods"


def test_chat_product_suggestion(client):
    r = client.post("/chat", json={"message": "Tư vấn giúp mình mua tai nghe bluetooth"}).json()
    assert any(s["type"] == "product" and s["id"] == "p-tai-nghe" for s in r["sources"])
    assert "Tai nghe bluetooth" in r["reply"]


def test_chat_follow_up_uses_history(client):
    hist = [{"role": "user", "content": "Mã giảm giá dùng như thế nào?"}, {"role": "assistant", "content": "..."}]
    r = client.post("/chat", json={"message": "huỷ đơn thì sao?", "history": hist}).json()
    assert r["sources"][0]["id"] in {"voucher-refund", "cancel-order"}


def test_chat_validation_error(client):
    r = client.post("/chat", json={"message": ""})
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_generate_description_template(client):
    r = client.post("/generate/description", json={"title": "Áo thun nữ form rộng",
                                                  "attributes": {"chất liệu": "cotton", "màu": "trắng"},
                                                  "category": "Thời trang nữ"}).json()
    assert r["provider"] == "template"
    assert "Chất liệu: cotton" in r["description"] and "Giặt" in r["description"]


def test_moderate_endpoint(client):
    r = client.post("/moderate", json={"text": "hàng tốt, giao nhanh"}).json()
    assert r == {**r, "allowed": True, "labels": [], "score": 0.0}
    r = client.post("/moderate", json={"text": "đồ lừa đảo vcl, liên hệ 0987654321"}).json()
    assert not r["allowed"] and "profanity" in r["labels"]


def test_model_rebuilds_after_event(client, store):
    from tests.conftest import P, product_event

    store.apply_event("catalog.product.v1", product_event(P("p-moi", "Bình giữ nhiệt inox 1 lít", "c-bep", "Nhà cửa/Đồ bếp")))
    client.app.state.ai.mark_dirty()
    assert client.app.state.ai.rebuild() is True
    r = client.get("/search/semantic", params={"q": "binh giu nhiet"}).json()
    assert r["items"][0]["id"] == "p-moi"
