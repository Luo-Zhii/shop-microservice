CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE categories (
  id UUID PRIMARY KEY,
  parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  icon TEXT,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shops_cache (
  shop_id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id UUID PRIMARY KEY,
  shop_id UUID NOT NULL,
  shop_name TEXT NOT NULL DEFAULT '',
  category_id UUID NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  brand TEXT,
  attributes JSONB NOT NULL DEFAULT '{}',
  images JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  reject_reason TEXT,
  min_price BIGINT NOT NULL DEFAULT 0,
  max_price BIGINT NOT NULL DEFAULT 0,
  rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count INT NOT NULL DEFAULT 0,
  sold_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_shop_idx ON products (shop_id, status);
CREATE INDEX products_category_idx ON products (category_id, status);
CREATE INDEX products_status_idx ON products (status, created_at DESC);

CREATE TABLE variants (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '{}',
  price BIGINT NOT NULL CHECK (price >= 0),
  compare_at_price BIGINT,
  weight_grams INT NOT NULL DEFAULT 200,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (product_id, sku)
);
CREATE INDEX variants_product_idx ON variants (product_id);

CREATE TABLE banners (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  image_url TEXT NOT NULL,
  link_url TEXT,
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
