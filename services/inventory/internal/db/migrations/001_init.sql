-- SKU do catalog phát (product.upserted / product.deleted). ID dạng chuỗi (UUID v7 của catalog).
CREATE TABLE skus (
  sku_id      TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  shop_id     TEXT NOT NULL,
  sku_code    TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX skus_shop_idx ON skus (shop_id, sku_id);
CREATE INDEX skus_product_idx ON skus (product_id);

-- Tồn kho: available = on_hand - reserved, không bao giờ âm (CHECK ở tầng DB).
CREATE TABLE stock (
  sku_id     TEXT PRIMARY KEY REFERENCES skus (sku_id),
  on_hand    INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version    BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_reserved_le_on_hand CHECK (reserved <= on_hand)
);

-- reservation_id = checkoutId của order. FAILED = giữ hàng thất bại (lưu để reserve trùng trả lại kết quả cũ).
CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  order_ids      TEXT[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL CHECK (status IN ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED', 'FAILED')),
  reason         TEXT,
  failed_sku_ids TEXT[] NOT NULL DEFAULT '{}',
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reservations_due_idx ON reservations (expires_at) WHERE status = 'RESERVED';

CREATE TABLE reservation_items (
  reservation_id TEXT NOT NULL REFERENCES reservations (reservation_id) ON DELETE CASCADE,
  sku_id         TEXT NOT NULL,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (reservation_id, sku_id)
);

-- Sổ nhập/xuất: delta trên on_hand (nhập tay, xuất khi commit đơn).
CREATE TABLE stock_movements (
  id            BIGSERIAL PRIMARY KEY,
  sku_id        TEXT NOT NULL,
  delta         INTEGER NOT NULL,
  on_hand_after INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  ref           TEXT,
  actor         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_sku_idx ON stock_movements (sku_id, created_at DESC);
