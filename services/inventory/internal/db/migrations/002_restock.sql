-- inventory.restock: trả hàng về kho cho reservation đã COMMITTED (huỷ sau xác nhận / trả hàng), theo từng order.
-- Khoá chính (reservation_id, order_id) = khoá idempotent: gửi lại không cộng kho 2 lần.
CREATE TABLE reservation_restocks (
  reservation_id TEXT NOT NULL REFERENCES reservations (reservation_id) ON DELETE CASCADE,
  order_id       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, order_id)
);

CREATE TABLE reservation_restock_items (
  reservation_id TEXT NOT NULL,
  order_id       TEXT NOT NULL,
  sku_id         TEXT NOT NULL,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (reservation_id, order_id, sku_id),
  FOREIGN KEY (reservation_id, order_id) REFERENCES reservation_restocks (reservation_id, order_id) ON DELETE CASCADE
);
