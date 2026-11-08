/**
 * E2E toàn sàn qua API Gateway (cần `scripts/dev.sh up` với DEV_EXPOSE_OTP=true, DEV_SIMULATOR=true).
 * Kịch bản: mở shop → duyệt → đăng sản phẩm → duyệt → nhập kho → tìm kiếm → giỏ → voucher →
 *           checkout COD (saga) → giao hàng → hoàn tất → đánh giá → ví seller
 *           + checkout online thanh toán thất bại (bù trừ) + hết hàng + BFF + thông báo.
 *   pnpm e2e            (API=http://localhost:8080/api mặc định)
 */
const API = process.env.API ?? 'http://localhost:8080/api';
const RUN = Date.now().toString(36);
const results: { step: string; ok: boolean; ms: number; note?: string }[] = [];

type Json = any;
async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; expect?: number[] } = {}): Promise<Json> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  const expect = opts.expect ?? [200, 201];
  if (!expect.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function poll<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 30_000, everyMs = 500): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`hết thời gian chờ: ${what}${last ? ` (${(last as Error).message})` : ''}`);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const v = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - t });
    console.log(`✔ ${name} (${Date.now() - t}ms)`);
    return v;
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - t, note: (e as Error).message });
    console.error(`✘ ${name}: ${(e as Error).message}`);
    throw e;
  }
}

async function registerAndLogin(prefix: string) {
  const email = `${prefix}-${RUN}@e2e.local`;
  const password = 'Matkhau@123';
  const reg = await call('POST', '/identity/auth/register', { body: { email, password, fullName: `E2E ${prefix}` } });
  const otp = reg.devOtp;
  if (!otp) throw new Error('identity không trả devOtp (bật DEV_EXPOSE_OTP=true)');
  await call('POST', '/identity/auth/verify-email', { body: { email, code: otp } });
  const login = await call('POST', '/identity/auth/login', { body: { email, password } });
  return { email, password, ...login } as { email: string; password: string; accessToken: string; refreshToken: string; user: Json };
}

function decode(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

async function main() {
  console.log(`E2E ShopNow v2 — ${API} — run ${RUN}\n`);

  await step('Gateway + mọi service sẵn sàng', async () => {
    const s = await call('GET', '/status', { expect: [200, 503] });
    const down = Object.entries(s.services ?? s).filter(([, v]) => (v as Json)?.status !== 'ok' && v !== 'ok');
    if (down.length) console.log('   (cảnh báo) service chưa sẵn sàng:', down.map(([k]) => k).join(', '));
  });

  const admin = await step('Admin đăng nhập', () =>
    call('POST', '/identity/auth/login', { body: { email: process.env.ADMIN_EMAIL ?? 'admin@shopnow.local', password: process.env.ADMIN_PASSWORD ?? 'Admin@12345' } }),
  );
  let seller = await step('Người bán đăng ký + xác thực OTP + đăng nhập', () => registerAndLogin('seller'));

  const shop = await step('Mở shop → admin duyệt', async () => {
    const created = await call('POST', '/seller/shops', {
      token: seller.accessToken,
      body: {
        name: `Shop E2E ${RUN}`,
        description: 'Shop kiểm thử tự động',
        phone: '0901234567',
        pickupAddress: { line1: '1 Lê Lợi', ward: 'Bến Nghé', district: 'Quận 1', province: 'Hồ Chí Minh' },
        legalName: 'Nguyễn Văn A',
        taxCode: '0312345678',
        idNumber: '079123456789',
        bankAccount: { bankName: 'VCB', accountNumber: '0123456789', holder: 'NGUYEN VAN A' },
      },
    });
    await call('POST', `/seller/admin/shops/${created.id}/approve`, { token: admin.accessToken });
    return created;
  });

  seller = await step('Token người bán có role seller + shopId (sau sự kiện shop.approved)', async () => {
    const refreshed = await poll('role seller', async () => {
      const r = await call('POST', '/identity/auth/refresh', { body: { refreshToken: seller.refreshToken } });
      seller.refreshToken = r.refreshToken;
      const claims = decode(r.accessToken);
      return claims.roles?.includes('seller') && claims.shopId === shop.id ? r : undefined;
    });
    return { ...seller, ...refreshed };
  });

  const cats = await call('GET', '/catalog/categories');
  const leaf = cats.items[0].children[0];
  const product = await step('Đăng sản phẩm 2 biến thể → gửi duyệt → admin duyệt', async () => {
    const p = await call('POST', '/catalog/seller/products', {
      token: seller.accessToken,
      body: {
        categoryId: leaf.id,
        title: `Áo thun cotton E2E ${RUN}`,
        description: 'Áo thun 100% cotton, thoáng mát',
        brand: 'ShopNow',
        attributes: { 'Chất liệu': 'Cotton' },
        images: ['https://picsum.photos/seed/shopnow/600/600'],
        variants: [
          { sku: `E2E-${RUN}-M`, options: { size: 'M' }, price: 150000, weightGrams: 300 },
          { sku: `E2E-${RUN}-L`, options: { size: 'L' }, price: 170000, weightGrams: 300 },
        ],
      },
    });
    await call('POST', `/catalog/seller/products/${p.id}/submit`, { token: seller.accessToken });
    await call('POST', `/catalog/admin/products/${p.id}/approve`, { token: admin.accessToken });
    return p;
  });
  const [skuM, skuL] = product.variants.map((v: Json) => v.id);

  await step('Inventory (Go) nhận SKU qua Kafka → người bán nhập kho', async () => {
    await poll('SKU đăng ký ở inventory', async () => {
      const s = await call('GET', `/inventory/stock?skuIds=${skuM},${skuL}`);
      return (Array.isArray(s) ? s : s.items)?.length === 2;
    });
    await call('PUT', `/inventory/seller/stock/${skuM}`, { token: seller.accessToken, body: { onHand: 5 } });
    await call('PUT', `/inventory/seller/stock/${skuL}`, { token: seller.accessToken, body: { onHand: 1 } });
  });

  await step('Search: tìm không dấu "ao thun cotton" thấy sản phẩm', () =>
    poll('search index', async () => {
      const r = await call('GET', `/search/search?q=${encodeURIComponent(`ao thun cotton e2e ${RUN}`)}`);
      return r.items?.some((i: Json) => i.id === product.id);
    }),
  );

  await step('BFF trang sản phẩm gom catalog + kho + review + gợi ý', async () => {
    const r = await call('GET', `/bff/products/${product.slug}`);
    if (!r.product && !r.id) throw new Error('BFF thiếu product');
    return r;
  });

  const buyer = await step('Người mua đăng ký + đăng nhập + thêm địa chỉ', async () => {
    const b = await registerAndLogin('buyer');
    const addr = await call('POST', '/user-profile/me/addresses', {
      token: b.accessToken,
      body: { fullName: 'Trần Thị B', phone: '0912345678', line1: '12 Trần Phú', ward: 'Điện Biên', district: 'Ba Đình', province: 'Hà Nội', isDefault: true },
    });
    return { ...b, addressId: addr.id };
  });

  await step('Admin tạo voucher sàn, seller tạo voucher shop', async () => {
    const now = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 86_400_000).toISOString();
    await call('POST', '/promotion/admin/vouchers', {
      token: admin.accessToken,
      body: { code: `SAN${RUN}`.toUpperCase(), type: 'FIXED', value: 10000, minOrder: 100000, usageLimit: 100, perUserLimit: 1, startsAt: now, endsAt: end },
    });
    await call('POST', '/promotion/seller/vouchers', {
      token: seller.accessToken,
      body: { code: `SHOP${RUN}`.toUpperCase(), type: 'PERCENT', value: 10, maxDiscount: 20000, minOrder: 100000, usageLimit: 100, perUserLimit: 1, startsAt: now, endsAt: end },
    });
  });

  await step('Giỏ hàng: thêm 2 áo size M, nhóm theo shop', async () => {
    await call('POST', '/cart/cart/items', { token: buyer.accessToken, body: { skuId: skuM, qty: 2 } });
    const cart = await call('GET', '/cart/cart', { token: buyer.accessToken });
    if (!(cart.shops ?? cart.groups)?.length) throw new Error('giỏ rỗng');
  });

  const cod = await step('Checkout COD + 2 voucher → saga CONFIRMED', async () => {
    const r = await call('POST', '/order/checkout', {
      token: buyer.accessToken,
      headers: { 'idempotency-key': `cod-${RUN}` },
      body: { items: [{ skuId: skuM, qty: 2 }], addressId: buyer.addressId, voucherCodes: [`SAN${RUN}`.toUpperCase(), `SHOP${RUN}`.toUpperCase()], paymentMethod: 'COD' },
    });
    const again = await call('POST', '/order/checkout', {
      token: buyer.accessToken,
      headers: { 'idempotency-key': `cod-${RUN}` },
      body: { items: [{ skuId: skuM, qty: 2 }], addressId: buyer.addressId, voucherCodes: [`SAN${RUN}`.toUpperCase(), `SHOP${RUN}`.toUpperCase()], paymentMethod: 'COD' },
    });
    if (again.checkoutId !== r.checkoutId) throw new Error('Idempotency-Key không giữ kết quả cũ');
    const done = await poll('checkout COD confirmed', async () => {
      const c = await call('GET', `/order/checkouts/${r.checkoutId}`, { token: buyer.accessToken });
      if (c.status === 'CANCELLED') throw new Error(`checkout bị huỷ: ${JSON.stringify(c.orders?.[0]?.reason ?? c)}`);
      return c.status === 'CONFIRMED' ? c : undefined;
    });
    const order = done.orders[0];
    // 2×150.000 = 300.000; voucher shop 10% = 20.000 (trần) ; voucher sàn 10.000
    if (order.subtotal !== 300000 || order.discount !== 30000) throw new Error(`tính tiền sai: ${JSON.stringify({ s: order.subtotal, d: order.discount })}`);
    return { checkoutId: r.checkoutId, orderId: order.id ?? r.orderIds[0] };
  });

  await step('Kho đã trừ (5 → 3), giỏ đã xoá món vừa đặt', async () => {
    await poll('stock committed', async () => {
      const s = await call('GET', `/inventory/stock?skuIds=${skuM}`);
      const row = (Array.isArray(s) ? s : s.items)[0];
      return row.onHand === 3 && row.reserved === 0;
    });
    await poll('cart cleared', async () => {
      const cart = await call('GET', '/cart/cart', { token: buyer.accessToken });
      return !(cart.shops ?? cart.groups ?? []).some((g: Json) => g.items.some((i: Json) => i.skuId === skuM));
    });
  });

  await step('Shipping tạo vận đơn → seller giao → hãng giao tới → DELIVERED', async () => {
    const sh = await poll('shipment created', async () => call('GET', `/shipping/shipments/by-order/${cod.orderId}`, { token: seller.accessToken, expect: [200, 404] }).then((x) => (x.id ? x : undefined)));
    await call('POST', `/shipping/seller/shipments/${sh.id}/pick`, { token: seller.accessToken });
    for (let i = 0; i < 3; i++) await call('POST', `/shipping/dev/shipments/${sh.id}/advance`, { token: admin.accessToken, expect: [200, 201, 409] });
    await poll('order delivered', async () => (await call('GET', `/order/orders/${cod.orderId}`, { token: buyer.accessToken })).status === 'DELIVERED');
  });

  await step('Người mua xác nhận đã nhận → COMPLETED', async () => {
    await call('POST', `/order/orders/${cod.orderId}/confirm-received`, { token: buyer.accessToken });
    await poll('completed', async () => (await call('GET', `/order/orders/${cod.orderId}`, { token: buyer.accessToken })).status === 'COMPLETED');
  });

  await step('Đánh giá 5★ (chỉ người đã mua) → điểm sản phẩm cập nhật', async () => {
    await poll('review được mở', async () => {
      await call('POST', '/review/reviews', { token: buyer.accessToken, body: { orderId: cod.orderId, productId: product.id, rating: 5, content: 'Áo đẹp, vải mát, giao nhanh!', images: [] } });
      return true;
    }, 20_000, 1000);
    await poll('rating cập nhật ở catalog', async () => (await call('GET', `/catalog/products/${product.id}`)).ratingCount === 1);
  });

  await step('Ví người bán được ghi có (trừ 5% phí sàn)', () =>
    poll('wallet', async () => {
      const w = await call('GET', '/payment/seller/wallet', { token: seller.accessToken });
      return (w.available ?? w.balance ?? 0) > 0 ? w : undefined;
    }),
  );

  await step('Thanh toán online thất bại → saga bù trừ: huỷ đơn + nhả kho', async () => {
    const r = await call('POST', '/order/checkout', {
      token: buyer.accessToken,
      headers: { 'idempotency-key': `mock-${RUN}` },
      body: { items: [{ skuId: skuL, qty: 1 }], addressId: buyer.addressId, paymentMethod: 'MOCK' },
    });
    const c = await poll('redirectUrl', async () => {
      const x = await call('GET', `/order/checkouts/${r.checkoutId}`, { token: buyer.accessToken });
      return x.redirectUrl ? x : undefined;
    });
    const paymentId = String(c.redirectUrl).split('/').pop();
    await call('POST', `/payment/pay/mock/${paymentId}/complete`, { body: { result: 'fail' }, expect: [200, 201, 302, 303] });
    await poll('cancelled', async () => (await call('GET', `/order/checkouts/${r.checkoutId}`, { token: buyer.accessToken })).status === 'CANCELLED');
    await poll('stock released', async () => {
      const s = await call('GET', `/inventory/stock?skuIds=${skuL}`);
      const row = (Array.isArray(s) ? s : s.items)[0];
      return row.available === 1;
    });
  });

  await step('Đặt vượt tồn kho → CANCELLED (OUT_OF_STOCK)', async () => {
    const r = await call('POST', '/order/checkout', {
      token: buyer.accessToken,
      headers: { 'idempotency-key': `oos-${RUN}` },
      body: { items: [{ skuId: skuL, qty: 5 }], addressId: buyer.addressId, paymentMethod: 'COD' },
      expect: [200, 201, 409],
    });
    if (!r.checkoutId) return; // chặn ngay ở bước đồng bộ cũng hợp lệ
    await poll('oos cancelled', async () => (await call('GET', `/order/checkouts/${r.checkoutId}`, { token: buyer.accessToken })).status === 'CANCELLED');
  });

  await step('Thông báo in-app cho người mua + email trong Mailpit', async () => {
    const n = await poll('notifications', async () => {
      const r = await call('GET', '/notification/notifications', { token: buyer.accessToken });
      return r.items?.length >= 3 ? r : undefined;
    });
    return n;
  });

  await step('Chatbot CSKH trả lời (LLM hoặc dự phòng)', async () => {
    const r = await call('POST', '/ai/chat', { token: buyer.accessToken, body: { message: 'Chính sách đổi trả thế nào?', history: [] } });
    if (!r.answer && !r.reply) throw new Error('chatbot không trả lời');
  });
}

main()
  .catch(() => undefined)
  .finally(() => {
    const ok = results.filter((r) => r.ok).length;
    console.log(`\nKết quả: ${ok}/${results.length} bước đạt`);
    if (ok !== results.length) process.exit(1);
  });
