// TOTP (RFC 6238) / HOTP (RFC 4226) tự viết bằng node:crypto — HMAC-SHA1, 6 chữ số, chu kỳ 30 giây.
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Chuỗi base32 không hợp lệ');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const TOTP_PERIOD = 30;

export function totpStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

export function totp(secretBase32: string, nowMs = Date.now(), digits = 6): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs), digits);
}

/** Trả về bước thời gian khớp (cho phép lệch ±window bước) hoặc null. */
export function verifyTotp(secretBase32: string, code: string, opts: { window?: number; nowMs?: number } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretBase32);
  const step = totpStep(opts.nowMs);
  const w = opts.window ?? 1;
  for (let d = -w; d <= w; d++) {
    if (hotp(key, step + d) === code) return step + d;
  }
  return null;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUrl(secret: string, account: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
