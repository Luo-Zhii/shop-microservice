import { badRequest, conflict, newId, withTx, z, type Pool, type PoolClient } from '@shopnow/platform';
import { applyVouchers, type Voucher } from './engine';
import type { FlashItem, FlashStore } from './flash';

export const quoteSchema = z
  .object({
    checkoutId: z.string().uuid().optional(),
    buyerId: z.string().min(1).max(64),
    shops: z
      .array(
        z.object({
          shopId: z.string().min(1).max(64),
          items: z
            .array(z.object({ skuId: z.string().min(1).max(64), productId: z.string().min(1).max(64), price: z.number().int().min(0), qty: z.number().int().min(1).max(999) }))
            .min(1),
          shippingFee: z.number().int().min(0).default(0),
        }),
      )
      .min(1)
      .max(50),
    voucherCodes: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
    commit: z.boolean().default(false),
  })
  .refine((q) => !q.commit || q.checkoutId, { message: 'commit=true cần checkoutId', path: ['checkoutId'] });
export type QuoteInput = z.infer<typeof quoteSchema>;

export interface QuoteItem {
  skuId: string;
  productId: string;
  qty: number;
  listPrice: number;
  unitPrice: number;
  flashSaleId?: string;
  flashSaleItemId?: string;
}

export interface QuoteResponse {
  checkoutId?: string;
  shops: {
    shopId: string;
    subtotal: number;
    discount: number;
    shopDiscount: number;
    platformDiscount: number;
    shippingDiscount: number;
    appliedVouchers: unknown[];
    items: QuoteItem[];
  }[];
  platformDiscount: number;
  /** Tổng giảm voucher (tiền hàng + phí ship), không gồm phần rẻ hơn nhờ flash sale. */
  totalDiscount: number;
  flashSaleSavings: number;
}

type Db = Pool | PoolClient;

export function voucherFromRow(r: Record<string, any>): Voucher {
  return {
    id: r.id,
    code: r.code,
    scope: r.scope,
    shopId: r.shop_id,
    type: r.type,
    value: Number(r.value),
    maxDiscount: r.max_discount == null ? null : Number(r.max_discount),
    minOrder: Number(r.min_order),
    usageLimit: r.usage_limit,
    perUserLimit: r.per_user_limit,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
    active: r.active,
    used: Number(r.used ?? 0),
    usedByBuyer: Number(r.used_by_buyer ?? 0),
  };
}

async function loadVouchers(db: Db, codes: string[], buyerId: string, lock: boolean): Promise<Voucher[]> {
  const norm = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (norm.length === 0) return [];
  // Khoá hàng voucher (ORDER BY id để mọi transaction khoá cùng thứ tự → không deadlock) rồi mới đếm lượt dùng.
  const { rows } = await db.query(`SELECT * FROM vouchers WHERE code = ANY($1::text[]) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [norm]);
  for (const code of norm) if (!rows.some((r) => r.code === code)) throw badRequest(`Mã giảm giá ${code} không tồn tại`);
  const usage = await db.query(
    `SELECT voucher_id, count(*)::int used, count(*) FILTER (WHERE buyer_id = $2)::int used_by_buyer
       FROM redemptions WHERE voucher_id = ANY($1::uuid[]) AND status <> 'RELEASED' GROUP BY voucher_id`,
    [rows.map((r) => r.id), buyerId],
  );
  const u = new Map(usage.rows.map((r) => [r.voucher_id, r]));
  return norm.map((code) => {
    const r = rows.find((x) => x.code === code)!;
    return voucherFromRow({ ...r, used: u.get(r.id)?.used ?? 0, used_by_buyer: u.get(r.id)?.used_by_buyer ?? 0 });
  });
}

/** Item flash sale đang chạy cho các SKU (nhiều chương trình trùng → lấy giá thấp nhất). */
async function activeFlashItems(db: Db, skuIds: string[], now: Date): Promise<Map<string, FlashItem & { flash_sale_id: string }>> {
  if (skuIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT i.* FROM flash_sale_items i JOIN flash_sales f ON f.id = i.flash_sale_id
      WHERE i.sku_id = ANY($1::text[]) AND f.active AND f.starts_at <= $2 AND f.ends_at > $2
      ORDER BY i.sale_price ASC, i.id`,
    [skuIds, now],
  );
  const m = new Map<string, FlashItem & { flash_sale_id: string }>();
  for (const r of rows) if (!m.has(r.sku_id)) m.set(r.sku_id, { ...r, sale_price: Number(r.sale_price) });
  return m;
}

/**
 * POST /quote. commit=false: chỉ tính (không giữ gì). commit=true: giữ suất flash sale (Redis Lua) + khoá voucher
 * (redemption LOCKED) trong một transaction, idempotent theo checkoutId (gọi lại trả đúng kết quả cũ).
 */
export async function quote(ctx: { pool: Pool; flash: FlashStore }, input: QuoteInput, now = new Date()): Promise<QuoteResponse> {
  const { pool, flash } = ctx;
  if (new Set(input.shops.map((s) => s.shopId)).size !== input.shops.length) throw badRequest('Mỗi shop chỉ xuất hiện một lần trong shops');
  const skuIds = [...new Set(input.shops.flatMap((s) => s.items.map((i) => i.skuId)))];

  if (!input.commit) {
    const items = await activeFlashItems(pool, skuIds, now);
    const priced = await priceItems(input, items, async (fi, qty) => {
      await flash.ensureCounter(pool, fi.id);
      const sold = (await flash.soldMany([fi.id])).get(fi.id) ?? 0;
      if (sold + qty > fi.quota) return false;
      if (fi.per_user_limit && (await flash.userCount(fi.id, input.buyerId)) + qty > fi.per_user_limit) return false;
      return true;
    });
    return build(input, priced, await loadVouchers(pool, input.voucherCodes, input.buyerId, false), now);
  }

  const checkoutId = input.checkoutId!;
  const acquired: { itemId: string; qty: number }[] = [];
  try {
    return await withTx(pool, async (c) => {
      // Tuần tự hoá các lần quote cùng checkoutId (request lặp lại / retry đồng thời).
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quote:${checkoutId}`]);
      const prev = await c.query('SELECT buyer_id, response FROM quotes WHERE checkout_id = $1', [checkoutId]);
      if (prev.rows[0]) {
        if (prev.rows[0].buyer_id !== input.buyerId) throw conflict('checkoutId đã được dùng bởi người mua khác');
        return prev.rows[0].response as QuoteResponse;
      }
      const items = await activeFlashItems(c, skuIds, now);
      const priced = await priceItems(input, items, async (fi, qty) => {
        await flash.ensureCounter(c, fi.id);
        const r = await flash.reserve(fi, checkoutId, input.buyerId, qty);
        if (r.ok) acquired.push({ itemId: fi.id, qty: r.qty });
        return r.ok;
      });
      const vouchers = await loadVouchers(c, input.voucherCodes, input.buyerId, true);
      const { response, vq } = build(input, priced, vouchers, now, true);

      for (const r of vq.redemptions) {
        await c.query(
          `INSERT INTO redemptions (id, voucher_id, checkout_id, buyer_id, shop_id, amount, allocation, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'LOCKED')`,
          [newId(), r.voucher.id, checkoutId, input.buyerId, r.shopId, r.amount, r.allocation],
        );
      }
      for (const s of response.shops) {
        for (const it of s.items) {
          if (!it.flashSaleItemId) continue;
          await c.query(
            `INSERT INTO flash_sale_holds (id, item_id, checkout_id, buyer_id, sku_id, qty, status) VALUES ($1,$2,$3,$4,$5,$6,'LOCKED')`,
            [newId(), it.flashSaleItemId, checkoutId, input.buyerId, it.skuId, it.qty],
          );
        }
      }
      await c.query('INSERT INTO quotes (checkout_id, buyer_id, response) VALUES ($1,$2,$3)', [checkoutId, input.buyerId, response]);
      return response;
    });
  } catch (e) {
    // Lỗi (voucher không hợp lệ, DB…) → trả lại suất flash sale vừa giữ trong lần gọi này.
    for (const a of acquired) await flash.release(a.itemId, checkoutId, input.buyerId, a.qty).catch(() => undefined);
    throw e;
  }
}

type Priced = { shopId: string; shippingFee: number; items: QuoteItem[] }[];

async function priceItems(
  input: QuoteInput,
  flashItems: Map<string, FlashItem & { flash_sale_id: string }>,
  take: (fi: FlashItem, qty: number) => Promise<boolean>,
): Promise<Priced> {
  // Gộp qty theo SKU trong mỗi shop để giữ suất một lần / SKU
  const out: Priced = [];
  for (const s of input.shops) {
    const merged = new Map<string, QuoteItem>();
    for (const i of s.items) {
      const cur = merged.get(i.skuId);
      if (cur) cur.qty += i.qty;
      else merged.set(i.skuId, { skuId: i.skuId, productId: i.productId, qty: i.qty, listPrice: i.price, unitPrice: i.price });
    }
    for (const it of merged.values()) {
      const fi = flashItems.get(it.skuId);
      if (!fi || fi.sale_price >= it.listPrice) continue;
      // Hết suất / vượt giới hạn mỗi người → tính giá thường (không chặn đặt hàng).
      if (await take(fi, it.qty)) {
        it.unitPrice = fi.sale_price;
        it.flashSaleId = fi.flash_sale_id;
        it.flashSaleItemId = fi.id;
      }
    }
    out.push({ shopId: s.shopId, shippingFee: s.shippingFee, items: [...merged.values()] });
  }
  return out;
}

function build(input: QuoteInput, priced: Priced, vouchers: Voucher[], now: Date): QuoteResponse;
function build(input: QuoteInput, priced: Priced, vouchers: Voucher[], now: Date, withVq: true): { response: QuoteResponse; vq: ReturnType<typeof applyVouchers> };
function build(input: QuoteInput, priced: Priced, vouchers: Voucher[], now: Date, withVq?: boolean) {
  const subtotals = priced.map((s) => ({ shopId: s.shopId, subtotal: s.items.reduce((a, i) => a + i.unitPrice * i.qty, 0), shippingFee: s.shippingFee }));
  const vq = applyVouchers(subtotals, vouchers, now);
  const shops = priced.map((s, i) => {
    const r = vq.shops.find((x) => x.shopId === s.shopId)!;
    return {
      shopId: s.shopId,
      subtotal: subtotals[i].subtotal,
      discount: r.discount,
      shopDiscount: r.shopDiscount,
      platformDiscount: r.platformDiscount,
      shippingDiscount: r.shippingDiscount,
      appliedVouchers: r.appliedVouchers,
      items: s.items,
    };
  });
  const response: QuoteResponse = {
    ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
    shops,
    platformDiscount: vq.platformDiscount,
    totalDiscount: shops.reduce((a, s) => a + s.discount + s.shippingDiscount, 0),
    flashSaleSavings: priced.reduce((a, s) => a + s.items.reduce((b, i) => b + (i.listPrice - i.unitPrice) * i.qty, 0), 0),
  };
  return withVq ? { response, vq } : response;
}
