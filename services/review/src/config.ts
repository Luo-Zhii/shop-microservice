import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('review', 8112, {
  MONGO_URL: z.string().default('mongodb://localhost:57017'),
  MONGO_DB: z.string().default('review'),
  AI_URL: z.string().default('http://localhost:8114'),
  AI_MODERATION_TIMEOUT_MS: z.coerce.number().int().min(100).default(1_500),
});
export type Config = typeof cfg;
