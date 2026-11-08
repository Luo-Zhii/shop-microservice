import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../src/totp';

test('base32 mã hoá/giải mã khứ hồi', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
  const raw = Buffer.from([0, 255, 1, 2, 3, 250, 7]);
  assert.deepEqual(base32Decode(base32Encode(raw)), raw);
});

test('HOTP/TOTP khớp vector RFC 4226 / RFC 6238 (SHA1)', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(hotp(key, 0), '755224');
  assert.equal(hotp(key, 9), '520489');
  const secret = base32Encode(key);
  assert.equal(totp(secret, 59_000, 8), '94287082');
  assert.equal(totp(secret, 1_111_111_109_000, 8), '07081804');
  assert.equal(verifyTotp(secret, totp(secret, 1_234_567_890_000), { nowMs: 1_234_567_890_000 + 30_000 }), Math.floor(1_234_567_890 / 30));
  assert.equal(verifyTotp(secret, totp(secret, 1_234_567_890_000), { nowMs: 1_234_567_890_000 + 120_000 }), null);
});
