import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Mã hoá trường nhạy cảm (số CCCD, số tài khoản) bằng AES-256-GCM: "v1:iv:tag:ciphertext" (base64). */
export function createSealer(secret: string) {
  const key = createHash('sha256').update(secret).digest();
  return {
    seal(plain: string) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    },
    open(sealed: string) {
      const [v, iv, tag, ct] = sealed.split(':');
      if (v !== 'v1') throw new Error('Định dạng dữ liệu mã hoá không hỗ trợ');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}
export type Sealer = ReturnType<typeof createSealer>;

export const mask = (last4: string) => `****${last4}`;
export const last4 = (s: string) => s.slice(-4);
