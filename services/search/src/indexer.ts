import type { EventBus, Logger } from '@shopnow/platform';
import { Topics, type EventEnvelope, type ProductRatingChanged, type ProductSnapshot, type StockChanged } from '@shopnow/contracts';
import type { CategoryPort } from './categories';
import type { SearchDoc, SearchEngine } from './types';

export interface IndexerDeps {
  engine: SearchEngine;
  categories: CategoryPort;
  log: Logger;
}

/** Chỉ sản phẩm APPROVED, có biến thể đang bán (và shop không bị khoá, nếu snapshot có cờ) mới được index. */
export function isSearchable(p: ProductSnapshot & { shopStatus?: string }) {
  return p.status === 'APPROVED' && (!p.shopStatus || p.shopStatus === 'APPROVED') && p.variants.some((v) => v.status === 'ACTIVE');
}

export async function toSearchDoc(p: ProductSnapshot, categories: CategoryPort, log: Logger): Promise<SearchDoc> {
  let chain: { ids: string[]; names: string[] } | null = null;
  try {
    chain = await categories.chain(p.categoryId);
  } catch (err) {
    log.warn({ err, categoryId: p.categoryId }, 'không đọc được cây danh mục — chỉ lọc được theo danh mục lá');
  }
  if (!chain) chain = { ids: [p.categoryId], names: [p.categoryPath.at(-1) ?? ''] };
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    brand: p.brand ?? null,
    shopId: p.shopId,
    shopName: p.shopName,
    categoryId: p.categoryId,
    categoryIds: chain.ids,
    categoryNames: chain.names,
    image: p.images[0] ?? null,
    minPrice: p.minPrice,
    maxPrice: p.maxPrice,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    soldCount: p.soldCount,
    skuIds: p.variants.filter((v) => v.status === 'ACTIVE').map((v) => v.id),
    attributesText: [...Object.values(p.attributes ?? {}), ...p.variants.flatMap((v) => Object.values(v.options ?? {}))].join(' '),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Handler idempotent theo thiết kế (upsert theo updatedAt, xoá, ghi tồn tuyệt đối) nên không cần bảng inbox:
 * xử lý lặp một sự kiện cho cùng kết quả.
 */
export async function handleEvent(deps: IndexerDeps, event: EventEnvelope<any>) {
  switch (event.type) {
    case 'product.upserted': {
      const p = event.data as ProductSnapshot;
      if (isSearchable(p)) await deps.engine.upsert(await toSearchDoc(p, deps.categories, deps.log));
      else await deps.engine.remove(p.id);
      return true;
    }
    case 'product.deleted':
      await deps.engine.remove((event.data as { productId: string }).productId);
      return true;
    case 'stock.changed': {
      const s = event.data as StockChanged;
      await deps.engine.setStock(s.skuId, Number(s.available));
      return true;
    }
    case 'product.rating_changed': {
      const r = event.data as ProductRatingChanged;
      await deps.engine.setRating(r.productId, r.ratingAvg, r.ratingCount);
      return true;
    }
    default:
      return false;
  }
}

export const CONSUMED_TOPICS = [Topics.catalogProduct, Topics.inventoryEvent, Topics.review];

export async function registerConsumers(bus: EventBus, deps: IndexerDeps) {
  await bus.subscribe('search', CONSUMED_TOPICS, async (event) => {
    await handleEvent(deps, event);
  });
}
