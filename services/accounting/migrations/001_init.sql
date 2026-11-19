-- Sổ cái kép (double-entry) theo hệ thống tài khoản TT200 (rút gọn cho mô hình sàn TMĐT thu hộ).
-- Bất biến: dòng bút toán không UPDATE/DELETE được (trigger); sửa sai = bút toán đảo. Chuỗi hash chống sửa lén.

CREATE TABLE accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal TEXT NOT NULL CHECK (normal IN ('DEBIT','CREDIT')),
  parent TEXT REFERENCES accounts(code)
);

INSERT INTO accounts (code, name, type, normal, parent) VALUES
  ('111',   'Tiền mặt',                                  'ASSET',     'DEBIT',  NULL),
  ('112',   'Tiền gửi ngân hàng',                        'ASSET',     'DEBIT',  NULL),
  ('1121',  'Tiền gửi ngân hàng — tài khoản thu hộ',      'ASSET',     'DEBIT',  '112'),
  ('138',   'Phải thu khác',                             'ASSET',     'DEBIT',  NULL),
  ('1388',  'Phải thu ĐVVC tiền COD',                    'ASSET',     'DEBIT',  '138'),
  ('331',   'Phải trả người bán (seller)',               'LIABILITY', 'CREDIT', NULL),
  ('3311',  'Phải trả đơn vị vận chuyển',                'LIABILITY', 'CREDIT', '331'),
  ('333',   'Thuế và các khoản phải nộp Nhà nước',       'LIABILITY', 'CREDIT', NULL),
  ('33311', 'Thuế GTGT đầu ra',                          'LIABILITY', 'CREDIT', '333'),
  ('338',   'Phải trả, phải nộp khác',                   'LIABILITY', 'CREDIT', NULL),
  ('3388',  'Tiền thu hộ người mua chờ quyết toán',      'LIABILITY', 'CREDIT', '338'),
  ('411',   'Vốn đầu tư của chủ sở hữu',                 'EQUITY',    'CREDIT', NULL),
  ('511',   'Doanh thu bán hàng và cung cấp dịch vụ',    'REVENUE',   'CREDIT', NULL),
  ('5113',  'Doanh thu phí hoa hồng sàn',                'REVENUE',   'CREDIT', '511'),
  ('641',   'Chi phí bán hàng',                          'EXPENSE',   'DEBIT',  NULL),
  ('6418',  'Chi phí khuyến mại sàn tài trợ',            'EXPENSE',   'DEBIT',  '641'),
  ('642',   'Chi phí quản lý doanh nghiệp',              'EXPENSE',   'DEBIT',  NULL),
  ('811',   'Chi phí khác',                              'EXPENSE',   'DEBIT',  NULL);

CREATE TABLE periods (
  period TEXT PRIMARY KEY CHECK (period ~ '^\d{4}-\d{2}$'),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  closing_hash TEXT
);

CREATE SEQUENCE journal_no_seq;

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY,
  seq BIGINT NOT NULL UNIQUE,
  entry_no TEXT NOT NULL UNIQUE,
  entry_date DATE NOT NULL,
  period TEXT NOT NULL,
  source TEXT NOT NULL,          -- kafka | manual | payout | reversal
  source_ref TEXT NOT NULL,      -- id sự kiện / mã chứng từ (khử trùng)
  event_type TEXT,
  description TEXT NOT NULL,
  created_by TEXT NOT NULL,
  reversal_of UUID REFERENCES journal_entries(id),
  reversed_by UUID,
  total BIGINT NOT NULL CHECK (total > 0),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_ref)
);
CREATE INDEX journal_entries_period_idx ON journal_entries (period, seq);

CREATE TABLE journal_lines (
  id BIGSERIAL PRIMARY KEY,
  entry_id UUID NOT NULL REFERENCES journal_entries(id),
  line_no INT NOT NULL,
  account TEXT NOT NULL REFERENCES accounts(code),
  debit BIGINT NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit BIGINT NOT NULL DEFAULT 0 CHECK (credit >= 0),
  party_type TEXT CHECK (party_type IN ('shop','buyer','carrier','checkout','gateway')),
  party_id TEXT,
  order_id TEXT,
  memo TEXT,
  CHECK ((debit = 0) <> (credit = 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX journal_lines_account_idx ON journal_lines (account, entry_id);
CREATE INDEX journal_lines_party_idx ON journal_lines (party_type, party_id);

-- ---- bất biến ----
CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sổ cái bất biến: không được % trên %, hãy lập bút toán đảo', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

-- chỉ cho phép ghi reversed_by đúng một lần
CREATE FUNCTION ledger_entry_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sổ cái bất biến: không được xoá bút toán %', OLD.entry_no;
  END IF;
  IF OLD.reversed_by IS NOT NULL
     OR (NEW.id, NEW.seq, NEW.entry_no, NEW.entry_date, NEW.period, NEW.total, NEW.hash, NEW.prev_hash, NEW.description)
        IS DISTINCT FROM (OLD.id, OLD.seq, OLD.entry_no, OLD.entry_date, OLD.period, OLD.total, OLD.hash, OLD.prev_hash, OLD.description)
  THEN
    RAISE EXCEPTION 'sổ cái bất biến: bút toán % chỉ được đánh dấu đảo một lần', OLD.entry_no;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_guard BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_guard();

-- khoá sổ: không ghi vào kỳ đã đóng
CREATE FUNCTION ledger_period_open() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM periods WHERE period = NEW.period AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'kỳ % đã khoá sổ', NEW.period;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_period_open();

-- Nợ = Có cho mỗi bút toán, kiểm ở cuối transaction
CREATE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT; t BIGINT;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c FROM journal_lines WHERE entry_id = NEW.entry_id;
  SELECT total INTO t FROM journal_entries WHERE id = NEW.entry_id;
  IF d <> c OR d <> t THEN
    RAISE EXCEPTION 'bút toán % lệch: Nợ % ≠ Có % (tổng khai %)', NEW.entry_id, d, c, t;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- ---- hoá đơn điện tử phí hoa hồng (TT78) ----
CREATE SEQUENCE invoice_no_seq;
CREATE TABLE vat_invoices (
  id UUID PRIMARY KEY,
  series TEXT NOT NULL,
  invoice_no TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  entry_id UUID NOT NULL REFERENCES journal_entries(id),
  issue_date DATE NOT NULL,
  amount_before_tax BIGINT NOT NULL,
  vat_rate NUMERIC(4,3) NOT NULL,
  vat_amount BIGINT NOT NULL,
  total BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series, invoice_no)
);
CREATE INDEX vat_invoices_shop_idx ON vat_invoices (shop_id, issue_date DESC);

-- ---- đối soát cổng thanh toán ----
CREATE TABLE recon_runs (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  period TEXT NOT NULL,
  created_by TEXT NOT NULL,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE recon_items (
  run_id UUID NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  gateway_amount BIGINT,
  ledger_amount BIGINT,
  status TEXT NOT NULL CHECK (status IN ('MATCHED','MISSING_IN_LEDGER','MISSING_AT_GATEWAY','AMOUNT_MISMATCH')),
  PRIMARY KEY (run_id, ref)
);
