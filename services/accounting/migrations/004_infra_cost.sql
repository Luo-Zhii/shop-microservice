-- Phân bổ chi phí hạ tầng cloud theo service (FinOps showback → chargeback, TT200): hoá đơn cloud tháng M về sau ngày khoá sổ
-- → TRÍCH TRƯỚC (Nợ 6417/6427 / Có 335) theo chi phí đo được từ OpenCost; khi hoá đơn thật về, kế toán tất toán 335 với 331.
-- Hạ tầng on-prem KHÔNG ghi ở đây: đã nằm trong khấu hao tài sản cố định (214) — chỉ hiện showback để không ghi trùng.
INSERT INTO accounts (code, name, type, normal, parent) VALUES
  ('335',  'Chi phí phải trả',                                'LIABILITY', 'CREDIT', NULL),
  ('6417', 'Chi phí dịch vụ mua ngoài — hạ tầng (bán hàng)',  'EXPENSE',   'DEBIT',  '641'),
  ('6427', 'Chi phí dịch vụ mua ngoài — hạ tầng (QLDN)',      'EXPENSE',   'DEBIT',  '642')
ON CONFLICT (code) DO NOTHING;
