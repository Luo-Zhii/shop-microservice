import { Client } from 'minio';
import { newId, type Logger } from '@shopnow/platform';
import type { Config } from './config';

/** Ảnh sản phẩm: client upload thẳng lên MinIO/S3 bằng presigned PUT, service chỉ ký URL. */
export function createStorage(cfg: Config, log: Logger) {
  const u = new URL(cfg.S3_ENDPOINT);
  const client = new Client({
    endPoint: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
    useSSL: u.protocol === 'https:',
    accessKey: cfg.S3_ACCESS_KEY,
    secretKey: cfg.S3_SECRET_KEY,
    region: cfg.S3_REGION,
  });

  async function ensureBucket() {
    try {
      if (!(await client.bucketExists(cfg.S3_BUCKET))) await client.makeBucket(cfg.S3_BUCKET, cfg.S3_REGION);
      const policy = {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${cfg.S3_BUCKET}/*`] }],
      };
      await client.setBucketPolicy(cfg.S3_BUCKET, JSON.stringify(policy));
    } catch (err) {
      log.warn({ err }, 'không chuẩn bị được bucket media (bỏ qua — trên AWS bucket do Terraform tạo)');
    }
  }

  async function presignUpload(shopId: string, contentType: string) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType] ?? 'bin';
    const key = `products/${shopId}/${newId()}.${ext}`;
    const uploadUrl = await client.presignedPutObject(cfg.S3_BUCKET, key, 10 * 60);
    return { uploadUrl, publicUrl: `${cfg.MEDIA_PUBLIC_URL.replace(/\/$/, '')}/${key}`, key };
  }

  return { ensureBucket, presignUpload };
}
