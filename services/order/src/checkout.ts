import { createHash } from 'node:crypto';
import { badRequest, conflict, createEvent, enqueue, newId, withTx, z, type Pool } from '@shopnow/platform';
import { Topics, type Address, type InventoryReserve, type PaymentMethod } from '@shopnow/contracts';
import type { OrderDeps, SkuInfo } from './clients';
import type { SagaConfig } from './config';
import { emitOrderEvent, ordersCreated } from './repo';
import type { Log } from './repo';

export const addressSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^\+?[0-9 .-]{8,15}$/, 'Số điện thoại không hợp lệ'),
  line1: z.string().trim().min(3).max(255),
  ward: z.string().trim().min(1).max(120),
  district: z.string().trim().min(1).max(120),
  province: z.string().trim().min(1).max(120),
  isDefault: z.boolean().optional(),
});

export const checkoutSchema = z
  .object({
    items: z.array(z.object({ skuId: z.string().min(1).max(64), qty: z.number().int().min(1).max(999) })).min(1).max(100),
    addressId: z.string().min(1).max(64).optional(),
    shippingAddress: addressSchema.optional(),
    voucherCodes: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
    paymentMethod: z.enum(['COD', 'MOCK', 'VNPAY']),
  })
  .refine((b) => b.addressId || b.shippingAddress, { message: 'Cần addressId hoặc shippingAddress', path: ['shippingAddress'] });
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface CheckoutResult {
  checkoutId: string;
  status: string;
  orderIds: string[];
}

interface ShopDraft {
  shopId: string;
  orderId: string;
  items: (SkuInfo & { qty: number; unitPrice: number })[];
  weightGrams: number;
  shippingFeeOriginal: number;
  carrier: string;
  discount: number;
  shippingDiscount: number;
  appliedVouchers: unknown[];
}

const hashBody = (b: unknown) => createHash('sha256').update(JSON.stringify(b)).digest('hex');

/**
 * POST /checkout: các bước đồng bộ (giá thật, địa chỉ, phí ship, khuyến mãi) rồi MỘT transaction
 * ghi checkout + N order + outbox (order.created ×N, inventory.reserve). Saga chạy tiếp qua sự kiện.
 */
export async function createCheckout(
  ctx: { pool: Pool; deps: OrderDeps; cfg: SagaConfig; log?: Log },
  buyerId: string,
  input: CheckoutInput,
  idempotencyKey?: string,
): Promise<{ result: CheckoutResult; replayed: boolean }> {
  const { pool, deps, cfg } = ctx;
  const requestHash = hashBody(input);
  let checkoutId = newId();

  // 1. Giữ chỗ Idempotency-Key trước khi gọi service khác — request trùng chạy song song không tạo 2 checkout.
  //    Lần trước lỗi (FAILED) hoặc treo quá 60s → dùng lại đúng checkoutId cũ để promotion trả lại kết quả đã khoá
  //    (quote idempotent theo checkoutId) thay vì khoá thêm voucher/suất flash sale lần nữa.
  if (idempotencyKey) {
    const ins = await pool.query(
      `INSERT INTO idempotency_keys (buyer_id, key, request_hash, checkout_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING checkout_id`,
      [buyerId, idempotencyKey, requestHash, checkoutId],
    );
    if (!ins.rowCount) {
      const { rows } = await pool.query('SELECT * FROM idempotency_keys WHERE buyer_id = $1 AND key = $2', [buyerId, idempotencyKey]);
      const prev = rows[0];
      if (prev && prev.request_hash !== requestHash) throw conflict('Idempotency-Key đã được dùng cho một yêu cầu khác');
      if (prev?.response) return { result: prev.response as CheckoutResult, replayed: true };
      const retry = await pool.query(
        `UPDATE idempotency_keys SET status = 'IN_PROGRESS', created_at = now()
          WHERE buyer_id = $1 AND key = $2 AND response IS NULL
            AND (status = 'FAILED' OR created_at < now() - interval '60 seconds')
        RETURNING checkout_id`,
        [buyerId, idempotencyKey],
      );
      if (!retry.rowCount) throw conflict('Yêu cầu đặt hàng với Idempotency-Key này đang được xử lý, vui lòng thử lại sau giây lát');
      checkoutId = retry.rows[0].checkout_id;
      // Lần trước đã lưu xong nhưng chưa kịp ghi response (crash) → trả lại checkout đó.
      const exists = await pool.query('SELECT status FROM checkouts WHERE id = $1', [checkoutId]);
      if (exists.rowCount) {
        const ids = await pool.query('SELECT id FROM orders WHERE checkout_id = $1 ORDER BY created_at, id', [checkoutId]);
        const result: CheckoutResult = { checkoutId, status: exists.rows[0].status, orderIds: ids.rows.map((r) => r.id) };
        await pool.query(`UPDATE idempotency_keys SET response = $3, status = 'DONE' WHERE buyer_id = $1 AND key = $2`, [buyerId, idempotencyKey, result]);
        return { result, replayed: true };
      }
    }
  }

  try {
    const result = await buildAndSave();
    if (idempotencyKey) {
      await pool.query(`UPDATE idempotency_keys SET response = $3, status = 'DONE' WHERE buyer_id = $1 AND key = $2`, [buyerId, idempotencyKey, result]);
    }
    return { result, replayed: false };
  } catch (e) {
    // Thất bại trước khi lưu → đánh dấu FAILED để người mua thử lại cùng key.
    if (idempotencyKey) {
      await pool
        .query(`UPDATE idempotency_keys SET status = 'FAILED' WHERE buyer_id = $1 AND key = $2 AND response IS NULL`, [buyerId, idempotencyKey])
        .catch(() => undefined);
    }
    throw e;
  }

  async function buildAndSave(): Promise<CheckoutResult> {
    // Gộp SKU trùng
    const qtyBySku = new Map<string, number>();
    for (const it of input.items) qtyBySku.set(it.skuId, (qtyBySku.get(it.skuId) ?? 0) + it.qty);
    for (const [skuId, q] of qtyBySku) if (q > 999) throw badRequest(`Số lượng SKU ${skuId} vượt quá 999`);

    // 2. Giá thật từ catalog
    const skus = await deps.catalog.skus([...qtyBySku.keys()]);
    const bySku = new Map(skus.map((s) => [s.skuId, s]));
    for (const skuId of qtyBySku.keys()) {
      const s = bySku.get(skuId);
      if (!s) throw badRequest(`Sản phẩm (SKU ${skuId}) không tồn tại`);
      if (!s.purchasable) throw badRequest(`Sản phẩm "${s.title}${s.variantLabel ? ` - ${s.variantLabel}` : ''}" hiện không còn bán`);
      if (!Number.isInteger(s.price) || s.price < 0) throw badRequest(`Giá sản phẩm "${s.title}" không hợp lệ`);
    }

    // 3. Địa chỉ giao hàng
    const address: Address = input.addressId
      ? addressSchema.parse(await deps.profile.address(input.addressId, buyerId))
      : (input.shippingAddress as Address);

    // 4. Tách theo shop (giữ thứ tự xuất hiện trong giỏ)
    const shops = new Map<string, ShopDraft>();
    for (const [skuId, qty] of qtyBySku) {
      const s = bySku.get(skuId)!;
      let d = shops.get(s.shopId);
      if (!d) {
        d = { shopId: s.shopId, orderId: newId(), items: [], weightGrams: 0, shippingFeeOriginal: 0, carrier: '', discount: 0, shippingDiscount: 0, appliedVouchers: [] };
        shops.set(s.shopId, d);
      }
      d.items.push({ ...s, qty, unitPrice: s.price });
      d.weightGrams += Math.max(1, s.weightGrams || 0) * qty;
    }

    // 5. Phí ship từng shop: từ tỉnh lấy hàng của shop tới tỉnh người nhận
    await Promise.all(
      [...shops.values()].map(async (d) => {
        const shop = await deps.seller.shop(d.shopId);
        const q = await deps.shipping.quote({
          fromProvince: shop.pickupProvince || cfg.DEFAULT_PICKUP_PROVINCE,
          toProvince: address.province,
          weightGrams: d.weightGrams,
        });
        if (!Number.isInteger(q.fee) || q.fee < 0) throw badRequest('Phí vận chuyển không hợp lệ');
        d.shippingFeeOriginal = q.fee;
        d.carrier = q.carrier;
      }),
    );

    // 6. Khuyến mãi (giá flash sale + voucher), commit=true → promotion khoá voucher/suất theo checkoutId
    const promo = await deps.promotion.quote({
      checkoutId,
      buyerId,
      shops: [...shops.values()].map((d) => ({
        shopId: d.shopId,
        items: d.items.map((i) => ({ skuId: i.skuId, productId: i.productId, price: i.price, qty: i.qty })),
        shippingFee: d.shippingFeeOriginal,
      })),
      voucherCodes: input.voucherCodes,
      commit: true,
    });
    for (const ps of promo.shops ?? []) {
      const d = shops.get(ps.shopId);
      if (!d) continue;
      for (const pi of ps.items ?? []) {
        const it = d.items.find((i) => i.skuId === pi.skuId);
        if (it && Number.isInteger(pi.unitPrice) && pi.unitPrice >= 0 && pi.unitPrice <= it.price) it.unitPrice = pi.unitPrice;
      }
      d.discount = Math.max(0, Math.trunc(ps.discount || 0));
      d.shippingDiscount = Math.max(0, Math.trunc(ps.shippingDiscount || 0));
      d.appliedVouchers = ps.appliedVouchers ?? [];
    }

    // 7. Tính tiền từng order (VND nguyên)
    const drafts = [...shops.values()].map((d) => {
      const subtotal = d.items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
      const discount = Math.min(d.discount, subtotal);
      const shippingFee = Math.max(0, d.shippingFeeOriginal - Math.min(d.shippingDiscount, d.shippingFeeOriginal));
      return { ...d, subtotal, discount, shippingFee, total: subtotal - discount + shippingFee };
    });
    const sum = (k: 'subtotal' | 'discount' | 'shippingFee' | 'total') => drafts.reduce((s, d) => s + d[k], 0);
    const method = input.paymentMethod as PaymentMethod;

    // 8. Một transaction: checkout + orders + items + lịch sử + outbox
    await withTx(pool, async (c) => {
      await c.query(
        `INSERT INTO checkouts (id, buyer_id, status, payment_method, subtotal, shipping_fee, discount, total, voucher_codes, shipping_address, promotion)
         VALUES ($1,$2,'PENDING',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [checkoutId, buyerId, method, sum('subtotal'), sum('shippingFee'), sum('discount'), sum('total'), JSON.stringify(input.voucherCodes), address, promo],
      );
      for (const d of drafts) {
        await c.query(
          `INSERT INTO orders (id, checkout_id, buyer_id, shop_id, status, subtotal, shipping_fee, shipping_fee_original, discount, total,
             payment_method, shipping_address, applied_vouchers, carrier)
           VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [d.orderId, checkoutId, buyerId, d.shopId, d.subtotal, d.shippingFee, d.shippingFeeOriginal, d.discount, d.total, method, address,
            JSON.stringify(d.appliedVouchers), d.carrier || null],
        );
        for (const i of d.items) {
          await c.query(
            `INSERT INTO order_items (order_id, sku_id, product_id, title, variant_label, image, list_price, unit_price, qty, line_total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [d.orderId, i.skuId, i.productId, i.title, i.variantLabel ?? '', i.image ?? null, i.price, i.unitPrice, i.qty, i.unitPrice * i.qty],
          );
        }
        await c.query(`INSERT INTO order_status_history (order_id, from_status, to_status, note) VALUES ($1, NULL, 'PENDING', 'Đặt hàng')`, [d.orderId]);
        await emitOrderEvent(c, 'order.created', d.orderId);
      }
      const reserve: InventoryReserve = {
        reservationId: checkoutId,
        orderIds: drafts.map((d) => d.orderId),
        items: [...qtyBySku].map(([skuId, qty]) => ({ skuId, qty })),
        ttlSeconds: cfg.PAYMENT_TIMEOUT_SECONDS,
      };
      await enqueue(c, Topics.inventoryCommand, createEvent('inventory.reserve', 'order', checkoutId, reserve));
    });
    ordersCreated().inc(drafts.length);
    return { checkoutId, status: 'PENDING', orderIds: drafts.map((d) => d.orderId) };
  }
}
