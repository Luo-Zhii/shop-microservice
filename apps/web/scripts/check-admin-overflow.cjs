// Chạy: WEB_URL=http://localhost:3000 node apps/web/scripts/check-admin-overflow.cjs (cần playwright + chromium; API được mock)
// Kiểm tràn ngang 3 trang admin mới với API giả (mock) + token admin giả, ở 320/375/414/768/1280.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'none' })}.${b64({ sub: 'u-admin', email: 'admin.rat.dai.de.thu.tran@shopnow.local', roles: ['admin'], exp: 4102444800 })}.x`;
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
  [/identity\/auth\/refresh/, { accessToken: jwt, refreshToken: 'rt' }],
  [/identity\/(users\/)?me/, { id: 'u-admin', email: 'admin@shopnow.local', fullName: 'Quản trị', roles: ['admin'] }],
  [/aiops\/incidents\/[^/]+\/investigations/, { items: [inv] }],
  [/aiops\/incidents/, { items: Array.from({ length: 4 }, (_, i) => ({ id: id(i), service: 'catalog-very-long-service-name', severity: 'critical', status: 'open', title: 'HighErrorRate — catalog lỗi 5xx tăng đột biến sau khi triển khai phiên bản mới lúc cao điểm', summary: 'Tóm tắt', detected_at: new Date().toISOString(), root_causes: [{ service: 'catalog', score: 0.9 }] })) }],
  [/aiops\/audit\/ledger/, { entries: 1234, findings: [{ rule: 'duplicate', severity: 'high', entry_no: 'BT-202611-000902', detail: 'trùng số tiền/đối tượng với BT-202611-000901 trong 24h (331 01934f6e-aaaa-7bbb-8ccc-000000000001)' }], benford: { n: 900, mad: 0.0041, conformity: 'close', observed: { 1: 0.3, 2: 0.18, 3: 0.12, 4: 0.1, 5: 0.08, 6: 0.07, 7: 0.06, 8: 0.05, 9: 0.04 }, expected: { 1: 0.301, 2: 0.176, 3: 0.125, 4: 0.097, 5: 0.079, 6: 0.067, 7: 0.058, 8: 0.051, 9: 0.046 } } }],
  [/accounting\/admin\/trial-balance/, { period: '2026-11', balanced: true, rows: [{ account: '3388', name: 'Tiền thu hộ người mua chờ quyết toán', openingDebit: 0, openingCredit: 123456789000, debit: 98765432100, credit: 12345678900, closingDebit: 0, closingCredit: 37036035800 }, { account: '1121', name: 'Tiền gửi ngân hàng — tài khoản thu hộ', openingDebit: 5, openingCredit: 0, debit: 1, credit: 0, closingDebit: 6, closingCredit: 0 }], totals: { openingDebit: 1, openingCredit: 1, debit: 98765432100, credit: 98765432100, closingDebit: 1, closingCredit: 1 } }],
  [/accounting\/admin\/vat-summary/, { outputVat: 1234567890, inputVat: 987654321, payable: 246913569, carryForward: 0, invoices: { count: 12345 }, invoiceGap: 10000 }],
  [/accounting\/admin\/pnl/, { revenue: 45455000, expense: 1200000, profit: 44255000, vatOutput: 4545000 }],
  [/accounting\/admin\/journal/, { total: 2, items: [{ id: id(1), entry_no: 'BT-202611-000123', entry_date: '2026-11-20', period: '2026-11', source: 'kafka', description: 'Quyết toán đơn 01934f6e-aaaa-7bbb-8ccc-000000000001: seller 950000, hoa hồng 50000, ship 30000', created_by: 'event:order', total: 1030000, reversed_by: null, reversal_of: null, hash: 'a'.repeat(64), lines }] }],
  [/accounting\/admin\/payables/, { items: [{ shopId: id(5), accrued: 950000000, paid: 900000000, balance: 50000000 }] }],
  [/accounting\/admin\/periods/, { items: [{ period: '2026-10', status: 'OPEN', closed_at: null, closed_by: null, closing_hash: null }, { period: '2026-09', status: 'CLOSED', closed_at: new Date().toISOString(), closed_by: 'ketoan.truong@shopnow.local', closing_hash: 'b'.repeat(64) }] }],
  [/accounting\/admin\/integrity/, { ok: false, entries: 120, head: 'c'.repeat(64), problems: [{ entryNo: 'BT-202611-000001', problem: 'nội dung bị sửa (hash không khớp)' }] }],
  [/warehouse\/receipts/, { items: [{ id: id(2), receipt_no: 'PN-20261120-0001', warehouse: 'HCM1', shop_id: id(5), status: 'EXPECTED', created_at: new Date().toISOString(), lines: [{ sku_id: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', qty_expected: 120, qty_received: null, qty_damaged: 0, unit_cost: 80000 }] }] }],
  [/warehouse\/picks/, { items: [{ id: id(3), order_id: id(7), status: 'OPEN', short_reason: null, created_at: new Date().toISOString(), lines: [{ sku_id: 'sku-ao-thun-cotton-oversize', bin: 'A-01-01', qty: 10 }, { sku_id: 'sku-quan', bin: 'A-01-02', qty: 2 }] }] }],
  [/warehouse\/counts\/[^/]+\/sheet/, { items: [{ lot_id: id(4), bin: 'A-01-02', sku_id: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', counted_qty: null }] }],
  [/warehouse\/counts/, { items: [{ id: id(6), count_no: 'KK-00001', warehouse: 'HCM1', bin_prefix: 'A-01', status: 'SUBMITTED', variance_value: -890000, created_by: 'nhanvien.kho.ca.dem@shopnow.local', approved_by: null }] }],
  [/warehouse\/reports\/replenishment/, { params: { days: 28, serviceLevelZ: 1.65 }, items: [{ shopId: id(5), skuId: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', abc: 'A', forecastPerDay: 12.34, safetyStock: 18, reorderPoint: 105, available: 6, daysOfCover: 0.5, suggestQty: 185, status: 'critical' }] }],
  [/warehouse\/reports\/stock-ledger/, { items: [{ shop_id: id(5), sku_id: 'sku-ao-thun-cotton-oversize-mau-den-size-xxl', opening_qty: 0, in_qty: 19, out_qty: 13, closing_qty: 6, closing_value: 540000 }] }],
];

const PAGES = [
  ['/admin/aiops', async (p) => { await p.getByText('HighErrorRate').locator('visible=true').first().click(); await p.getByText('Các bước điều tra').waitFor({ timeout: 8000 }); }],
  ['/admin/accounting', null], ['/admin/accounting#journal', 'Nhật ký chung'], ['/admin/accounting#close', 'Khoá sổ & toàn vẹn'], ['/admin/accounting#audit', 'Kiểm toán AI'],
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
