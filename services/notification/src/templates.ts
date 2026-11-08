import type { OrderSnapshot } from '@shopnow/contracts';

export interface Email {
  subject: string;
  html: string;
  text: string;
}

export const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(n)}đ`;
export const orderCode = (id: string) => `#${id.replace(/-/g, '').slice(-8).toUpperCase()}`;

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Mã lý do huỷ (order service) → câu tiếng Việt cho người dùng. Lý do tự do (buyer nhập) giữ nguyên. */
const CANCEL_REASONS: Record<string, string> = {
  OUT_OF_STOCK: 'Sản phẩm đã hết hàng',
  PAYMENT_FAILED: 'Thanh toán không thành công',
  PAYMENT_TIMEOUT: 'Quá thời hạn thanh toán',
  PAYMENT_EXPIRED: 'Quá thời hạn thanh toán',
  RESERVATION_EXPIRED: 'Hết thời gian giữ hàng',
  INVENTORY_EXPIRED: 'Hết thời gian giữ hàng',
  EXPIRED: 'Quá thời hạn thanh toán',
  TIMEOUT: 'Quá thời hạn thanh toán',
  BUYER_CANCELLED: 'Bạn đã huỷ đơn hàng',
  CANCELLED_BY_BUYER: 'Bạn đã huỷ đơn hàng',
  SELLER_CANCELLED: 'Người bán đã huỷ đơn hàng',
  CANCELLED_BY_SELLER: 'Người bán đã huỷ đơn hàng',
  ADMIN_CANCELLED: 'Đơn hàng bị huỷ bởi quản trị viên',
  SHOP_SUSPENDED: 'Cửa hàng tạm ngừng hoạt động',
  VOUCHER_INVALID: 'Mã giảm giá không còn hiệu lực',
};
export function cancelReasonText(reason?: string | null) {
  if (!reason) return 'Không rõ lý do';
  return CANCEL_REASONS[reason.trim().toUpperCase()] ?? reason;
}

function layout(title: string, body: string, cta?: { label: string; url: string }) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#ee4d2d;color:#ffffff;padding:16px 24px;font-size:20px;font-weight:bold">ShopNow</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6"><h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>${body}
${cta ? `<p style="margin:24px 0 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#ee4d2d;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">${escapeHtml(cta.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#71717a;border-top:1px solid #e4e4e7">Email tự động từ ShopNow, vui lòng không trả lời.</td></tr>
</table></td></tr></table></body></html>`;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const make = (subject: string, title: string, body: string, cta?: { label: string; url: string }): Email => ({
  subject,
  html: layout(title, body, cta),
  text: `${title}\n\n${strip(body)}${cta ? `\n\n${cta.label}: ${cta.url}` : ''}`,
});

export function otpEmail(purpose: 'verify_email' | 'reset_password', code: string): Email {
  const verify = purpose === 'verify_email';
  const title = verify ? 'Xác thực email của bạn' : 'Đặt lại mật khẩu';
  return make(
    `[ShopNow] Mã ${verify ? 'xác thực' : 'đặt lại mật khẩu'}: ${code}`,
    title,
    `<p>Mã ${verify ? 'xác thực tài khoản' : 'đặt lại mật khẩu'} của bạn là:</p>
<p style="font-size:30px;letter-spacing:8px;font-weight:bold;margin:16px 0">${escapeHtml(code)}</p>
<p>Mã có hiệu lực trong 10 phút. Không chia sẻ mã này cho bất kỳ ai, kể cả nhân viên ShopNow.</p>
<p style="color:#71717a">Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>`,
  );
}

export function welcomeEmail(fullName: string, webUrl: string): Email {
  return make(
    'Chào mừng bạn đến với ShopNow',
    `Xin chào ${fullName || 'bạn'}!`,
    '<p>Tài khoản ShopNow của bạn đã được tạo. Hàng triệu sản phẩm từ các shop uy tín đang chờ bạn khám phá.</p>',
    { label: 'Mua sắm ngay', url: webUrl },
  );
}

function itemsTable(o: OrderSnapshot) {
  const rows = o.items
    .map(
      (i) => `<tr><td style="padding:6px 0;border-bottom:1px solid #f4f4f5">${escapeHtml(i.title)}${i.variantLabel ? ` <span style="color:#71717a">(${escapeHtml(i.variantLabel)})</span>` : ''} × ${i.qty}</td>
<td align="right" style="padding:6px 0;border-bottom:1px solid #f4f4f5;white-space:nowrap">${vnd(i.lineTotal)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0">${rows}
<tr><td style="padding:6px 0">Phí vận chuyển</td><td align="right">${vnd(o.shippingFee)}</td></tr>
${o.discount ? `<tr><td style="padding:6px 0">Giảm giá</td><td align="right">-${vnd(o.discount)}</td></tr>` : ''}
<tr><td style="padding:6px 0;font-weight:bold">Tổng cộng</td><td align="right" style="font-weight:bold;color:#ee4d2d">${vnd(o.total)}</td></tr></table>`;
}

const PAYMENT_LABEL: Record<string, string> = { COD: 'Thanh toán khi nhận hàng', MOCK: 'Thanh toán online', VNPAY: 'VNPay' };

export function orderPlacedEmail(o: OrderSnapshot, webUrl: string): Email {
  const a = o.shippingAddress;
  return make(
    `[ShopNow] Đặt hàng thành công ${orderCode(o.id)}`,
    `Cảm ơn bạn đã đặt hàng ${orderCode(o.id)}`,
    `<p>Đơn hàng của bạn đã được ghi nhận và đang chờ xử lý.</p>${itemsTable(o)}
<p style="font-size:14px"><b>Thanh toán:</b> ${escapeHtml(PAYMENT_LABEL[o.paymentMethod] ?? o.paymentMethod)}<br>
<b>Giao đến:</b> ${escapeHtml(`${a.fullName} – ${a.phone}`)}<br>${escapeHtml([a.line1, a.ward, a.district, a.province].filter(Boolean).join(', '))}</p>`,
    { label: 'Xem đơn hàng', url: `${webUrl}/orders/${o.id}` },
  );
}

export function orderCancelledEmail(o: OrderSnapshot, webUrl: string): Email {
  return make(
    `[ShopNow] Đơn hàng ${orderCode(o.id)} đã bị huỷ`,
    `Đơn hàng ${orderCode(o.id)} đã bị huỷ`,
    `<p><b>Lý do:</b> ${escapeHtml(cancelReasonText(o.reason))}</p>${itemsTable(o)}
<p style="font-size:14px">Nếu bạn đã thanh toán online, tiền sẽ được hoàn về phương thức thanh toán ban đầu trong 3–7 ngày làm việc.</p>`,
    { label: 'Xem chi tiết', url: `${webUrl}/orders/${o.id}` },
  );
}
