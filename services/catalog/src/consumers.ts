import { processOnce, type EventBus, type Pool } from '@shopnow/platform';
import { Topics, type OrderSnapshot, type ProductRatingChanged, type ShopSnapshot } from '@shopnow/contracts';
import { refreshAndEmit } from './repo';

export async function registerConsumers(bus: EventBus, pool: Pool) {
  await bus.subscribe('catalog', [Topics.sellerShop, Topics.review, Topics.order], async (event) => {
    switch (event.type) {
      case 'shop.submitted':
      case 'shop.approved':
      case 'shop.rejected':
      case 'shop.suspended': {
        const shop = event.data as ShopSnapshot;
        await processOnce(pool, 'catalog', event.id, async (c) => {
          await c.query(
            `INSERT INTO shops_cache (shop_id, name, status, updated_at) VALUES ($1,$2,$3,now())
             ON CONFLICT (shop_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()`,
            [shop.id, shop.name, shop.status],
          );
          const { rows } = await c.query('UPDATE products SET shop_name = $2 WHERE shop_id = $1 RETURNING id', [shop.id, shop.name]);
          // Shop bị khoá / mở lại → phát lại snapshot để search ẩn / hiện sản phẩm
          if (event.type === 'shop.suspended' || event.type === 'shop.approved') for (const r of rows) await refreshAndEmit(c, r.id);
        });
        break;
      }
      case 'product.rating_changed': {
        const d = event.data as ProductRatingChanged;
        await processOnce(pool, 'catalog', event.id, async (c) => {
          const r = await c.query('UPDATE products SET rating_avg = $2, rating_count = $3 WHERE id = $1', [d.productId, d.ratingAvg, d.ratingCount]);
          if (r.rowCount) await refreshAndEmit(c, d.productId);
        });
        break;
      }
      case 'order.completed': {
        const o = event.data as OrderSnapshot;
        await processOnce(pool, 'catalog', event.id, async (c) => {
          const qty = new Map<string, number>();
          for (const it of o.items) qty.set(it.productId, (qty.get(it.productId) ?? 0) + it.qty);
          for (const [productId, n] of qty) {
            const r = await c.query('UPDATE products SET sold_count = sold_count + $2 WHERE id = $1', [productId, n]);
            if (r.rowCount) await refreshAndEmit(c, productId);
          }
        });
        break;
      }
      default:
    }
  });
}
