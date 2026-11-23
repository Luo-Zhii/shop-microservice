-- Kiểm kê đột xuất theo tín hiệu (exception-based cycle counting): ngoài kiểm kê theo lịch ABC, đếm NGAY đúng SKU vừa có dấu
-- hiệu sai — người lấy hàng báo không thấy hàng tại kệ, lệch tồn warehouse ↔ inventory bền vững, lần kiểm trước có chênh lệch.
ALTER TABLE counts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'CYCLE';
ALTER TABLE counts ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE counts ADD COLUMN IF NOT EXISTS shop_id TEXT;
ALTER TABLE counts ADD COLUMN IF NOT EXISTS sku_id TEXT;
CREATE INDEX IF NOT EXISTS counts_spot_open_idx ON counts (warehouse, shop_id, sku_id) WHERE kind = 'SPOT' AND status = 'COUNTING';

-- Báo "không thấy hàng tại kệ" khi lấy hàng — tín hiệu mạnh nhất rằng số hệ thống sai
CREATE TABLE IF NOT EXISTS pick_exceptions (
  id UUID PRIMARY KEY,
  pick_id UUID NOT NULL REFERENCES picks(id),
  lot_id UUID NOT NULL REFERENCES lots(id),
  warehouse TEXT NOT NULL,
  bin TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  missing_qty INT NOT NULL CHECK (missing_qty > 0),
  reported_by TEXT NOT NULL,
  count_id UUID REFERENCES counts(id),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pick_exceptions_sku_idx ON pick_exceptions (shop_id, sku_id, at DESC);
