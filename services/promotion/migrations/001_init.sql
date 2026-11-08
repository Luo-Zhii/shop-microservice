CREATE TABLE vouchers (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('PLATFORM', 'SHOP')),
  shop_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('PERCENT', 'FIXED', 'FREESHIP')),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0),
  max_discount BIGINT CHECK (max_discount IS NULL OR max_discount >= 0),
  min_order BIGINT NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  usage_limit INT CHECK (usage_limit IS NULL OR usage_limit > 0),
  per_user_limit INT CHECK (per_user_limit IS NULL OR per_user_limit > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((scope = 'SHOP') = (shop_id IS NOT NULL))
);
CREATE INDEX vouchers_shop_idx ON vouchers (scope, shop_id, ends_at);

-- Một voucher được khoá cho một checkout (LOCKED) → dùng (USED) khi order.confirmed → nhả (RELEASED) khi huỷ.
CREATE TABLE redemptions (
  id UUID PRIMARY KEY,
  voucher_id UUID NOT NULL REFERENCES vouchers(id),
  checkout_id UUID NOT NULL,
  buyer_id TEXT NOT NULL,
  shop_id TEXT, -- NULL = voucher sàn
  amount BIGINT NOT NULL,
  allocation JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('LOCKED', 'USED', 'RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (voucher_id, checkout_id)
);
CREATE INDEX redemptions_usage_idx ON redemptions (voucher_id, buyer_id) WHERE status <> 'RELEASED';
CREATE INDEX redemptions_checkout_idx ON redemptions (checkout_id);

-- Kết quả quote commit=true (idempotent theo checkoutId)
CREATE TABLE quotes (
  checkout_id UUID PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE flash_sales (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX flash_sales_time_idx ON flash_sales (starts_at, ends_at);

CREATE TABLE flash_sale_items (
  id UUID PRIMARY KEY,
  flash_sale_id UUID NOT NULL REFERENCES flash_sales(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  sale_price BIGINT NOT NULL CHECK (sale_price >= 0),
  quota INT NOT NULL CHECK (quota > 0),
  per_user_limit INT CHECK (per_user_limit IS NULL OR per_user_limit > 0),
  UNIQUE (flash_sale_id, sku_id)
);
CREATE INDEX flash_items_sku_idx ON flash_sale_items (sku_id);

-- Bản ghi suất đã giữ (bộ đếm nguyên tử nằm ở Redis, đây là sổ sách để nhả / thống kê).
CREATE TABLE flash_sale_holds (
  id UUID PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES flash_sale_items(id) ON DELETE CASCADE,
  checkout_id UUID NOT NULL,
  buyer_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  status TEXT NOT NULL CHECK (status IN ('LOCKED', 'USED', 'RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, checkout_id)
);
CREATE INDEX flash_holds_checkout_idx ON flash_sale_holds (checkout_id);
