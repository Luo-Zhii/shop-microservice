import type { EventBus, Logger } from '@shopnow/platform';
import {
  Topics,
  type EventEnvelope,
  type OrderSnapshot,
  type PaymentFailed,
  type PaymentRefunded,
  type PaymentSucceeded,
  type ShipmentEvent,
  type ShopSnapshot,
  type UserOtpRequested,
  type UserRegistered,
} from '@shopnow/contracts';
import type { ShopOwners, UserPort } from './clients';
import type { InApp, Notifier } from './notifier';
import { alreadyProcessed, markProcessed, type Collections } from './store';
import { cancelReasonText, orderCancelledEmail, orderCode, orderPlacedEmail, otpEmail, vnd, welcomeEmail } from './templates';

export interface ConsumerDeps {
  col: Collections;
  notifier: Notifier;
  users: UserPort;
  shops: ShopOwners;
  webUrl: string;
  log: Logger;
}

const CONSUMER = 'notification';
const CARRIER_NAME: Record<string, string> = { GHN: 'Giao Hàng Nhanh', GHTK: 'Giao Hàng Tiết Kiệm', SPX: 'SPX Express' };

/** Thông báo cho buyer theo từng trạng thái đơn. */
function buyerOrderMessage(type: string, o: OrderSnapshot): InApp | null {
  const code = orderCode(o.id);
  const link = `/orders/${o.id}`;
  const data = { orderId: o.id, shopId: o.shopId, status: o.status };
  switch (type) {
    case 'order.created':
      return { type, title: 'Đặt hàng thành công', body: `Đơn hàng ${code} (${vnd(o.total)}) đã được ghi nhận.`, link, data };
    case 'order.confirmed':
      return { type, title: 'Đơn hàng đã được xác nhận', body: `Đơn hàng ${code} đã được xác nhận và đang được người bán chuẩn bị.`, link, data };
    case 'order.shipped':
      return { type, title: 'Đơn hàng đang được giao', body: `Đơn hàng ${code} đang trên đường giao đến bạn.`, link, data };
    case 'order.delivered':
      return { type, title: 'Giao hàng thành công', body: `Đơn hàng ${code} đã được giao. Hãy bấm "Đã nhận hàng" nếu bạn hài lòng.`, link, data };
    case 'order.cancelled':
      return { type, title: 'Đơn hàng đã bị huỷ', body: `Đơn hàng ${code} đã bị huỷ. Lý do: ${cancelReasonText(o.reason)}.`, link, data: { ...data, reason: o.reason ?? null } };
    case 'order.completed':
      return { type, title: 'Đơn hàng hoàn tất – đánh giá ngay', body: `Đơn hàng ${code} đã hoàn tất. Chia sẻ cảm nhận để giúp người mua khác nhé!`, link: `${link}?review=1`, data };
    case 'order.return_requested':
      return { type, title: 'Đã gửi yêu cầu trả hàng', body: `Yêu cầu trả hàng cho đơn ${code} đang chờ xử lý.`, link, data };
    case 'order.returned':
      return { type, title: 'Trả hàng thành công', body: `Yêu cầu trả hàng cho đơn ${code} đã được chấp nhận. Tiền sẽ được hoàn lại cho bạn.`, link, data };
    default:
      return null;
  }
}

function sellerOrderMessage(type: string, o: OrderSnapshot): InApp | null {
  const code = orderCode(o.id);
  const link = `/seller/orders/${o.id}`;
  const data = { orderId: o.id, shopId: o.shopId };
  if (type === 'order.created') return { type: 'seller.order_created', title: 'Bạn có đơn hàng mới', body: `Đơn ${code}: ${o.items.length} sản phẩm, tổng ${vnd(o.total)}.`, link, data };
  if (type === 'order.cancelled') return { type: 'seller.order_cancelled', title: 'Đơn hàng bị huỷ', body: `Đơn ${code} đã bị huỷ. Lý do: ${cancelReasonText(o.reason)}.`, link, data };
  if (type === 'order.return_requested') return { type: 'seller.return_requested', title: 'Yêu cầu trả hàng', body: `Người mua yêu cầu trả hàng cho đơn ${code}.`, link, data };
  return null;
}

async function buyerEmail(deps: ConsumerDeps, buyerId: string) {
  try {
    return (await deps.users.getUser(buyerId))?.email ?? null;
  } catch (err) {
    deps.log.warn({ err, buyerId }, 'không lấy được email buyer từ identity — bỏ qua email');
    deps.notifier.skipEmail('no_recipient');
    return null;
  }
}

async function onOrder(deps: ConsumerDeps, e: EventEnvelope<OrderSnapshot>) {
  const o = e.data;
  await deps.col.orders.updateOne({ _id: o.id }, { $set: { buyerId: o.buyerId, shopId: o.shopId, checkoutId: o.checkoutId, total: o.total } }, { upsert: true });
  await deps.col.checkouts.updateOne({ _id: o.checkoutId }, { $set: { buyerId: o.buyerId }, $addToSet: { orderIds: o.id } }, { upsert: true });

  const b = buyerOrderMessage(e.type, o);
  if (b) await deps.notifier.inApp(o.buyerId, `${e.id}:${o.buyerId}:buyer`, b);
  const s = sellerOrderMessage(e.type, o);
  if (s) {
    const ownerId = await deps.shops.getOwnerId(o.shopId).catch((err) => {
      deps.log.warn({ err, shopId: o.shopId }, 'không tìm được chủ shop');
      return null;
    });
    if (ownerId) await deps.notifier.inApp(ownerId, `${e.id}:${ownerId}:seller`, s);
  }
  if (e.type === 'order.created' || e.type === 'order.cancelled') {
    const to = await buyerEmail(deps, o.buyerId);
    if (to) {
      const mail = e.type === 'order.created' ? orderPlacedEmail(o, deps.webUrl) : orderCancelledEmail(o, deps.webUrl);
      await deps.notifier.email(to, `${e.id}:email`, e.type, mail);
    }
  }
}

async function onPayment(deps: ConsumerDeps, e: EventEnvelope<PaymentSucceeded | PaymentFailed | PaymentRefunded>) {
  const d = e.data;
  const refunded = e.type === 'payment.refunded' ? (d as PaymentRefunded) : null;
  const buyerId = refunded
    ? ((await deps.col.orders.findOne({ _id: refunded.orderId }))?.buyerId ?? (await deps.col.checkouts.findOne({ _id: d.checkoutId }))?.buyerId)
    : (await deps.col.checkouts.findOne({ _id: d.checkoutId }))?.buyerId;
  if (!buyerId) {
    deps.log.warn({ type: e.type, checkoutId: d.checkoutId }, 'chưa biết buyer của checkout — bỏ qua thông báo thanh toán');
    return;
  }
  let n: InApp | null = null;
  const data = { checkoutId: d.checkoutId };
  if (e.type === 'payment.succeeded') {
    n = { type: e.type, title: 'Thanh toán thành công', body: `Bạn đã thanh toán thành công ${vnd((d as PaymentSucceeded).amount)}.`, link: '/orders', data };
  } else if (e.type === 'payment.failed') {
    n = { type: e.type, title: 'Thanh toán thất bại', body: `Thanh toán chưa thành công${(d as PaymentFailed).reason ? ` (${(d as PaymentFailed).reason})` : ''}. Đơn hàng sẽ bị huỷ nếu không thanh toán lại.`, link: '/orders', data };
  } else if (refunded) {
    n = { type: e.type, title: 'Hoàn tiền thành công', body: `Đã hoàn ${vnd(refunded.amount)} cho đơn ${orderCode(refunded.orderId)}.`, link: `/orders/${refunded.orderId}`, data: { ...data, orderId: refunded.orderId } };
  }
  if (n) await deps.notifier.inApp(buyerId, `${e.id}:${buyerId}:buyer`, n);
}

async function onShipment(deps: ConsumerDeps, e: EventEnvelope<ShipmentEvent>) {
  if (e.type !== 'shipment.created') return; // các trạng thái giao hàng còn lại đã có order.shipped / order.delivered
  const s = e.data;
  const ref = await deps.col.orders.findOne({ _id: s.orderId });
  if (!ref) {
    deps.log.warn({ orderId: s.orderId }, 'chưa biết buyer của đơn — bỏ qua thông báo vận đơn');
    return;
  }
  await deps.notifier.inApp(ref.buyerId, `${e.id}:${ref.buyerId}:buyer`, {
    type: e.type,
    title: 'Đơn hàng đã có mã vận đơn',
    body: `Đơn ${orderCode(s.orderId)} được giao bởi ${CARRIER_NAME[s.carrier ?? ''] ?? s.carrier}. Mã vận đơn: ${s.trackingCode}.`,
    link: `/orders/${s.orderId}`,
    data: { orderId: s.orderId, shipmentId: s.shipmentId, carrier: s.carrier, trackingCode: s.trackingCode },
  });
}

async function onShop(deps: ConsumerDeps, e: EventEnvelope<ShopSnapshot & { reason?: string; rejectReason?: string }>) {
  const shop = e.data;
  if (!shop.ownerId) return;
  deps.shops.set(shop.id, shop.ownerId);
  const reason = shop.rejectReason ?? shop.reason;
  const msg: Record<string, InApp> = {
    'shop.submitted': { type: e.type, title: 'Đã gửi hồ sơ mở shop', body: `Hồ sơ shop "${shop.name}" đang chờ duyệt.`, link: '/seller' },
    'shop.approved': { type: e.type, title: 'Shop đã được duyệt', body: `Chúc mừng! Shop "${shop.name}" đã được duyệt. Bạn có thể bắt đầu đăng bán sản phẩm.`, link: '/seller' },
    'shop.rejected': { type: e.type, title: 'Hồ sơ shop bị từ chối', body: `Hồ sơ shop "${shop.name}" chưa được duyệt${reason ? `. Lý do: ${reason}` : ''}. Vui lòng cập nhật và gửi lại.`, link: '/seller' },
    'shop.suspended': { type: e.type, title: 'Shop bị tạm khoá', body: `Shop "${shop.name}" đã bị tạm khoá, sản phẩm tạm ẩn khỏi sàn. Liên hệ hỗ trợ để biết thêm chi tiết.`, link: '/seller' },
  };
  const n = msg[e.type];
  if (n) await deps.notifier.inApp(shop.ownerId, `${e.id}:${shop.ownerId}:owner`, { ...n, data: { shopId: shop.id, ...(reason ? { reason } : {}) } });
}

async function onUser(deps: ConsumerDeps, e: EventEnvelope<UserOtpRequested | UserRegistered>) {
  if (e.type === 'user.otp_requested') {
    const d = e.data as UserOtpRequested;
    await deps.notifier.email(d.email, `${e.id}:email`, e.type, otpEmail(d.purpose, d.code));
  } else if (e.type === 'user.registered') {
    const d = e.data as UserRegistered;
    await deps.notifier.inApp(d.userId, `${e.id}:${d.userId}:welcome`, {
      type: e.type, title: 'Chào mừng đến với ShopNow', body: `Xin chào ${d.fullName || 'bạn'}! Khám phá ưu đãi dành cho thành viên mới ngay hôm nay.`, link: '/',
    });
    await deps.notifier.email(d.email, `${e.id}:email`, e.type, welcomeEmail(d.fullName, deps.webUrl));
  }
}

/** Định tuyến sự kiện theo topic. Inbox: bỏ qua event đã xử lý; đánh dấu sau khi xử lý xong (các bước bên trong tự chống trùng). */
export async function handleEvent(deps: ConsumerDeps, topic: string, event: EventEnvelope<any>) {
  if (await alreadyProcessed(deps.col, CONSUMER, event.id)) return false;
  switch (topic) {
    case Topics.identityUser:
      await onUser(deps, event);
      break;
    case Topics.sellerShop:
      await onShop(deps, event);
      break;
    case Topics.order:
      await onOrder(deps, event);
      break;
    case Topics.paymentEvent:
      await onPayment(deps, event);
      break;
    case Topics.shipping:
      await onShipment(deps, event);
      break;
    default:
      return false;
  }
  await markProcessed(deps.col, CONSUMER, event.id);
  return true;
}

export const CONSUMED_TOPICS = [Topics.identityUser, Topics.sellerShop, Topics.order, Topics.paymentEvent, Topics.shipping];

export async function registerConsumers(bus: EventBus, deps: ConsumerDeps) {
  await bus.subscribe('notification', CONSUMED_TOPICS, async (event, meta) => {
    await handleEvent(deps, meta.topic, event);
  });
}
