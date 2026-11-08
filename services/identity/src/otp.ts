import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError, badRequest, newId, type PoolClient } from '@shopnow/platform';

export type OtpPurpose = 'verify_email' | 'reset_password';
export type OtpResult = 'ok' | 'invalid' | 'expired' | 'too_many' | 'none';

const hashCode = (id: string, code: string) => createHash('sha256').update(`${id}:${code}`).digest('hex');

/** Sinh OTP 6 số mới (vô hiệu mã cũ cùng mục đích), chỉ lưu bản băm. Trả mã gốc để gửi email. */
export async function issueOtp(c: PoolClient, userId: string, purpose: OtpPurpose, ttlSeconds: number): Promise<string> {
  await c.query('UPDATE otp_codes SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL', [userId, purpose]);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = newId();
  await c.query(
    `INSERT INTO otp_codes (id, user_id, purpose, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))`,
    [id, userId, purpose, hashCode(id, code), ttlSeconds],
  );
  return code;
}

/** Giây kể từ lần gửi mã gần nhất (null nếu chưa từng gửi). */
export async function secondsSinceLastOtp(c: PoolClient, userId: string, purpose: OtpPurpose): Promise<number | null> {
  const { rows } = await c.query(
    `SELECT EXTRACT(EPOCH FROM now() - max(created_at))::float8 AS s FROM otp_codes WHERE user_id = $1 AND purpose = $2`,
    [userId, purpose],
  );
  return rows[0]?.s ?? null;
}

/**
 * Kiểm tra OTP trong transaction của caller. Sai → tăng số lần thử; đủ maxAttempts thì mã bị khoá.
 * Caller phải COMMIT rồi mới ném lỗi (để số lần sai được lưu lại).
 */
export async function checkOtp(c: PoolClient, userId: string, purpose: OtpPurpose, code: string, maxAttempts: number): Promise<OtpResult> {
  const { rows } = await c.query(
    `SELECT id, code_hash, attempts, expires_at < now() AS expired FROM otp_codes
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId, purpose],
  );
  const otp = rows[0];
  if (!otp) return 'none';
  if (otp.attempts >= maxAttempts) return 'too_many';
  if (otp.expired) return 'expired';
  const a = Buffer.from(hashCode(otp.id, code), 'hex');
  const b = Buffer.from(otp.code_hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await c.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    return otp.attempts + 1 >= maxAttempts ? 'too_many' : 'invalid';
  }
  await c.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);
  return 'ok';
}

export function otpError(r: Exclude<OtpResult, 'ok'>, maxAttempts: number) {
  switch (r) {
    case 'too_many':
      return new AppError('RATE_LIMITED', `Đã nhập sai mã OTP quá ${maxAttempts} lần, vui lòng yêu cầu mã mới`, { reason: 'OTP_LOCKED' });
    case 'expired':
      return badRequest('Mã OTP đã hết hạn, vui lòng yêu cầu mã mới', { reason: 'OTP_EXPIRED' });
    case 'none':
      return badRequest('Không có mã OTP còn hiệu lực, vui lòng yêu cầu mã mới', { reason: 'OTP_NOT_FOUND' });
    default:
      return badRequest('Mã OTP không đúng', { reason: 'OTP_INVALID' });
  }
}
