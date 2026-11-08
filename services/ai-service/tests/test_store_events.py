import copy
from datetime import datetime, timedelta, timezone

from ai_service.consumer import handle_message
from tests.conftest import PRODUCTS, order_completed, product_event


def test_idempotent_by_event_id(store):
    ev = order_completed("o-x", "u-z", ["p-loa"])
    assert store.apply_event("order.v1", ev) is True
    assert store.apply_event("order.v1", ev) is False
    assert sum(1 for r in store.all_purchases() if r[0] == "o-x") == 1


def test_non_approved_removed_and_delete(store):
    p = copy.deepcopy(PRODUCTS[0])
    p["status"] = "HIDDEN"
    p["updatedAt"] = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
    store.apply_event("catalog.product.v1", product_event(p))
    ids = {x["id"] for x in store.all_products()}
    assert "p-ao-thun" not in ids
    store.apply_event("catalog.product.v1", product_event(PRODUCTS[1], "product.deleted"))
    assert "p-ao-polo" not in {x["id"] for x in store.all_products()}


def test_out_of_order_update_ignored(store):
    newer = copy.deepcopy(PRODUCTS[2])
    newer["title"] = "Quần jean mới"
    newer["updatedAt"] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    older = copy.deepcopy(PRODUCTS[2])
    older["title"] = "Quần jean cũ"
    older["updatedAt"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    store.apply_event("catalog.product.v1", product_event(newer))
    store.apply_event("catalog.product.v1", product_event(older))
    got = next(x for x in store.all_products() if x["id"] == "p-quan-jean")
    assert got["title"] == "Quần jean mới"


def test_handle_message_results(store):
    changed = []
    raw = product_event(PRODUCTS[4])
    import json

    assert handle_message(store, "catalog.product.v1", json.dumps(raw).encode(), "ai-service", lambda: changed.append(1)) == "ok"
    assert handle_message(store, "catalog.product.v1", json.dumps(raw).encode(), "ai-service", lambda: None) == "duplicate"
    assert handle_message(store, "order.v1", b'{"id":"1","type":"order.created"}', "ai-service", lambda: None) == "ignored"
    assert handle_message(store, "order.v1", b"not json", "ai-service", lambda: None) == "dropped"
    assert changed == [1]
