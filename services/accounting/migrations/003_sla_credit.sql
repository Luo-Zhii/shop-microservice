-- Hoàn phí SLA cho người bán (TT200): giảm trừ doanh thu dịch vụ — TK 521 "Các khoản giảm trừ doanh thu", chi tiết 5213.
-- Loại REVENUE số dư Nợ (tài khoản điều chỉnh giảm): P&L = PS Có 511x − PS Nợ 521x, bảng cân đối không gộp cha/con.
INSERT INTO accounts (code, name, type, normal, parent) VALUES
  ('521',  'Các khoản giảm trừ doanh thu',               'REVENUE', 'DEBIT', NULL),
  ('5213', 'Giảm giá dịch vụ — hoàn phí SLA người bán',   'REVENUE', 'DEBIT', '521')
ON CONFLICT (code) DO NOTHING;
