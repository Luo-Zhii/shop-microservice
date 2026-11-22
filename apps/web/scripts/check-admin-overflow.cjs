// Chạy: WEB_URL=http://localhost:3000 node apps/web/scripts/check-admin-overflow.cjs (cần playwright + chromium; API được mock)
// Kiểm tràn ngang các trang admin/seller mới với API giả (mock) + token admin giả, ở 320/375/414/768/1280.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'none' })}.${b64({ sub: 'u-admin', email: 'admin.rat.dai.de.thu.tran@shopnow.local', roles: ['admin', 'seller'], shopId: 'shop-1', exp: 4102444800 })}.x`;
const id = (n) => `01934f6e-aaaa-7bbb-8ccc-${String(n).padStart(12, '0')}`;
const lines = [{ line_no: 1, account: '3388', debit: 1030000, credit: 0 }, { line_no: 2, account: '331', debit: 0, credit: 950000 }, { line_no: 3, account: '5113', debit: 0, credit: 45455 }, { line_no: 4, account: '33311', debit: 0, credit: 4545 }, { line_no: 5, account: '3311', debit: 0, credit: 30000 }];
const inv = {
  id: id(9), mode: 'llm', grounding: 0.5, created_at: new Date().toISOString(),
  steps: [{ n: 1, thought: 'Xem triển khai gần đây của catalog trong 60 phút với nhiều chữ để thử xuống dòng', tool: 'recent_deployments', evidence: 'ev-1', ok: true }, { n: 2, thought: 'công cụ bịa', tool: 'kubectl_delete', evidence: 'ev-2', ok: false }],
  hypotheses: [{ service: 'catalog', cause: 'triển khai mới revision 7 (ghcr.io/luo-zhii/shopnow/catalog:sha-old6666 → ghcr.io/luo-zhii/shopnow/catalog:sha-new7777)', confidence: 0.8, evidence: ['ev-1', 'ev-3'] }],
  dropped_hypotheses: [{ service: 'payment', cause: 'x', confidence: 0.8, evidence: [] }],
  remediation: { action: 'rollback', service: 'catalog', reason: 'deploy mới (ev-1)', allowed: true, interlock: 'ok' },
  evidence: [], cost: { tool_calls: 7, llm_tokens: 5400, seconds: 3.21, usd: 0.0162 },
  pr: { status: 'proposed', url: 'https://github.com/Luo-Zhii/shop-gitops/pull/1234567', diff: '--- a/environments/dev/images.yaml\n+++ b/environments/dev/images.yaml\n-  catalog: {tag: "sha-new7777777777777777777777", digest: "sha256:abcdef0123456789abcdef0123456789"}\n+  catalog: {tag: "sha-old6666", digest: ""}' },
};
const fixtures = [
  [/seller\/shops\/me/, { id: 'shop-1', ownerId: 'u-admin', name: 'Shop Thời Trang Có Tên Rất Dài Để Thử Xuống Dòng', slug: 'shop-thoi-trang', status: 'APPROVED' }],
  [/accounting\/seller\/statement/, { period: '2026-11', balance: 50000000, items: [{ entry_no: 'BT-202611-000123', entry_date: '2026-11-20', description: 'Quyết toán đơn 01934f6e-aaaa-7bbb-8ccc-000000000001: seller 950000, hoa hồng 50000, ship 30000', order_id: 'o1', debit: 0, credit: 950000000 }, { entry_no: 'BT-202611-000124', entry_date: '2026-11-20', description: 'Chi trả seller', order_id: null, debit: 900000000, credit: 0 }], invoices: [{ invoice_no: '0000123', series: '1C26TSN', order_id: 'o1', issue_date: '2026-11-20', amount_before_tax: 45455, vat_amount: 4545, total: 50000 }] }],
  [/warehouse\/seller\/replenishment/, { items: [{ skuId: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', abc: 'A', forecastPerDay: 12.3, available: 6, daysOfCover: 0.5, suggestQty: 185, status: 'critical' }] }],
  [/warehouse\/seller\/stock/, { items: [{ sku_id: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', warehouse: 'HCM1', on_hand: 7, available: 6, quarantined: 1 }] }],
  [/identity\/auth\/refresh/, { accessToken: jwt, refreshToken: 'rt' }],
  [/identity\/(users\/)?me/, { id: 'u-admin', email: 'admin@shopnow.local', fullName: 'Quản trị', roles: ['admin'] }],
  [/aiops\/slo\/status/, { items: [{ slo: 'gateway-availability', objective: 0.995, burn_rate: 1.52, budget_remaining: -0.1, state: 'exhausted', services: ['api-gateway'] }, { slo: 'web-lcp-good', objective: 0.75, burn_rate: 8.0, budget_remaining: 0.3, state: 'fast_burn', services: ['web', 'api-gateway'] }] }],
  [/aiops\/capacity\/forecast/, { upcoming_flash_sales: 1, past_flash_sales: 2, items: [{ service: 'api-gateway-very-long-name', model: 'holt-winters', current: 123.4, peak: 456.7, rmse: 12.3, rps_per_pod: 150, recommended_min_replicas: 5, scale_up_ahead: true, event_uplift: 2.95 }] }],
  [/aiops\/reports\/dora/, { days: 30, overall: 'medium', counts: { deploys: 60, labeled: 58, with_lead_time: 60, restored: 4 }, metrics: { deployment_frequency: { value: 2.03, band: 'elite', previous: 0.5, previous_band: 'high' }, lead_time: { value: 93600, band: 'high', previous: 864000, previous_band: 'medium' }, change_failure_rate: { value: 0.138, band: 'medium', previous: 0.09, previous_band: 'high' }, time_to_restore: { value: 2460, band: 'elite', previous: null, previous_band: null } } }],
  [/aiops\/reports\/alert-quality/, { noise_ratio: 0.57, items: [{ alertname: 'FlappyCPUVeryLongAlertNameForTesting', incidents: 4, flapping_ratio: 1, ack_ratio: 0, action_ratio: 0, recommendation: 'noisy', reason: 'đa số tự hết < 5 phút và ít ai nhận — tăng for:/ngưỡng hoặc gộp' }, { alertname: 'HighErrorRate', incidents: 3, flapping_ratio: 0, ack_ratio: 1, action_ratio: 1, recommendation: 'actionable', reason: 'giữ nguyên' }] }],
  [/aiops\/reports\/oncall-digest/, { incidents: { new: 3, open: 2, resolved: 1 }, attention: ['2 sự cố mở > 4h chưa ai nhận: catalog-very-long-service-name, order'], markdown: '🗂 *Bàn giao ca trực* — 24h qua\n\n• Sự cố mới 3 · đang mở 2 · đã đóng 1 · MTTR trung vị 12m30s\n• Ồn nhất: catalog-very-long-service-name (3)' }],
  [/aiops\/change-risk\/summary/, { deploys: 42, labeled: 40, pending: 2, change_failure_rate: 0.25, brier: 0.1532, model: { source: 'fitted', records: 40, positives: 10, logloss_prior: 0.6123, logloss_fit: 0.4567, fitted_at: new Date().toISOString() }, calibration: [{ level: 'low', deploys: 20, failed: 1, failure_rate: 0.05, mean_predicted: 0.12 }, { level: 'medium', deploys: 15, failed: 5, failure_rate: 0.333, mean_predicted: 0.31 }, { level: 'high', deploys: 5, failed: 4, failure_rate: 0.8, mean_predicted: 0.71 }], items: [{ id: id(11), ref: 'promote staging→prod-onprem #1234 với tên thay đổi rất dài để thử xuống dòng', services: ['catalog-very-long-service-name', 'inventory', 'order'], probability: 0.734, level: 'high', label: 1, deployed_at: new Date().toISOString() }, { id: id(12), ref: '', services: ['search'], probability: 0.08, level: 'low', label: null, deployed_at: new Date().toISOString() }] }],
  [/aiops\/platform\/summary/, { incidents_open: 3, cost_per_order_usd: 0.0123, lcp_p75_s: 3.1, error_budget: { 'order-saga-success': -0.05, 'web-lcp-good': 0.42 }, prometheus: true }],
  [/order\/admin\/stats/, { gmv: 123456789000, orders: 45678, revenue: 98765432100, byStatus: { COMPLETED: 40000, CANCELLED: 1200 } }],
  [/aiops\/incidents\/[^/]+\/similar/, { items: [{ id: 'x1', title: 'HighErrorRate — catalog-very-long-service-name lỗi 5xx sau triển khai phiên bản mới', service: 'catalog', score: 0.82, root_cause: 'catalog', actions: [{ type: 'rollback', status: 'executed' }], mttr_s: 840 }] }],
  [/aiops\/incidents\/[^/]+\/investigations/, { items: [inv] }],
  [/aiops\/incidents/, { items: Array.from({ length: 4 }, (_, i) => ({ id: id(i), service: 'catalog-very-long-service-name', severity: 'critical', status: 'open', title: 'HighErrorRate — catalog lỗi 5xx tăng đột biến sau khi triển khai phiên bản mới lúc cao điểm', summary: 'Tóm tắt', detected_at: new Date().toISOString(), root_causes: [{ service: 'catalog', score: 0.9 }] })) }],
  [/aiops\/audit\/ledger/, { entries: 1234, findings: [{ rule: 'duplicate', severity: 'high', entry_no: 'BT-202611-000902', detail: 'trùng số tiền/đối tượng với BT-202611-000901 trong 24h (331 01934f6e-aaaa-7bbb-8ccc-000000000001)' }], benford: { n: 900, mad: 0.0041, conformity: 'close', observed: { 1: 0.3, 2: 0.18, 3: 0.12, 4: 0.1, 5: 0.08, 6: 0.07, 7: 0.06, 8: 0.05, 9: 0.04 }, expected: { 1: 0.301, 2: 0.176, 3: 0.125, 4: 0.097, 5: 0.079, 6: 0.067, 7: 0.058, 8: 0.051, 9: 0.046 } } }],
  [/accounting\/admin\/trial-balance/, { period: '2026-11', balanced: true, rows: [{ account: '3388', name: 'Tiền thu hộ người mua chờ quyết toán', openingDebit: 0, openingCredit: 123456789000, debit: 98765432100, credit: 12345678900, closingDebit: 0, closingCredit: 37036035800 }, { account: '1121', name: 'Tiền gửi ngân hàng — tài khoản thu hộ', openingDebit: 5, openingCredit: 0, debit: 1, credit: 0, closingDebit: 6, closingCredit: 0 }], totals: { openingDebit: 1, openingCredit: 1, debit: 98765432100, credit: 98765432100, closingDebit: 1, closingCredit: 1 } }],
  [/accounting\/admin\/vat-summary/, { outputVat: 1234567890, inputVat: 987654321, payable: 246913569, carryForward: 0, invoices: { count: 12345 }, invoiceGap: 10000 }],
  [/accounting\/admin\/pnl/, { revenue: 45455000, expense: 1200000, profit: 44255000, vatOutput: 4545000 }],
  [/accounting\/admin\/journal/, { total: 2, items: [{ id: id(1), entry_no: 'BT-202611-000123', entry_date: '2026-11-20', period: '2026-11', source: 'kafka', description: 'Quyết toán đơn 01934f6e-aaaa-7bbb-8ccc-000000000001: seller 950000, hoa hồng 50000, ship 30000', created_by: 'event:order', total: 1030000, reversed_by: null, reversal_of: null, hash: 'a'.repeat(64), lines }] }],
  [/accounting\/admin\/cod-reconciliation/, { settled: 1, received: 492000, exceptions: [{ orderId: '01934f6e-aaaa-7bbb-8ccc-000000000002', reason: 'AMOUNT_MISMATCH', ledger: 300000, carrier: 299000 }, { orderId: 'don-la-rat-dai-khong-co-trong-so-sach-ke-toan', reason: 'MISSING_IN_LEDGER', ledger: null, carrier: 100000 }] }],
  [/accounting\/admin\/payables\/aging/, { asOf: '2026-11-20', overdueDays: 15, totals: { '0-7': 300000000, '8-15': 0, '16-30': 0, '>30': 150000000 }, items: [{ shopId: id(5), balance: 450000000, buckets: { '0-7': 300000000, '8-15': 0, '16-30': 0, '>30': 150000000 }, oldestDays: 31, overdue: 150000000 }] }],
  [/accounting\/admin\/payables/, { items: [{ shopId: id(5), accrued: 950000000, paid: 900000000, balance: 50000000 }] }],
  [/accounting\/admin\/periods\/[^/]+\/readiness/, { ready: false, warnings: 1, checks: [{ key: 'trial_balance', label: 'Bảng cân đối số phát sinh cân', ok: true, blocking: true }, { key: 'escrow_stale', label: 'Không có tiền thu hộ (3388) treo quá 15 ngày', ok: false, blocking: false, detail: '2 checkout, 800000 đ — đơn chưa hoàn tất/hoàn tiền rất dài để thử xuống dòng trên điện thoại' }, { key: 'ledger_integrity', label: 'Chuỗi hash sổ cái nguyên vẹn', ok: false, blocking: true, detail: '1 bút toán có vấn đề' }] }],
  [/accounting\/admin\/periods/, { items: [{ period: '2026-10', status: 'OPEN', closed_at: null, closed_by: null, closing_hash: null }, { period: '2026-09', status: 'CLOSED', closed_at: new Date().toISOString(), closed_by: 'ketoan.truong@shopnow.local', closing_hash: 'b'.repeat(64) }] }],
  [/accounting\/admin\/integrity/, { ok: false, entries: 120, head: 'c'.repeat(64), problems: [{ entryNo: 'BT-202611-000001', problem: 'nội dung bị sửa (hash không khớp)' }] }],
  [/warehouse\/receipts/, { items: [{ id: id(2), receipt_no: 'PN-20261120-0001', warehouse: 'HCM1', shop_id: id(5), status: 'EXPECTED', created_at: new Date().toISOString(), lines: [{ sku_id: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', qty_expected: 120, qty_received: null, qty_damaged: 0, unit_cost: 80000 }] }] }],
  [/warehouse\/picks/, { items: [{ id: id(3), order_id: id(7), status: 'OPEN', short_reason: null, created_at: new Date().toISOString(), lines: [{ sku_id: 'sku-ao-thun-cotton-oversize', bin: 'A-01-01', qty: 10 }, { sku_id: 'sku-quan', bin: 'A-01-02', qty: 2 }] }] }],
  [/warehouse\/counts\/[^/]+\/sheet/, { items: [{ lot_id: id(4), bin: 'A-01-02', sku_id: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', counted_qty: null }] }],
  [/warehouse\/counts/, { items: [{ id: id(6), count_no: 'KK-00001', warehouse: 'HCM1', bin_prefix: 'A-01', status: 'SUBMITTED', variance_value: -890000, created_by: 'nhanvien.kho.ca.dem@shopnow.local', approved_by: null }] }],
  [/warehouse\/reports\/cycle-count-plan/, { intervals: { A: 30, B: 90, C: 180 }, items: [{ shopId: id(5), skuId: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', bins: ['A-01-01', 'B-01-01'], qty: 120, value: 9600000, abc: 'A', daysSinceCount: null, intervalDays: 30 }] }],
  [/warehouse\/reports\/replenishment/, { params: { days: 28, serviceLevelZ: 1.65 }, items: [{ shopId: id(5), skuId: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', abc: 'A', forecastPerDay: 12.34, safetyStock: 18, reorderPoint: 105, available: 6, daysOfCover: 0.5, suggestQty: 185, status: 'critical' }] }],
  [/warehouse\/reports\/stock-ledger/, { items: [{ shop_id: id(5), sku_id: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', opening_qty: 0, in_qty: 19, out_qty: 13, closing_qty: 6, closing_value: 540000 }] }],
];

const PAGES = [
  ['/admin/accounting#readiness', async (p) => { await p.getByRole('tab', { name: 'Khoá sổ & toàn vẹn' }).click(); await p.getByRole('button', { name: 'Khoá sổ' }).locator('visible=true').first().click(); await p.getByText('Còn điều kiện chặn').waitFor({ timeout: 8000 }); }],
  ['/admin/aiops#slo', 'SLO'],
  ['/admin/aiops#capacity', 'Dự báo dung lượng'], ['/admin/aiops#changes', 'Thay đổi'], ['/admin/aiops#digest', 'Bàn giao ca'],
  ['/admin', null],
  ['/seller/statement', null], ['/seller/fulfillment', null],
  ['/seller/fulfillment#asn', async (p) => { await p.getByRole('button', { name: 'Báo gửi hàng' }).locator('visible=true').first().click(); await p.getByText('Thêm dòng').waitFor({ timeout: 8000 }); }],
  ['/admin/aiops', async (p) => { await p.getByText('HighErrorRate').locator('visible=true').first().click(); await p.getByText('Các bước điều tra').waitFor({ timeout: 8000 }); }],
  ['/admin/accounting', null], ['/admin/accounting#journal', 'Nhật ký chung'], ['/admin/accounting#payables', 'Tuổi nợ seller'], ['/admin/accounting#recon', async (p) => { await p.getByRole('tab', { name: 'Đối soát' }).click(); await p.locator('textarea').fill('ma_don,tien,phi\na1,500000,8000\nb2,299000,8000'); await p.getByRole('button', { name: 'Đối soát' }).click(); await p.getByText('Lệch tiền').locator('visible=true').first().waitFor({ timeout: 8000 }); }], ['/admin/accounting#close', 'Khoá sổ & toàn vẹn'], ['/admin/accounting#audit', 'Kiểm toán AI'],
  ['/admin/warehouse', null], ['/admin/warehouse#picks', 'Lấy hàng'], ['/admin/warehouse#counts', 'Kiểm kê'], ['/admin/warehouse#ledger', 'Nhập – xuất – tồn'], ['/admin/warehouse#replenish', 'Đề xuất nhập'],
  ['/admin/warehouse#receive', async (p) => { await p.getByRole('button', { name: 'Nhận hàng' }).locator('visible=true').first().click(); await p.getByText('Xác nhận nhập kho').waitFor({ timeout: 8000 }); }],
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const bad = [];
  for (const w of [320, 375, 414, 768, 1280]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => localStorage.setItem('shopnow.rt', 'rt'));
    await ctx.route('http://localhost:8080/api/**', (route) => {
      const u = route.request().url();
      const hit = fixtures.find(([re]) => re.test(u));
      route.fulfill({ status: hit ? 200 : 404, contentType: 'application/json', body: JSON.stringify(hit ? hit[1] : { error: { code: 'NOT_FOUND', message: 'mock' } }) });
    });
    const page = await ctx.newPage();
    for (const [path, act] of PAGES) {
      await page.goto(`${process.env.WEB_URL || 'http://localhost:3000'}${path.split('#')[0]}`, { waitUntil: 'networkidle', timeout: 90000 });
      await page.waitForTimeout(400);
      try {
        if (typeof act === 'string') await page.getByRole('tab', { name: act }).click();
        else if (act) await act(page);
        await page.waitForTimeout(500);
      } catch (e) { bad.push(`${w} ${path}: không thao tác được (${e.message.split('\n')[0]})`); }
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const sw = document.documentElement.scrollWidth;
        const off = [];
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect();
          if (b.width && b.right > vw + 1 && !el.closest('[class*="overflow-x-auto"],[class*="overflow-auto"],pre')) off.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(b.right)}`);
        }
        return { vw, sw, off: off.slice(0, 4), title: document.querySelector('h1')?.textContent };
      });
      if (r.sw > r.vw || r.off.length) bad.push(`${w} ${path}: scrollWidth ${r.sw} > ${r.vw} ${r.off.join(' | ')}`);
      if (w === 375) await page.screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/shot-${path.replace(/[/#]/g, '_')}.png`, fullPage: false });
      console.log(w, path, r.title, r.sw <= r.vw && !r.off.length ? 'OK' : 'OVERFLOW');
    }
    await ctx.close();
  }
  await browser.close();
  console.log(bad.length ? `LỖI:\n${bad.join('\n')}` : 'Không trang nào tràn ngang');
})();
