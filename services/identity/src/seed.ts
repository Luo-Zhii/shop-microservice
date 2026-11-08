import { hash } from '@node-rs/argon2';
import { withTx, type Logger, type Pool } from '@shopnow/platform';
import { createUser, findByEmail } from './repo';

/** Tạo tài khoản admin mặc định nếu chưa có (không ghi đè mật khẩu đã đổi). */
export async function seedAdmin(pool: Pool, email: string, password: string, log?: Logger) {
  const normalized = email.trim().toLowerCase();
  await withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727276)');
    const existing = await findByEmail(c, normalized, true);
    if (existing) {
      if (!existing.roles.includes('admin')) {
        await c.query(`UPDATE users SET roles = array_append(roles, 'admin'), updated_at = now() WHERE id = $1`, [existing.id]);
      }
      return;
    }
    await createUser(c, { email: normalized, passwordHash: await hash(password), fullName: 'Quản trị viên', roles: ['admin'], emailVerified: true });
    log?.info({ email: normalized }, 'đã tạo tài khoản admin mặc định');
  });
}
