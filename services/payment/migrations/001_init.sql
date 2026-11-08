-- Một payment cho mỗi checkout (idempotent theo checkout_id).
CREATE TABLE payments (
  id UUID PRIMARY KEY,
  checkout_id UUID NOT NULL UNIQUE,
  buyer_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  method TEXT NOT NULL CHECK (method IN ('COD', 'MOCK', 'VNPAY')),
  -- PENDING (chờ cổng) | PENDING_COD | SUCCEEDED | FAILED
  status TEXT NOT NULL,
  order_ids JSONB NOT NULL DEFAULT '[]',
  return_url TEXT,
  redirect_url TEXT,
  txn_ref TEXT UNIQUE,
  provider_txn_no TEXT,
  failure_reason TEXT,
  refunded_amount BIGINT NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_buyer_idx ON payments (buyer_id, created_at DESC);

-- Mọi callback từ cổng (mock / VNPay return / IPN), dedupe theo nội dung.
CREATE TABLE payment_events (
  id UUID PRIMARY KEY,
  payment_id UUID,
  source TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  verified BOOLEAN NOT NULL,
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, created_at);

-- Hoàn tiền: đúng 1 lần mỗi order.
CREATE TABLE refunds (
  id UUID PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  checkout_id UUID NOT NULL,
  payment_id UUID,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  reason TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_checkout_idx ON refunds (checkout_id);

-- Quyết toán order hoàn tất cho seller (1 lần / order).
CREATE TABLE settlements (
  order_id TEXT PRIMARY KEY,
  checkout_id UUID NOT NULL,
  shop_id TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  subtotal BIGINT NOT NULL,
  discount BIGINT NOT NULL,
  shipping_fee BIGINT NOT NULL,
  total BIGINT NOT NULL,
  commission BIGINT NOT NULL,
  net_amount BIGINT NOT NULL,
  cod_collected BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlements_shop_idx ON settlements (shop_id, created_at DESC);

CREATE TABLE wallets (
  shop_id TEXT PRIMARY KEY,
  available BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
  -- tiền đang giữ cho yêu cầu rút chưa chi
  pending BIGINT NOT NULL DEFAULT 0 CHECK (pending >= 0),
  total_earned BIGINT NOT NULL DEFAULT 0,
  total_paid_out BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sổ cái ví (append-only)
CREATE TABLE wallet_ledger (
  id BIGSERIAL PRIMARY KEY,
  shop_id TEXT NOT NULL,
  type TEXT NOT NULL, -- ORDER_CREDIT | PAYOUT_HOLD | PAYOUT_PAID
  amount BIGINT NOT NULL, -- dương = vào khả dụng, âm = ra khỏi khả dụng
  available_after BIGINT NOT NULL,
  pending_after BIGINT NOT NULL,
  ref_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_ledger_shop_idx ON wallet_ledger (shop_id, id DESC);

CREATE TABLE payouts (
  id UUID PRIMARY KEY,
  shop_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('REQUESTED', 'PAID')),
  requested_by TEXT NOT NULL,
  paid_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX payouts_status_idx ON payouts (status, created_at);
CREATE INDEX payouts_shop_idx ON payouts (shop_id, created_at DESC);
