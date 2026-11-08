import { createHash, randomBytes } from 'node:crypto';
import { createEvent, enqueue, newId, type Pool, type PoolClient } from '@shopnow/platform';
import { Topics, type Role, type UserOtpRequested, type UserRegistered, type UserRoleGranted } from '@shopnow/contracts';
import type { KeyStore } from './keys';

type Db = Pool | PoolClient;

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  full_name: string;
  roles: Role[];
  shop_id: string | null;
  email_verified: boolean;
  google_sub: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  totp_last_step: number;
  failed_logins: number;
  locked_until: Date | null;
  disabled: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

/** shopId chỉ có nghĩa khi user đang giữ role seller. */
export const effectiveShopId = (u: Pick<UserRow, 'roles' | 'shop_id'>) => (u.roles.includes('seller') ? u.shop_id : null);

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    roles: u.roles,
    shopId: effectiveShopId(u),
    emailVerified: u.email_verified,
    totpEnabled: u.totp_enabled,
    createdAt: u.created_at.toISOString(),
  };
}

export function adminUser(u: UserRow) {
  return {
    ...publicUser(u),
    disabled: u.disabled,
    lockedUntil: u.locked_until && u.locked_until > new Date() ? u.locked_until.toISOString() : null,
    hasPassword: Boolean(u.password_hash),
    googleLinked: Boolean(u.google_sub),
    lastLoginAt: u.last_login_at?.toISOString() ?? null,
  };
}

export async function findByEmail(db: Db, email: string, forUpdate = false) {
  const { rows } = await db.query<UserRow>(`SELECT * FROM users WHERE email = $1${forUpdate ? ' FOR UPDATE' : ''}`, [email]);
  return rows[0];
}

export async function findById(db: Db, id: string, forUpdate = false) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const { rows } = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0];
}

// ---------- sự kiện identity.user.v1 ----------
export const emitRegistered = (c: PoolClient, d: UserRegistered) =>
  enqueue(c, Topics.identityUser, createEvent('user.registered', 'identity', d.userId, d));
export const emitOtp = (c: PoolClient, d: UserOtpRequested) =>
  enqueue(c, Topics.identityUser, createEvent('user.otp_requested', 'identity', d.userId, d));
export const emitRoleGranted = (c: PoolClient, d: UserRoleGranted) =>
  enqueue(c, Topics.identityUser, createEvent('user.role_granted', 'identity', d.userId, d));

export async function createUser(
  c: PoolClient,
  u: { email: string; passwordHash: string | null; fullName: string; roles?: Role[]; emailVerified?: boolean; googleSub?: string | null },
) {
  const id = newId();
  const { rows } = await c.query<UserRow>(
    `INSERT INTO users (id, email, password_hash, full_name, roles, email_verified, google_sub)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, u.email, u.passwordHash, u.fullName, u.roles ?? ['buyer'], u.emailVerified ?? false, u.googleSub ?? null],
  );
  await emitRegistered(c, { userId: id, email: u.email, fullName: u.fullName });
  return rows[0];
}

// ---------- phiên đăng nhập (access + refresh) ----------
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function issueSession(
  c: PoolClient,
  keys: KeyStore,
  u: UserRow,
  opts: { accessTtl: number; refreshTtlDays: number; familyId?: string; userAgent?: string },
) {
  const refreshToken = randomBytes(32).toString('base64url');
  await c.query(
    `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, user_agent)
     VALUES ($1,$2,$3,$4, now() + make_interval(days => $5), $6)`,
    [newId(), u.id, opts.familyId ?? newId(), sha256(refreshToken), opts.refreshTtlDays, opts.userAgent?.slice(0, 300) ?? null],
  );
  const accessToken = await keys.signAccess({ sub: u.id, email: u.email, roles: u.roles, shopId: effectiveShopId(u) }, opts.accessTtl);
  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: opts.accessTtl, user: publicUser(u) };
}

export async function revokeAllSessions(db: Db, userId: string) {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}
