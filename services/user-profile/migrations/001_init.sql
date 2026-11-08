-- user_id là TEXT (giá trị `sub` của JWT do identity cấp — UUID v7)
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  avatar_url TEXT,
  gender TEXT CHECK (gender IN ('male', 'female', 'other')),
  birthday DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  line1 TEXT NOT NULL,
  ward TEXT NOT NULL,
  district TEXT NOT NULL,
  province TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id, created_at DESC);
-- Mỗi user tối đa một địa chỉ mặc định
CREATE UNIQUE INDEX addresses_one_default ON addresses (user_id) WHERE is_default;

CREATE TABLE wishlist (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX wishlist_user_idx ON wishlist (user_id, created_at DESC);
