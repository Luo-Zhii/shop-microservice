-- Thuế GTGT đầu vào được khấu trừ (mua dịch vụ: hạ tầng cloud, vận chuyển, marketing…) — để tổng hợp tờ khai GTGT
INSERT INTO accounts (code, name, type, normal, parent) VALUES
  ('133',  'Thuế GTGT được khấu trừ',                   'ASSET', 'DEBIT', NULL),
  ('1331', 'Thuế GTGT được khấu trừ của hàng hoá, dịch vụ', 'ASSET', 'DEBIT', '133'),
  ('6427', 'Chi phí dịch vụ mua ngoài (cloud, phần mềm)',  'EXPENSE', 'DEBIT', '642')
ON CONFLICT (code) DO NOTHING;
