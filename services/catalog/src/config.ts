import { loadConfig, z } from '@shopnow/platform';

export const cfg = loadConfig('catalog', 8104, {
  DATABASE_URL: z.string().default('postgres://shopnow:shopnow@localhost:55432/catalog'),
  S3_ENDPOINT: z.string().default('http://localhost:59000'),
  S3_REGION: z.string().default('ap-southeast-1'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('shopnow-media'),
  /** URL công khai của bucket (CloudFront trên AWS, MinIO trực tiếp ở dev). */
  MEDIA_PUBLIC_URL: z.string().default('http://localhost:59000/shopnow-media'),
  SEED_DEMO: z.string().default('true'),
});
export type Config = typeof cfg;
