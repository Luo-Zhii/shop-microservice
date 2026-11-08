import { badRequest } from '@shopnow/platform';

export type Scope = 'PLATFORM' | 'SHOP';
export type VoucherType = 'PERCENT' | 'FIXED' | 'FREESHIP';

export interface Voucher {
  id: string;
  code: string;
  scope: Scope;
  shopId: string | null;
  type: VoucherType;
  value: number;
  maxDiscount: number | null;
  minOrder: number;
  usageLimit: number | null;
  perUserLimit: number | null;
  startsAt: Date;
  endsAt: Date;
  active: boolean;
  /** Số lượt đã khoá/dùng (LOCKED + USED) — tổng và của người mua này. */
  used: number;
  usedByBuyer: number;
}

export interface ShopInput {
  shopId: string;
  /** Tiền hàng sau giá flash sale. */
  subtotal: number;
  shippingFee: number;
}

export interface AppliedVoucher {
  voucherId: string;
  code: string;
  scope: Scope;
  type: VoucherType;
  /** Phần giảm áp lên shop này (voucher sàn đã chia tỉ lệ). */
  discount: number;
}

export interface ShopResult {
  shopId: string;
  shopDiscount: number;
  platformDiscount: number;
  /** = shopDiscount + platformDiscount (giảm tiền hàng) */
  discount: number;
  shippingDiscount: number;
  appliedVouchers: AppliedVoucher[];
}

export interface VoucherQuote {
  shops: ShopResult[];
  platformDiscount: number;
  shippingDiscountTotal: number;
  /** Mỗi voucher được áp: tổng giảm + phần chia theo shop (để ghi redemption). */
  redemptions: { voucher: Voucher; shopId: string | null; amount: number; allocation: Record<string, number> }[];
}

const fmt = (n: number) => `${n.toLocaleString('vi-VN')}đ`;

/** Chia `amount` theo tỉ lệ `weights` thành số nguyên, tổng đúng bằng amount (phương pháp phần dư lớn nhất). */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map(Math.floor);
  let rest = amount - out.reduce((s, x) => s + x, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || weights[b.i] - weights[a.i]);
  for (let j = 0; rest > 0 && j < order.length; j++, rest--) out[order[j].i] += 1;
  return out;
}

function goodsDiscount(v: Voucher, base: number) {
  if (v.type === 'PERCENT') {
    const d = Math.floor((base * v.value) / 100);
    return Math.min(base, v.maxDiscount != null ? Math.min(d, v.maxDiscount) : d);
  }
  return Math.min(base, v.value);
}

/** Kiểm tra voucher còn dùng được (thời gian, lượt dùng); lỗi → VALIDATION_ERROR có thông báo rõ. */
export function assertUsable(v: Voucher, now: Date) {
  if (!v.active) throw badRequest(`Mã ${v.code} đã ngừng áp dụng`);
  if (now < v.startsAt) throw badRequest(`Mã ${v.code} chưa đến thời gian áp dụng`);
  if (now >= v.endsAt) throw badRequest(`Mã ${v.code} đã hết hạn`);
  if (v.usageLimit != null && v.used >= v.usageLimit) throw badRequest(`Mã ${v.code} đã hết lượt sử dụng`);
  if (v.perUserLimit != null && v.usedByBuyer >= v.perUserLimit) throw badRequest(`Bạn đã dùng hết lượt của mã ${v.code}`);
}

/**
 * Áp voucher: tối đa 1 voucher shop / shop + 1 voucher sàn + 1 freeship.
 * - voucher shop (PERCENT|FIXED) áp trên tiền hàng của shop đó;
 * - voucher sàn áp trên tổng tiền hàng (sau voucher shop), chia tỉ lệ về từng shop;
 * - FREESHIP giảm phí ship (shop: phí của shop đó; sàn: tổng phí, chia tỉ lệ theo phí từng shop).
 */
export function applyVouchers(shops: ShopInput[], vouchers: Voucher[], now: Date): VoucherQuote {
  const res = new Map<string, ShopResult>(
    shops.map((s) => [s.shopId, { shopId: s.shopId, shopDiscount: 0, platformDiscount: 0, discount: 0, shippingDiscount: 0, appliedVouchers: [] }]),
  );
  const redemptions: VoucherQuote['redemptions'] = [];
  const shopVoucher = new Map<string, Voucher>();
  let platform: Voucher | undefined;
  let freeship: Voucher | undefined;

  for (const v of vouchers) {
    assertUsable(v, now);
    if (v.scope === 'SHOP' && !res.has(v.shopId!)) throw badRequest(`Mã ${v.code} không áp dụng cho sản phẩm trong đơn`);
    if (v.type === 'FREESHIP') {
      if (freeship) throw badRequest('Chỉ được dùng 1 mã miễn phí vận chuyển cho mỗi đơn');
      freeship = v;
    } else if (v.scope === 'SHOP') {
      if (shopVoucher.has(v.shopId!)) throw badRequest('Mỗi shop chỉ được áp 1 mã giảm giá của shop');
      shopVoucher.set(v.shopId!, v);
    } else {
      if (platform) throw badRequest('Chỉ được dùng 1 mã giảm giá của sàn cho mỗi đơn');
      platform = v;
    }
  }

  // 1. Voucher shop
  for (const s of shops) {
    const v = shopVoucher.get(s.shopId);
    if (!v) continue;
    if (s.subtotal < v.minOrder) throw badRequest(`Mã ${v.code} yêu cầu đơn tối thiểu ${fmt(v.minOrder)} của shop (hiện ${fmt(s.subtotal)})`);
    const d = goodsDiscount(v, s.subtotal);
    const r = res.get(s.shopId)!;
    r.shopDiscount = d;
    r.appliedVouchers.push({ voucherId: v.id, code: v.code, scope: v.scope, type: v.type, discount: d });
    redemptions.push({ voucher: v, shopId: s.shopId, amount: d, allocation: { [s.shopId]: d } });
  }

  // 2. Voucher sàn trên tổng (sau voucher shop), chia tỉ lệ
  let platformDiscount = 0;
  if (platform) {
    const bases = shops.map((s) => s.subtotal - res.get(s.shopId)!.shopDiscount);
    const base = bases.reduce((a, b) => a + b, 0);
    if (base < platform.minOrder) throw badRequest(`Mã ${platform.code} yêu cầu đơn tối thiểu ${fmt(platform.minOrder)} (hiện ${fmt(base)})`);
    platformDiscount = goodsDiscount(platform, base);
    const parts = allocate(platformDiscount, bases);
    const allocation: Record<string, number> = {};
    shops.forEach((s, i) => {
      const r = res.get(s.shopId)!;
      r.platformDiscount = parts[i];
      allocation[s.shopId] = parts[i];
      if (parts[i] > 0) r.appliedVouchers.push({ voucherId: platform!.id, code: platform!.code, scope: 'PLATFORM', type: platform!.type, discount: parts[i] });
    });
    redemptions.push({ voucher: platform, shopId: null, amount: platformDiscount, allocation });
  }

  // 3. Freeship
  let shippingDiscountTotal = 0;
  if (freeship) {
    const v = freeship;
    const targets = v.scope === 'SHOP' ? shops.filter((s) => s.shopId === v.shopId) : shops;
    const goods = targets.reduce((a, s) => a + s.subtotal, 0);
    if (goods < v.minOrder) throw badRequest(`Mã ${v.code} yêu cầu đơn tối thiểu ${fmt(v.minOrder)} (hiện ${fmt(goods)})`);
    const fees = targets.map((s) => s.shippingFee);
    const totalFee = fees.reduce((a, b) => a + b, 0);
    shippingDiscountTotal = v.maxDiscount != null ? Math.min(totalFee, v.maxDiscount) : totalFee;
    const parts = allocate(shippingDiscountTotal, fees);
    const allocation: Record<string, number> = {};
    targets.forEach((s, i) => {
      const r = res.get(s.shopId)!;
      r.shippingDiscount = parts[i];
      allocation[s.shopId] = parts[i];
      if (parts[i] > 0 || v.scope === 'SHOP') r.appliedVouchers.push({ voucherId: v.id, code: v.code, scope: v.scope, type: v.type, discount: parts[i] });
    });
    redemptions.push({ voucher: v, shopId: v.scope === 'SHOP' ? v.shopId : null, amount: shippingDiscountTotal, allocation });
  }

  for (const r of res.values()) r.discount = r.shopDiscount + r.platformDiscount;
  return { shops: [...res.values()], platformDiscount, shippingDiscountTotal, redemptions };
}
