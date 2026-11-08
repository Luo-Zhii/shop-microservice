// Kiểu dữ liệu chép từ packages/contracts/src/index.ts (giữ apps/web độc lập khi build Docker)
// + các kiểu phía giao diện. Các response chưa có hợp đồng chi tiết được khai báo "lỏng" (tuỳ chọn).

export type Role = 'buyer' | 'seller' | 'admin';

export interface Address {
  id?: string;
  fullName: string;
  phone: string;
  line1: string;
  ward: string;
  district: string;
  province: string;
  isDefault?: boolean;
}

export type ProductStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'HIDDEN';

export interface VariantSnapshot {
  id: string;
  sku: string;
  options: Record<string, string>;
  price: number;
  compareAtPrice?: number | null;
  weightGrams: number;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface ProductSnapshot {
  id: string;
  shopId: string;
  shopName: string;
  categoryId: string;
  categoryPath: string[];
  title: string;
  slug: string;
  description: string;
  brand?: string | null;
  attributes: Record<string, string>;
  images: string[];
  status: ProductStatus;
  minPrice: number;
  maxPrice: number;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  variants: VariantSnapshot[];
  createdAt: string;
  updatedAt: string;
  rejectReason?: string | null;
}

/** Sản phẩm dạng thẻ — chấp nhận cả kết quả search (có thể chỉ có `image`). */
export interface ProductLike {
  id: string;
  slug?: string;
  title: string;
  image?: string | null;
  images?: string[];
  minPrice?: number;
  maxPrice?: number;
  price?: number;
  compareAtPrice?: number | null;
  salePrice?: number;
  ratingAvg?: number;
  ratingCount?: number;
  soldCount?: number;
  shopName?: string;
}

export type OrderStatus =
  | 'PENDING'
  | 'AWAITING_PAYMENT'
  | 'CONFIRMED'
  | 'SHIPPING'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RETURN_REQUESTED'
  | 'RETURNED';

export type PaymentMethod = 'COD' | 'MOCK' | 'VNPAY';

export interface OrderItemSnapshot {
  skuId: string;
  productId: string;
  title: string;
  variantLabel: string;
  image?: string | null;
  unitPrice: number;
  qty: number;
  lineTotal: number;
  reviewed?: boolean;
}

export interface OrderSnapshot {
  id: string;
  checkoutId: string;
  buyerId: string;
  shopId: string;
  shopName?: string;
  status: OrderStatus;
  items: OrderItemSnapshot[];
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  shippingAddress: Address;
  createdAt: string;
  updatedAt?: string;
  reason?: string;
  cancelReason?: string | null;
  returnReason?: string | null;
  shipmentId?: string | null;
  carrier?: string | null;
  trackingCode?: string | null;
  timeline?: { from?: string | null; status: string; note?: string | null; at: string }[];
}

export type ShopStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface Shop {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  status: ShopStatus;
  pickupProvince?: string | null;
  description?: string | null;
  logo?: string | null;
  logoUrl?: string | null;
  phone?: string | null;
  rejectReason?: string | null;
  suspendReason?: string | null;
  pickupAddress?: { line1: string; ward: string; district: string; province: string } | null;
  kyc?: { legalName?: string; taxCode?: string | null; idNumber?: string };
  bankAccount?: { bankName?: string; accountNumber?: string; holder?: string };
  submittedAt?: string;
  followerCount?: number;
  followers?: number;
  productCount?: number;
  ratingAvg?: number;
  isFollowing?: boolean;
  following?: boolean;
  createdAt: string;
}

export type ShipmentStatus = 'CREATED' | 'PICKED' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED';

export interface Shipment {
  id: string;
  orderId: string;
  carrier?: string;
  trackingCode?: string;
  fee?: number;
  status: ShipmentStatus;
  etaDays?: number;
  events?: { status: string; at: string; note?: string; location?: string }[];
  history?: { status: string; at: string; note?: string }[];
  createdAt?: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface Category {
  id: string;
  parentId?: string | null;
  name: string;
  slug: string;
  icon?: string | null;
  sort?: number;
  children?: Category[];
}

export interface Banner {
  id: string;
  title: string;
  imageUrl: string;
  linkUrl?: string | null;
  sort?: number;
}

export interface FlashSaleItem extends ProductLike {
  productId?: string;
  skuId?: string;
  salePrice?: number;
  originalPrice?: number;
  quota?: number;
  sold?: number;
  product?: ProductLike;
}

export interface FlashSale {
  id: string;
  name?: string;
  title?: string;
  startsAt: string;
  endsAt: string;
  items: FlashSaleItem[];
  status?: string;
}

export interface Voucher {
  id?: string;
  code: string;
  title?: string;
  name?: string;
  description?: string;
  shopId?: string | null;
  type?: 'PERCENT' | 'FIXED' | 'FREESHIP' | string;
  value?: number;
  maxDiscount?: number | null;
  minOrder?: number | null;
  minOrderValue?: number | null;
  quota?: number | null;
  usageLimit?: number | null;
  used?: number;
  usedCount?: number;
  startsAt?: string;
  endsAt?: string;
  active?: boolean;
}

export interface Review {
  id: string;
  productId: string;
  orderId?: string;
  userId?: string;
  userName?: string;
  authorName?: string;
  rating: number;
  content: string;
  images?: string[];
  variantLabel?: string;
  reply?: { content: string; at?: string } | string | null;
  sellerReply?: string | null;
  hidden?: boolean;
  createdAt: string;
}

export interface ReviewSummary {
  ratingAvg?: number;
  avg?: number;
  average?: number;
  ratingCount?: number;
  count?: number;
  total?: number;
  distribution?: Record<string, number>;
  histogram?: Record<string, number>;
}

export interface AppNotification {
  id: string;
  type?: string;
  title: string;
  body?: string;
  message?: string;
  link?: string | null;
  url?: string | null;
  read?: boolean;
  readAt?: string | null;
  createdAt: string;
}

export interface CartItem {
  skuId: string;
  productId?: string;
  slug?: string;
  title: string;
  variantLabel?: string;
  image?: string | null;
  qty: number;
  price: number;
  unitPrice?: number;
  addedPrice?: number;
  priceAtAdd?: number;
  priceChanged?: boolean;
  available?: number;
  stock?: number;
  status?: string;
  weightGrams?: number;
  shopId?: string;
  shopName?: string;
}

export interface CartShopGroup {
  shopId: string;
  shopName?: string;
  pickupProvince?: string | null;
  items: CartItem[];
}

export interface Cart {
  cartId?: string;
  shops: CartShopGroup[];
  notices?: string[];
}

export interface AuthUser {
  id: string;
  email: string;
  fullName?: string;
  roles: Role[];
  shopId?: string;
  emailVerified?: boolean;
  twoFactorEnabled?: boolean;
  totpEnabled?: boolean;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user?: Partial<AuthUser>;
}

export interface Profile {
  userId?: string;
  fullName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  gender?: string | null;
  birthday?: string | null;
}

export interface CheckoutStatus {
  checkoutId?: string;
  id?: string;
  status: string;
  redirectUrl?: string | null;
  orders?: OrderSnapshot[];
  orderIds?: string[];
  reason?: string | null;
  cancelReason?: string | null;
  total?: number;
}
