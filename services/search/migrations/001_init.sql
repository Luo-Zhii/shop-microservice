CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE search_products (
  product_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  brand TEXT,
  shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL,
  category_ids TEXT[] NOT NULL DEFAULT '{}',
  category_names TEXT[] NOT NULL DEFAULT '{}',
  image TEXT,
  min_price BIGINT NOT NULL,
  max_price BIGINT NOT NULL,
  rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count INT NOT NULL DEFAULT 0,
  sold_count INT NOT NULL DEFAULT 0,
  sku_ids TEXT[] NOT NULL DEFAULT '{}',
  in_stock BOOLEAN NOT NULL DEFAULT true,
  title_folded TEXT NOT NULL,
  -- tiêu đề + thương hiệu + danh mục + thuộc tính, đã bỏ dấu → pg_trgm khớp có/không dấu + sai chính tả nhẹ
  doc_folded TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_products_doc_trgm ON search_products USING gin (doc_folded gin_trgm_ops);
CREATE INDEX search_products_title_trgm ON search_products USING gin (title_folded gin_trgm_ops);
CREATE INDEX search_products_cats ON search_products USING gin (category_ids);
CREATE INDEX search_products_skus ON search_products USING gin (sku_ids);
CREATE INDEX search_products_shop ON search_products (shop_id);
CREATE INDEX search_products_price ON search_products (min_price);
CREATE INDEX search_products_newest ON search_products (created_at DESC);
CREATE INDEX search_products_sold ON search_products (sold_count DESC);

-- Tồn theo SKU (stock.changed có thể đến trước product.upserted)
CREATE TABLE search_stock (
  sku_id TEXT PRIMARY KEY,
  available INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Truy vấn phổ biến cho /suggest
CREATE TABLE search_queries (
  q_folded TEXT PRIMARY KEY,
  q TEXT NOT NULL,
  hits BIGINT NOT NULL DEFAULT 1,
  last_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_queries_prefix ON search_queries (q_folded text_pattern_ops);
