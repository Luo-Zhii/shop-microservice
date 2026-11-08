-- Checkout = một lần bấm "Đặt hàng" (một reservation kho, một lần thanh toán), tách thành N order theo shop.
CREATE TABLE checkouts (
  id UUID PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  -- PENDING → AWAITING_PAYMENT → CONFIRMED | CANCELLED (trạng thái của saga, không phải của từng order)
  status TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  subtotal BIGINT NOT NULL,
  shipping_fee BIGINT NOT NULL,
  discount BIGINT NOT NULL,
  total BIGINT NOT NULL,
  voucher_codes JSONB NOT NULL DEFAULT '[]',
  shipping_address JSONB NOT NULL,
  promotion JSONB,
  payment_id TEXT,
  redirect_url TEXT,
  paid_at TIMESTAMPTZ,
  inventory_committed BOOLEAN NOT NULL DEFAULT false,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX checkouts_buyer_idx ON checkouts (buyer_id, created_at DESC);
CREATE INDEX checkouts_open_idx ON checkouts (created_at) WHERE status IN ('PENDING', 'AWAITING_PAYMENT');

-- Idempotency-Key: (buyer, key) → checkout. Ghi TRƯỚC khi gọi service khác để chặn request trùng chạy song song.
CREATE TABLE idempotency_keys (
  buyer_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  checkout_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS | DONE | FAILED
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_id, key)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  checkout_id UUID NOT NULL REFERENCES checkouts(id),
  buyer_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  status TEXT NOT NULL,
  subtotal BIGINT NOT NULL,
  shipping_fee BIGINT NOT NULL,
  shipping_fee_original BIGINT NOT NULL,
  discount BIGINT NOT NULL,
  total BIGINT NOT NULL,
  payment_method TEXT NOT NULL,
  shipping_address JSONB NOT NULL,
  applied_vouchers JSONB NOT NULL DEFAULT '[]',
  carrier TEXT,
  tracking_code TEXT,
  shipment_id TEXT,
  cancel_reason TEXT,
  return_reason TEXT,
  refunded BOOLEAN NOT NULL DEFAULT false,
  confirmed_at TIMESTAMPTZ,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_checkout_idx ON orders (checkout_id);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_shop_idx ON orders (shop_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, created_at DESC);
CREATE INDEX orders_delivered_idx ON orders (delivered_at) WHERE status = 'DELIVERED';

CREATE TABLE order_items (
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  variant_label TEXT NOT NULL DEFAULT '',
  image TEXT,
  list_price BIGINT NOT NULL,
  unit_price BIGINT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  line_total BIGINT NOT NULL,
  PRIMARY KEY (order_id, sku_id)
);

CREATE TABLE order_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_history_idx ON order_status_history (order_id, id);
