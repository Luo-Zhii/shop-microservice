import { randomBytes } from 'node:crypto';
import { hash, verify as verifyHash } from '@node-rs/argon2';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  parsePage,
  requireUser,
  unauthorized,
  withTx,
  z,
  type Auth,
  type FastifyInstance,
  type FastifyRequest,
  type Pool,
  type PoolClient,
} from '@shopnow/platform';
import type { Settings } from './config';
import type { KeyStore } from './keys';
import { googleAuthUrl, type GoogleExchanger } from './google';
import { checkOtp, issueOtp, otpError, secondsSinceLastOtp, type OtpPurpose } from './otp';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp';
import {
  adminUser,
  createUser,
  emitOtp,
  findByEmail,
  findById,
  issueSession,
  publicUser,
  revokeAllSessions,
  sha256,
  type UserRow,
} from './repo';

const email = z.string().trim().toLowerCase().email('Email không hợp lệ').max(254);
const password = z
  .string()
  .min(8, 'Mật khẩu tối thiểu 8 ký tự')
  .max(128)
  .regex(/[A-Za-z]/, 'Mật khẩu phải có chữ cái')
  .regex(/\d/, 'Mật khẩu phải có chữ số');
const otpCode = z.string().regex(/^\d{6}$/, 'Mã OTP gồm 6 chữ số');
const totpCode = z.string().regex(/^\d{6}$/, 'Mã 2FA gồm 6 chữ số');

// Băm giả để thời gian phản hồi như nhau khi email không tồn tại (chống dò tài khoản)
const DUMMY_HASH = hash('dummy-password-for-timing');

export interface IdentityDeps {
  pool: Pool;
  auth: Auth;
  keys: KeyStore;
  settings: Settings;
  /** undefined → Google OAuth tắt */
  google?: GoogleExchanger;
}

export function registerRoutes(app: FastifyInstance, deps: IdentityDeps) {
  const { pool, auth, keys, settings: s } = deps;
  const authed = { preHandler: auth.authenticate };
  const admin = { preHandler: auth.requireRole('admin') };
  const sessionOpts = (req: FastifyRequest, familyId?: string) => ({
    accessTtl: s.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: s.REFRESH_TOKEN_TTL_DAYS,
    familyId,
    userAgent: req.headers['user-agent'],
  });
  const dev = (code: string | undefined) => (s.DEV_EXPOSE_OTP && code ? { devOtp: code } : {});

  async function sendOtp(c: PoolClient, u: UserRow, purpose: OtpPurpose) {
    const code = await issueOtp(c, u.id, purpose, s.OTP_TTL_SECONDS);
    await emitOtp(c, { userId: u.id, email: u.email, purpose, code });
    return code;
  }

  /** Chạy OTP trong transaction; sai mã thì COMMIT số lần thử rồi mới báo lỗi. */
  async function withOtp(u: UserRow, purpose: OtpPurpose, code: string, onOk: (c: PoolClient) => Promise<void>) {
    const r = await withTx(pool, async (c) => {
      const res = await checkOtp(c, u.id, purpose, code, s.OTP_MAX_ATTEMPTS);
      if (res === 'ok') await onOk(c);
      return res;
    });
    if (r !== 'ok') throw otpError(r, s.OTP_MAX_ATTEMPTS);
  }

  async function registerLoginFailure(userId: string) {
    const { rows } = await pool.query(
      `UPDATE users SET
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
         failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
       WHERE id = $1 RETURNING locked_until`,
      [userId, s.LOGIN_MAX_FAILED, s.LOGIN_LOCK_MINUTES],
    );
    const until: Date | null = rows[0]?.locked_until ?? null;
    if (until && until > new Date()) throw lockedError(until);
  }

  function lockedError(until: Date) {
    const mins = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
    return new AppError('RATE_LIMITED', `Tài khoản tạm khoá do đăng nhập sai nhiều lần, thử lại sau ${mins} phút`, {
      reason: 'ACCOUNT_LOCKED',
      lockedUntil: until.toISOString(),
    });
  }

  function assertActive(u: UserRow) {
    if (u.disabled) throw forbidden('Tài khoản đã bị khoá bởi quản trị viên');
  }

  /** Kiểm tra TOTP + chống dùng lại cùng một mã trong cùng chu kỳ. */
  async function consumeTotp(u: UserRow, code: string): Promise<boolean> {
    if (!u.totp_secret) return false;
    const step = verifyTotp(u.totp_secret, code);
    if (step === null || step <= u.totp_last_step) return false;
    const r = await pool.query('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2', [u.id, step]);
    return r.rowCount === 1;
  }

  // ---------------- Đăng ký / xác thực email ----------------
  app.post('/auth/register', async (req, reply) => {
    const b = z.object({ email, password, fullName: z.string().trim().min(2, 'Họ tên tối thiểu 2 ký tự').max(120) }).parse(req.body);
    const passwordHash = await hash(b.password);
    const out = await withTx(pool, async (c) => {
      if (await findByEmail(c, b.email)) throw conflict('Email đã được đăng ký');
      const u = await createUser(c, { email: b.email, passwordHash, fullName: b.fullName }).catch((e) => {
        if ((e as { code?: string }).code === '23505') throw conflict('Email đã được đăng ký');
        throw e;
      });
      return { userId: u.id, code: await sendOtp(c, u, 'verify_email') };
    });
    return reply.status(201).send({ userId: out.userId, ...dev(out.code) });
  });

  app.post('/auth/verify-email', async (req) => {
    const b = z.object({ email, code: otpCode }).parse(req.body);
    const u = await findByEmail(pool, b.email);
    if (!u) throw badRequest('Mã OTP không đúng', { reason: 'OTP_INVALID' });
    if (u.email_verified) return { ok: true, alreadyVerified: true };
    await withOtp(u, 'verify_email', b.code, async (c) => {
      await c.query('UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1', [u.id]);
    });
    return { ok: true };
  });

  /** Gửi lại OTP xác thực email (có thời gian chờ giữa 2 lần gửi). */
  app.post('/auth/resend-otp', async (req) => {
    const b = z.object({ email }).parse(req.body);
    const u = await findByEmail(pool, b.email);
    if (!u || u.email_verified || u.disabled) return { ok: true };
    const code = await withTx(pool, async (c) => {
      const since = await secondsSinceLastOtp(c, u.id, 'verify_email');
      if (since !== null && since < s.OTP_RESEND_COOLDOWN_SECONDS) {
        throw new AppError('RATE_LIMITED', `Vui lòng đợi ${Math.ceil(s.OTP_RESEND_COOLDOWN_SECONDS - since)} giây trước khi gửi lại mã`);
      }
      return sendOtp(c, u, 'verify_email');
    });
    return { ok: true, ...dev(code) };
  });

  // ---------------- Đăng nhập / refresh / đăng xuất ----------------
  app.post('/auth/login', async (req) => {
    const b = z.object({ email, password: z.string().min(1).max(128), totp: totpCode.optional() }).parse(req.body);
    const u = await findByEmail(pool, b.email);
    if (!u || !u.password_hash) {
      await verifyHash(await DUMMY_HASH, b.password).catch(() => false);
      throw unauthorized('Email hoặc mật khẩu không đúng');
    }
    assertActive(u);
    if (u.locked_until && u.locked_until > new Date()) throw lockedError(u.locked_until);
    if (!(await verifyHash(u.password_hash, b.password).catch(() => false))) {
      await registerLoginFailure(u.id);
      throw unauthorized('Email hoặc mật khẩu không đúng');
    }
    if (!u.email_verified) throw new AppError('FORBIDDEN', 'Email chưa được xác thực', { reason: 'EMAIL_NOT_VERIFIED' });
    if (u.totp_enabled) {
      if (!b.totp) throw new AppError('UNAUTHORIZED', 'Cần nhập mã xác thực 2 lớp (2FA)', { reason: 'TOTP_REQUIRED' });
      if (!(await consumeTotp(u, b.totp))) {
        await registerLoginFailure(u.id);
        throw new AppError('UNAUTHORIZED', 'Mã 2FA không đúng', { reason: 'TOTP_INVALID' });
      }
    }
    return withTx(pool, async (c) => {
      await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
      return issueSession(c, keys, u, sessionOpts(req));
    });
  });

  app.post('/auth/refresh', async (req) => {
    const b = z.object({ refreshToken: z.string().min(20).max(200) }).parse(req.body);
    const result = await withTx(pool, async (c) => {
      // Đánh dấu đã dùng một cách nguyên tử: 2 request song song chỉ một cái thắng
      const used = await c.query(
        `UPDATE refresh_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          RETURNING user_id, family_id`,
        [sha256(b.refreshToken)],
      );
      if (used.rows[0]) {
        const { user_id, family_id } = used.rows[0];
        const u = await findById(c, user_id);
        if (!u || u.disabled) {
          await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [family_id]);
          return { error: 'disabled' as const };
        }
        // roles / shopId đọc lại từ DB → vừa được duyệt shop thì token mới có role seller
        return { session: await issueSession(c, keys, u, sessionOpts(req, family_id)) };
      }
      const old = await c.query('SELECT family_id, used_at, revoked_at FROM refresh_tokens WHERE token_hash = $1', [sha256(b.refreshToken)]);
      const row = old.rows[0];
      if (row && (row.used_at || row.revoked_at)) {
        // Token đã xoay vòng bị dùng lại → nghi bị đánh cắp → thu hồi cả họ
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
        return { error: row.revoked_at && !row.used_at ? ('revoked' as const) : ('reuse' as const) };
      }
      return { error: 'invalid' as const };
    });
    if ('session' in result) return result.session;
    if (result.error === 'disabled') throw forbidden('Tài khoản đã bị khoá');
    if (result.error === 'reuse') {
      req.log.warn('phát hiện dùng lại refresh token → thu hồi cả họ token');
      throw new AppError('UNAUTHORIZED', 'Phát hiện refresh token bị dùng lại, phiên đăng nhập đã bị thu hồi', { reason: 'TOKEN_REUSED' });
    }
    throw unauthorized('Refresh token không hợp lệ hoặc đã hết hạn');
  });

  app.post('/auth/logout', async (req) => {
    const b = z.object({ refreshToken: z.string().max(200).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
    if (b.refreshToken) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
        [sha256(b.refreshToken)],
      );
    }
    if (b.all) {
      await auth.authenticate(req, undefined as never);
      await revokeAllSessions(pool, requireUser(req).id);
    }
    return { ok: true };
  });

  app.get('/auth/me', authed, async (req) => {
    const u = await findById(pool, requireUser(req).id);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    assertActive(u);
    return publicUser(u);
  });

  app.post('/auth/change-password', authed, async (req) => {
    const b = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).parse(req.body);
    const u = await findById(pool, requireUser(req).id);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    if (!u.password_hash || !(await verifyHash(u.password_hash, b.currentPassword).catch(() => false))) {
      throw badRequest('Mật khẩu hiện tại không đúng');
    }
    const h = await hash(b.newPassword);
    await withTx(pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, h]);
      await revokeAllSessions(c, u.id);
    });
    return { ok: true };
  });

  // ---------------- Quên / đặt lại mật khẩu ----------------
  app.post('/auth/forgot-password', async (req) => {
    const b = z.object({ email }).parse(req.body);
    const u = await findByEmail(pool, b.email);
    // Luôn trả ok để không lộ email nào đã đăng ký
    if (!u || u.disabled) return { ok: true };
    const code = await withTx(pool, async (c) => {
      const since = await secondsSinceLastOtp(c, u.id, 'reset_password');
      if (since !== null && since < s.OTP_RESEND_COOLDOWN_SECONDS) return undefined;
      return sendOtp(c, u, 'reset_password');
    });
    return { ok: true, ...dev(code) };
  });

  app.post('/auth/reset-password', async (req) => {
    const b = z.object({ email, code: otpCode, newPassword: password }).parse(req.body);
    const u = await findByEmail(pool, b.email);
    if (!u) throw badRequest('Mã OTP không đúng', { reason: 'OTP_INVALID' });
    const h = await hash(b.newPassword);
    await withOtp(u, 'reset_password', b.code, async (c) => {
      // Chứng minh sở hữu email → coi như đã xác thực; mở khoá đăng nhập, thu hồi mọi phiên cũ
      await c.query(
        `UPDATE users SET password_hash = $2, email_verified = true, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [u.id, h],
      );
      await revokeAllSessions(c, u.id);
    });
    return { ok: true };
  });

  // ---------------- 2FA TOTP ----------------
  app.post('/auth/2fa/setup', authed, async (req) => {
    const u = await findById(pool, requireUser(req).id);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    if (u.totp_enabled) throw conflict('2FA đã được bật');
    const secret = generateTotpSecret();
    await pool.query('UPDATE users SET totp_secret = $2, totp_last_step = 0 WHERE id = $1', [u.id, secret]);
    return { secret, otpauthUrl: otpauthUrl(secret, u.email, s.TOTP_ISSUER) };
  });

  app.post('/auth/2fa/enable', authed, async (req) => {
    const b = z.object({ code: totpCode }).parse(req.body);
    const u = await findById(pool, requireUser(req).id);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    if (u.totp_enabled) throw conflict('2FA đã được bật');
    if (!u.totp_secret) throw badRequest('Chưa khởi tạo 2FA, gọi /auth/2fa/setup trước');
    if (!(await consumeTotp(u, b.code))) throw badRequest('Mã 2FA không đúng', { reason: 'TOTP_INVALID' });
    await pool.query('UPDATE users SET totp_enabled = true, updated_at = now() WHERE id = $1', [u.id]);
    return { ok: true, totpEnabled: true };
  });

  app.post('/auth/2fa/disable', authed, async (req) => {
    const b = z.object({ code: totpCode }).parse(req.body);
    const u = await findById(pool, requireUser(req).id);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    if (!u.totp_enabled) throw conflict('2FA chưa được bật');
    if (!(await consumeTotp(u, b.code))) throw badRequest('Mã 2FA không đúng', { reason: 'TOTP_INVALID' });
    await pool.query('UPDATE users SET totp_enabled = false, totp_secret = NULL, updated_at = now() WHERE id = $1', [u.id]);
    return { ok: true, totpEnabled: false };
  });

  // ---------------- Google OAuth ----------------
  function googleOn() {
    if (!deps.google || !s.GOOGLE_CLIENT_ID) throw notFound('Đăng nhập Google chưa được bật');
    return deps.google;
  }

  app.get('/auth/google/url', async () => {
    googleOn();
    const state = randomBytes(16).toString('base64url');
    // FE lưu state (sessionStorage) và so khớp khi Google chuyển hướng về
    return { url: googleAuthUrl(s.GOOGLE_CLIENT_ID!, s.GOOGLE_REDIRECT_URI, state), state, redirectUri: s.GOOGLE_REDIRECT_URI };
  });

  app.post('/auth/google/callback', async (req) => {
    const exchange = googleOn();
    const b = z.object({ code: z.string().min(5).max(2048) }).parse(req.body);
    const g = await exchange(b.code, s.GOOGLE_REDIRECT_URI).catch((err) => {
      req.log.warn({ err }, 'đổi code Google thất bại');
      throw unauthorized('Không xác thực được với Google');
    });
    if (!g.email || !g.emailVerified) throw unauthorized('Email Google chưa được xác minh');
    return withTx(pool, async (c) => {
      let u = (await c.query<UserRow>('SELECT * FROM users WHERE google_sub = $1 FOR UPDATE', [g.sub])).rows[0];
      if (!u) {
        u = await findByEmail(c, g.email, true);
        if (u) {
          // Liên kết Google vào tài khoản sẵn có cùng email (Google đã xác minh email)
          u = (
            await c.query<UserRow>('UPDATE users SET google_sub = $2, email_verified = true, updated_at = now() WHERE id = $1 RETURNING *', [u.id, g.sub])
          ).rows[0];
        } else {
          u = await createUser(c, { email: g.email, passwordHash: null, fullName: g.name || g.email.split('@')[0], emailVerified: true, googleSub: g.sub });
        }
      }
      assertActive(u);
      await c.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
      return issueSession(c, keys, u, sessionOpts(req));
    });
  });

  // ---------------- JWKS ----------------
  app.get('/.well-known/jwks.json', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return keys.jwks();
  });

  // ---------------- Admin ----------------
  app.get('/admin/users', admin, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { page, pageSize, offset, limit } = parsePage(q);
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.q?.trim()) {
      args.push(`%${q.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(email LIKE $${args.length} OR lower(full_name) LIKE $${args.length})`);
    }
    if (q.role && ['buyer', 'seller', 'admin'].includes(q.role)) {
      args.push(q.role);
      where.push(`$${args.length} = ANY(roles)`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await pool.query(`SELECT count(*)::int n FROM users ${w}`, args)).rows[0].n;
    const { rows } = await pool.query<UserRow>(`SELECT * FROM users ${w} ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}`, args);
    return { items: rows.map(adminUser), page, pageSize, total };
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/lock', admin, async (req) => {
    if (req.params.id === requireUser(req).id) throw badRequest('Không thể tự khoá tài khoản của mình');
    await withTx(pool, async (c) => {
      const r = await c.query('UPDATE users SET disabled = true, updated_at = now() WHERE id = $1', [req.params.id]);
      if (!r.rowCount) throw notFound('Không tìm thấy tài khoản');
      await revokeAllSessions(c, req.params.id);
    });
    return { ok: true, disabled: true };
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/unlock', admin, async (req) => {
    const u = await findById(pool, req.params.id);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    await pool.query('UPDATE users SET disabled = false, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [u.id]);
    return { ok: true, disabled: false };
  });

  // ---------------- Nội bộ ----------------
  app.get<{ Params: { id: string } }>('/internal/users/:id', { preHandler: auth.internalOnly }, async (req) => {
    const u = await findById(pool, req.params.id);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    return { id: u.id, email: u.email, fullName: u.full_name, roles: u.roles };
  });
}
