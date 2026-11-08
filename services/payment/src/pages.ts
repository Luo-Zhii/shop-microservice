// Trang HTML cổng thanh toán giả lập (mobile-first, không phụ thuộc CSS ngoài).

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export const vnd = (n: number) => `${Number(n).toLocaleString('vi-VN')} ₫`;

const CSS = `
:root{--bg:#f4f5f7;--card:#fff;--text:#1f2328;--muted:#5f6b7a;--line:#e3e6ea;--ok:#0f8a4f;--ok-ink:#fff;--bad:#c62828;--bad-bg:#fff;--accent:#ee4d2d}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1c1f24;--text:#e8eaed;--muted:#9aa4b1;--line:#2d3239;--bad-bg:#1c1f24}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  min-height:100vh;display:flex;align-items:flex-start;justify-content:center;
  padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}
main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-top:4vh}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--accent);margin:0 0 16px}
h1{font-size:1.25rem;margin:0 0 4px}
.muted{color:var(--muted);font-size:.875rem;margin:0}
.amount{font-size:clamp(1.75rem,8vw,2.25rem);font-weight:700;margin:16px 0}
dl{margin:0 0 20px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:.875rem}
dt{color:var(--muted)} dd{margin:0;overflow-wrap:anywhere;text-align:right}
.actions{display:grid;gap:12px}
button,.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;border-radius:12px;font:inherit;font-weight:600;
  cursor:pointer;text-decoration:none;padding:12px 16px;border:1px solid transparent}
.ok{background:var(--ok);color:var(--ok-ink)} .bad{background:var(--bad-bg);color:var(--bad);border-color:var(--bad)}
.btn{background:var(--accent);color:#fff}
.status{padding:12px;border-radius:12px;background:var(--bg);margin:0 0 16px;font-weight:600}
@media (min-width:640px){main{padding:28px;margin-top:10vh}.actions{grid-template-columns:1fr 1fr}}
`;

function layout(title: string, body: string) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><p class="brand">ShopNow Pay <span class="muted">(giả lập)</span></p>${body}</main></body></html>`;
}

export function mockPayPage(p: { id: string; checkout_id: string; amount: number; status: string; return_url: string | null }) {
  const info = `<dl><dt>Mã thanh toán</dt><dd>${esc(p.id)}</dd><dt>Mã checkout</dt><dd>${esc(p.checkout_id)}</dd></dl>`;
  if (p.status !== 'PENDING') {
    const label = p.status === 'SUCCEEDED' ? 'Giao dịch đã thanh toán thành công' : 'Giao dịch đã kết thúc (thất bại)';
    const back = p.return_url ? `<a class="btn" href="${esc(p.return_url)}">Quay lại cửa hàng</a>` : '';
    return layout('Thanh toán', `<h1>Thanh toán đơn hàng</h1><p class="amount">${vnd(p.amount)}</p><p class="status">${label}</p>${info}${back}`);
  }
  return layout(
    'Thanh toán',
    `<h1>Thanh toán đơn hàng</h1><p class="muted">Môi trường thử nghiệm — chọn kết quả giao dịch.</p>
<p class="amount">${vnd(p.amount)}</p>${info}
<form method="post" action="${esc(p.id)}/complete" class="actions">
<button class="ok" type="submit" name="result" value="success">Thanh toán thành công</button>
<button class="bad" type="submit" name="result" value="fail">Thanh toán thất bại</button>
</form>`,
  );
}

export function messagePage(title: string, message: string) {
  return layout(title, `<h1>${esc(title)}</h1><p class="muted">${esc(message)}</p>`);
}
