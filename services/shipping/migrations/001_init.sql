CREATE TABLE shipments (
  id UUID PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  checkout_id TEXT,
  buyer_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking_code TEXT NOT NULL UNIQUE,
  fee INT NOT NULL,
  cod_amount BIGINT NOT NULL DEFAULT 0,
  weight_grams INT NOT NULL,
  eta_days INT NOT NULL,
  from_province TEXT NOT NULL,
  to_province TEXT NOT NULL,
  ship_to JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED','PICKED','IN_TRANSIT','DELIVERED','FAILED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shipments_shop_idx ON shipments (shop_id, created_at DESC);
CREATE INDEX shipments_buyer_idx ON shipments (buyer_id);
CREATE INDEX shipments_active_idx ON shipments (status, updated_at) WHERE status IN ('PICKED','IN_TRANSIT');

CREATE TABLE shipment_events (
  id BIGSERIAL PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shipment_events_idx ON shipment_events (shipment_id, at);
