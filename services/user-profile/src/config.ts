import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('user-profile', 8102, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/user_profile'),
  REDIS_URL: z.string().default('redis://localhost:56379'),
  REDIS_KEY_PREFIX: z.string().default('user-profile:'),
});
export type Config = typeof cfg;
