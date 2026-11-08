CREATE TABLE shops (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE,              -- mỗi user tối đa 1 shop
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  logo_url TEXT,
  phone TEXT NOT NULL,
  pickup_address JSONB NOT NULL,
  pickup_province TEXT NOT NULL,
  -- KYC: số giấy tờ / số tài khoản mã hoá AES-256-GCM, chỉ giữ 4 số cuối để hiển thị dạng che
  legal_name TEXT NOT NULL,
  tax_code TEXT,
  id_number_enc TEXT NOT NULL,
  id_number_last4 TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  bank_account_enc TEXT NOT NULL,
  bank_account_last4 TEXT NOT NULL,
  bank_holder TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')),
  reject_reason TEXT,
  suspend_reason TEXT,
  follower_count INT NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shops_status_idx ON shops (status, submitted_at);

CREATE TABLE shop_followers (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, user_id)
);
CREATE INDEX shop_followers_user_idx ON shop_followers (user_id, created_at DESC);

-- Nhật ký duyệt / từ chối / khoá (audit)
CREATE TABLE shop_status_history (
  id UUID PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shop_status_history_shop_idx ON shop_status_history (shop_id, created_at);
