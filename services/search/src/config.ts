import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('search', 8105, {
  SEARCH_ENGINE: z.enum(['postgres', 'opensearch']).default('postgres'),
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/search'),
  OPENSEARCH_URL: z.string().default('http://localhost:9200'),
  OPENSEARCH_USERNAME: z.string().optional(),
  OPENSEARCH_PASSWORD: z.string().optional(),
  OPENSEARCH_INDEX_PREFIX: z.string().default('shopnow-'),
  CATALOG_URL: z.string().default('http://localhost:8104'),
});
export type Config = typeof cfg;
