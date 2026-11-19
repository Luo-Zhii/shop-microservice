-- Kho sàn (ShopNow Fulfillment): giữ hàng hộ seller, quản lý theo lô + vị trí, xuất FIFO.
CREATE TABLE warehouses (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  province TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE bins (
  warehouse TEXT NOT NULL REFERENCES warehouses(code),
  code TEXT NOT NULL,                 -- vd A-01-03 (dãy-kệ-tầng)
  zone TEXT NOT NULL DEFAULT 'STORAGE' CHECK (zone IN ('RECEIVING','STORAGE','PICKING','QUARANTINE')),
  PRIMARY KEY (warehouse, code)
);

-- Phiếu nhập theo ASN (seller báo trước) — nhận thực tế có thể chênh
CREATE TABLE receipts (
  id UUID PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  warehouse TEXT NOT NULL REFERENCES warehouses(code),
  shop_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('EXPECTED','RECEIVED','CANCELLED')),
  created_by TEXT NOT NULL,
  received_by TEXT,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE receipt_lines (
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL,
  qty_expected INT NOT NULL CHECK (qty_expected > 0),
  qty_received INT CHECK (qty_received >= 0),
  qty_damaged INT NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),
  unit_cost BIGINT NOT NULL CHECK (unit_cost >= 0),
  bin TEXT,
  PRIMARY KEY (receipt_id, sku_id)
);

-- Lô tồn: FIFO theo received_at
CREATE TABLE lots (
  id UUID PRIMARY KEY,
  warehouse TEXT NOT NULL,
  bin TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  receipt_id UUID REFERENCES receipts(id),
  qty INT NOT NULL CHECK (qty >= 0),
  reserved INT NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= qty),
  unit_cost BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (warehouse, bin) REFERENCES bins(warehouse, code)
);
CREATE INDEX lots_fifo_idx ON lots (shop_id, sku_id, received_at) WHERE qty > 0;

-- Thẻ kho: mọi biến động tồn, chỉ thêm (bất biến)
CREATE TABLE stock_moves (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL CHECK (type IN ('RECEIPT','ISSUE','ADJUST_IN','ADJUST_OUT','TRANSFER_IN','TRANSFER_OUT')),
  lot_id UUID NOT NULL REFERENCES lots(id),
  warehouse TEXT NOT NULL,
  bin TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  unit_cost BIGINT NOT NULL,
  ref_type TEXT NOT NULL,   -- receipt | pick | count | transfer
  ref_id TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX stock_moves_sku_idx ON stock_moves (shop_id, sku_id, at);
CREATE FUNCTION wh_forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'thẻ kho bất biến: không được % stock_moves', TG_OP; END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_moves_immutable BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION wh_forbid_mutation();

-- Phiếu lấy hàng cho đơn (FIFO đã giữ chỗ trên lô)
CREATE TABLE picks (
  id UUID PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL,
  warehouse TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','PICKED','CANCELLED','SHORT')),
  short_reason TEXT,
  picked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE pick_lines (
  pick_id UUID NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id),
  sku_id TEXT NOT NULL,
  bin TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  PRIMARY KEY (pick_id, lot_id)
);

-- Kiểm kê (mù: người đếm không thấy số hệ thống)
CREATE TABLE counts (
  id UUID PRIMARY KEY,
  count_no TEXT NOT NULL UNIQUE,
  warehouse TEXT NOT NULL REFERENCES warehouses(code),
  bin_prefix TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('COUNTING','SUBMITTED','APPROVED','REJECTED')),
  created_by TEXT NOT NULL,
  submitted_by TEXT,
  approved_by TEXT,
  variance_value BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE TABLE count_lines (
  count_id UUID NOT NULL REFERENCES counts(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id),
  bin TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  system_qty INT NOT NULL,
  counted_qty INT CHECK (counted_qty >= 0),
  unit_cost BIGINT NOT NULL,
  PRIMARY KEY (count_id, lot_id)
);

-- Phí lưu kho đã tính (khử trùng theo shop + kỳ)
CREATE TABLE storage_fees (
  shop_id TEXT NOT NULL,
  period TEXT NOT NULL,
  unit_days BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, period)
);

INSERT INTO warehouses (code, name, province) VALUES ('HCM1', 'Kho Củ Chi', 'Hồ Chí Minh'), ('HN1', 'Kho Long Biên', 'Hà Nội');
INSERT INTO bins (warehouse, code, zone) VALUES ('HCM1', 'RCV', 'RECEIVING'), ('HCM1', 'QRT', 'QUARANTINE'),
  ('HCM1', 'A-01-01', 'STORAGE'), ('HCM1', 'A-01-02', 'STORAGE'), ('HCM1', 'B-01-01', 'PICKING'),
  ('HN1', 'RCV', 'RECEIVING'), ('HN1', 'A-01-01', 'STORAGE');
