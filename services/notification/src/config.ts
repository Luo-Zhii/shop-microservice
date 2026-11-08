import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('notification', 8113, {
  MONGO_URL: z.string().default('mongodb://localhost:57017'),
  MONGO_DB: z.string().default('notification'),
  REDIS_URL: z.string().default('redis://localhost:56379'),
  /** kênh Redis pub/sub để fan-out SSE giữa các replica */
  NOTIFY_CHANNEL: z.string().default('notification:events'),
  SMTP_URL: z.string().default('smtp://localhost:51025'),
  MAIL_FROM: z.string().default('ShopNow <no-reply@shopnow.local>'),
  WEB_URL: z.string().default('http://localhost:3000'),
  IDENTITY_URL: z.string().default('http://localhost:8101'),
  SELLER_URL: z.string().default('http://localhost:8103'),
});
export type Config = typeof cfg;
