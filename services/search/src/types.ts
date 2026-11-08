import { foldVietnamese } from '@shopnow/platform';

export interface SearchDoc {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  shopId: string;
  shopName: string;
  categoryId: string;
  /** chuỗi danh mục từ gốc → lá (song song với categoryNames) để lọc danh mục con + đếm facet */
  categoryIds: string[];
  categoryNames: string[];
  image: string | null;
  minPrice: number;
  maxPrice: number;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  skuIds: string[];
  attributesText: string;
  createdAt: string;
  updatedAt: string;
}

export const SORTS = ['relevance', 'price_asc', 'price_desc', 'newest', 'best_selling'] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchQuery {
  q?: string;
  categoryId?: string;
  shopId?: string;
  minPrice?: number;
  maxPrice?: number;
  rating?: number;
  inStock?: boolean;
  sort: Sort;
  page: number;
  pageSize: number;
}

export interface SearchItem {
  id: string;
  slug: string;
  title: string;
  image: string | null;
  shopId: string;
  shopName: string;
  categoryId: string;
  minPrice: number;
  maxPrice: number;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  inStock: boolean;
}

export interface PriceRangeFacet {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
  count: number;
}

export interface SearchResult {
  items: SearchItem[];
  total: number;
  facets: { categories: { id: string; name: string; count: number }[]; priceRanges: PriceRangeFacet[] };
}

export interface SearchEngine {
  readonly name: 'postgres' | 'opensearch';
  init(): Promise<void>;
  ping(): Promise<unknown>;
  upsert(doc: SearchDoc): Promise<void>;
  remove(productId: string): Promise<void>;
  setRating(productId: string, ratingAvg: number, ratingCount: number): Promise<void>;
  setStock(skuId: string, available: number): Promise<void>;
  search(q: SearchQuery): Promise<SearchResult>;
  suggest(prefix: string, limit: number): Promise<string[]>;
  recordQuery(q: string): Promise<void>;
  close(): Promise<void>;
}

/** Khoảng giá cố định cho facet: [min, max) — max null = không giới hạn. */
export const PRICE_RANGES: Omit<PriceRangeFacet, 'count'>[] = [
  { key: '0-100000', label: 'Dưới 100.000đ', min: null, max: 100_000 },
  { key: '100000-200000', label: '100.000đ – 200.000đ', min: 100_000, max: 200_000 },
  { key: '200000-500000', label: '200.000đ – 500.000đ', min: 200_000, max: 500_000 },
  { key: '500000-1000000', label: '500.000đ – 1.000.000đ', min: 500_000, max: 1_000_000 },
  { key: '1000000-5000000', label: '1.000.000đ – 5.000.000đ', min: 1_000_000, max: 5_000_000 },
  { key: '5000000-', label: 'Trên 5.000.000đ', min: 5_000_000, max: null },
];

/** Chuẩn hoá để so khớp: bỏ dấu, chữ thường, gộp khoảng trắng. */
export function fold(s: string) {
  return foldVietnamese(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
