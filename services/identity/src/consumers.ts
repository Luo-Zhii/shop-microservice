import { processOnce, type EventBus, type Pool } from '@shopnow/platform';
import { Topics, type EventEnvelope, type ShopSnapshot } from '@shopnow/contracts';
import { emitRoleGranted } from './repo';

/** seller.shop.v1: duyệt shop → cấp role seller + shopId cho chủ shop; khoá shop → thu role seller. */
export async function handleShopEvent(pool: Pool, event: EventEnvelope<ShopSnapshot>) {
  if (event.type !== 'shop.approved' && event.type !== 'shop.suspended') return;
  const shop = event.data;
  await processOnce(pool, 'identity', event.id, async (c) => {
    const { rows } = await c.query<{ roles: string[] }>('SELECT roles FROM users WHERE id = $1 FOR UPDATE', [shop.ownerId]);
    if (!rows[0]) return;
    if (event.type === 'shop.approved') {
      const had = rows[0].roles.includes('seller');
      await c.query(
        `UPDATE users SET roles = CASE WHEN 'seller' = ANY(roles) THEN roles ELSE array_append(roles, 'seller') END,
                shop_id = $2, updated_at = now() WHERE id = $1`,
        [shop.ownerId, shop.id],
      );
      if (!had) await emitRoleGranted(c, { userId: shop.ownerId, role: 'seller', shopId: shop.id });
    } else {
      // Giữ shop_id để mở khoá lại; token chỉ mang shopId khi còn role seller
      await c.query(`UPDATE users SET roles = array_remove(roles, 'seller'), updated_at = now() WHERE id = $1`, [shop.ownerId]);
    }
  });
}

export async function registerConsumers(bus: EventBus, pool: Pool) {
  await bus.subscribe('identity', [Topics.sellerShop], (event) => handleShopEvent(pool, event));
}
