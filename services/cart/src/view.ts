import { counter, type Logger } from '@shopnow/platform';
import type { CatalogPort, InventoryPort, SkuInfo } from './clients';
import type { CartLine, CartRef, CartStore } from './store';

export interface CartItemView {
  skuId: string;
  productId: string | null;
  title: string;
  variantLabel: string;
  image: string | null;
  price: number;
  qty: number;
  /** null = không biết (inventory không trả lời) */
  available: number | null;
  purchasable: boolean;
  lineTotal: number;
}

export interface CartWarning {
  code: 'PRICE_CHANGED' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK' | 'UNAVAILABLE' | 'INVENTORY_UNAVAILABLE' | 'CATALOG_UNAVAILABLE';
  message: string;
  skuId?: string;
  oldPrice?: number;
  newPrice?: number;
  available?: number;
}

export interface ShopGroup {
  shopId: string | null;
  shopName: string;
  items: CartItemView[];
  subtotal: number;
}

export interface CartView {
  cartId: string | null;
  shops: ShopGroup[];
  totalQty: number;
  /** tổng tiền các dòng mua được */
  subtotal: number;
  warnings: CartWarning[];
}

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(n)}đ`;
const degraded = () => counter('cart_enrichment_degraded_total', 'GET /cart thiếu dữ liệu từ service phụ thuộc', ['dependency']);

/** Làm giàu giỏ bằng catalog (giá, tiêu đề) + inventory (tồn). Mỗi nguồn lỗi độc lập — không làm hỏng cả giỏ. */
export async function buildCartView(
  deps: { store: CartStore; catalog: CatalogPort; inventory: InventoryPort; log: Logger },
  ref: CartRef | null,
): Promise<CartView> {
  const empty: CartView = { cartId: ref?.kind === 'guest' ? ref.id : null, shops: [], totalQty: 0, subtotal: 0, warnings: [] };
  if (!ref) return empty;
  const lines = await deps.store.list(ref);
  if (lines.length === 0) return empty;
  const ids = lines.map((l) => l.skuId);
  const warnings: CartWarning[] = [];

  const [skuRes, stockRes] = await Promise.allSettled([deps.catalog.getSkus(ids), deps.inventory.getStock(ids)]);
  let skus = new Map<string, SkuInfo>();
  const catalogOk = skuRes.status === 'fulfilled';
  if (catalogOk) skus = new Map(skuRes.value.map((s) => [s.skuId, s]));
  else {
    deps.log.warn({ err: skuRes.reason }, 'catalog không trả lời — trả giỏ thiếu thông tin');
    degraded().inc({ dependency: 'catalog' });
    warnings.push({ code: 'CATALOG_UNAVAILABLE', message: 'Không tải được thông tin sản phẩm, vui lòng thử lại sau' });
  }
  let stock: Map<string, number> | null = null;
  if (stockRes.status === 'fulfilled') stock = stockRes.value;
  else {
    deps.log.warn({ err: stockRes.reason }, 'inventory không trả lời — available=null');
    degraded().inc({ dependency: 'inventory' });
    warnings.push({ code: 'INVENTORY_UNAVAILABLE', message: 'Tạm thời chưa kiểm tra được tồn kho' });
  }

  const groups = new Map<string, ShopGroup & { latest: number }>();
  const repriced: { skuId: string; price: number; addedAt: number }[] = [];
  const sorted = [...lines].sort((a, b) => b.addedAt - a.addedAt);
  for (const l of sorted) {
    const s = skus.get(l.skuId);
    const available = stock ? (stock.get(l.skuId) ?? null) : null;
    const item = toItem(l, s, available, catalogOk, warnings);
    if (s && l.priceAtAdd !== null && l.priceAtAdd !== s.price) {
      warnings.push({
        code: 'PRICE_CHANGED',
        skuId: l.skuId,
        oldPrice: l.priceAtAdd,
        newPrice: s.price,
        message: `Giá "${s.title}" đã thay đổi từ ${vnd(l.priceAtAdd)} thành ${vnd(s.price)}`,
      });
      repriced.push({ skuId: l.skuId, price: s.price, addedAt: l.addedAt });
    } else if (s && l.priceAtAdd === null) repriced.push({ skuId: l.skuId, price: s.price, addedAt: l.addedAt || Date.now() });
    const key = s?.shopId ?? '';
    let g = groups.get(key);
    if (!g) {
      g = { shopId: s?.shopId ?? null, shopName: s ? (s.shopName ?? '') : catalogOk ? 'Sản phẩm không còn bán' : 'Đang cập nhật', items: [], subtotal: 0, latest: l.addedAt };
      groups.set(key, g);
    }
    g.items.push(item);
    if (item.purchasable) g.subtotal += item.lineTotal;
  }
  // Báo đổi giá một lần rồi ghi nhận giá mới làm mốc (không chặn response nếu Redis lỗi).
  await deps.store.updatePrices(ref, repriced).catch((err) => deps.log.warn({ err }, 'không cập nhật được giá tham chiếu'));

  const shops = [...groups.values()].sort((a, b) => b.latest - a.latest).map(({ latest: _l, ...g }) => g);
  return {
    cartId: ref.kind === 'guest' ? ref.id : null,
    shops,
    totalQty: lines.reduce((n, l) => n + l.qty, 0),
    subtotal: shops.reduce((n, g) => n + g.subtotal, 0),
    warnings,
  };
}

function toItem(l: CartLine, s: SkuInfo | undefined, available: number | null, catalogOk: boolean, warnings: CartWarning[]): CartItemView {
  if (!s) {
    if (catalogOk) warnings.push({ code: 'UNAVAILABLE', skuId: l.skuId, message: 'Một sản phẩm trong giỏ không còn tồn tại' });
    return {
      skuId: l.skuId, productId: null, title: catalogOk ? 'Sản phẩm không còn tồn tại' : '', variantLabel: '', image: null,
      price: l.priceAtAdd ?? 0, qty: l.qty, available, purchasable: false, lineTotal: (l.priceAtAdd ?? 0) * l.qty,
    };
  }
  let purchasable = s.purchasable;
  if (!s.purchasable) warnings.push({ code: 'UNAVAILABLE', skuId: l.skuId, message: `"${s.title}" hiện ngừng bán` });
  else if (available !== null && available <= 0) {
    purchasable = false;
    warnings.push({ code: 'OUT_OF_STOCK', skuId: l.skuId, available: 0, message: `"${s.title}" đã hết hàng` });
  } else if (available !== null && available < l.qty) {
    purchasable = false;
    warnings.push({ code: 'INSUFFICIENT_STOCK', skuId: l.skuId, available, message: `"${s.title}" chỉ còn ${available} sản phẩm` });
  }
  return {
    skuId: l.skuId, productId: s.productId, title: s.title, variantLabel: s.variantLabel, image: s.image,
    price: s.price, qty: l.qty, available, purchasable, lineTotal: s.price * l.qty,
  };
}
