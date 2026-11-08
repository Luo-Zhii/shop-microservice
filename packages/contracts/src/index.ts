// Hợp đồng sự kiện & kiểu dữ liệu dùng chung giữa các service — xem docs/architecture.md §3.

export const Topics = {
  identityUser: 'identity.user.v1',
  sellerShop: 'seller.shop.v1',
  catalogProduct: 'catalog.product.v1',
  review: 'review.v1',
  inventoryCommand: 'inventory.command.v1',
  inventoryEvent: 'inventory.event.v1',
  paymentCommand: 'payment.command.v1',
  paymentEvent: 'payment.event.v1',
  order: 'order.v1',
  shipping: 'shipping.v1',
} as const;
export type Topic = (typeof Topics)[keyof typeof Topics];
export const ALL_TOPICS: Topic[] = Object.values(Topics);

export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  source: string;
  time: string;
  subject: string;
  traceparent?: string;
  data: T;
}

export type Role = 'buyer' | 'seller' | 'admin';

export interface Address {
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
}

export interface OrderSnapshot {
  id: string;
  checkoutId: string;
  buyerId: string;
  shopId: string;
  status: OrderStatus;
  items: OrderItemSnapshot[];
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  shippingAddress: Address;
  createdAt: string;
  reason?: string;
}

export interface ShopSnapshot {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  pickupProvince?: string | null;
  createdAt: string;
}

// ---- payloads ----
export interface InventoryReserve { reservationId: string; orderIds: string[]; items: { skuId: string; qty: number }[]; ttlSeconds: number }
export interface InventoryRef { reservationId: string; reason?: string }
export interface InventoryRestock { reservationId: string; orderId: string; items: { skuId: string; qty: number }[]; reason: 'BUYER_CANCELLED' | 'RETURNED' }
export interface InventoryReserved { reservationId: string; expiresAt: string }
export interface InventoryReserveFailed { reservationId: string; reason: string; skuIds: string[] }
export interface StockChanged { skuId: string; available: number }

export interface PaymentRequest { checkoutId: string; buyerId: string; amount: number; method: PaymentMethod; orderIds: string[]; returnUrl?: string }
export interface PaymentRefund { checkoutId: string; orderId: string; amount: number; reason: string }
export interface PaymentCreated { paymentId: string; checkoutId: string; method: PaymentMethod; redirectUrl?: string | null }
export interface PaymentSucceeded { paymentId: string; checkoutId: string; amount: number }
export interface PaymentFailed { paymentId: string; checkoutId: string; reason: string }
export interface PaymentRefunded { checkoutId: string; orderId: string; amount: number }

export type ShipmentStatus = 'CREATED' | 'PICKED' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED';
export interface ShipmentEvent { shipmentId: string; orderId: string; status: ShipmentStatus; at: string; carrier?: string; trackingCode?: string; fee?: number }

export interface UserRegistered { userId: string; email: string; fullName: string }
export interface UserOtpRequested { userId: string; email: string; purpose: 'verify_email' | 'reset_password'; code: string }
export interface UserRoleGranted { userId: string; role: Role; shopId?: string }

export interface ReviewCreated { reviewId: string; productId: string; shopId: string; userId: string; rating: number }
export interface ProductRatingChanged { productId: string; ratingAvg: number; ratingCount: number }

export const PLATFORM_COMMISSION_RATE = 0.05;
