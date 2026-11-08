import { processOnce, type EventBus, type Pool } from '@shopnow/platform';
import { Topics, type EventEnvelope, type UserRegistered } from '@shopnow/contracts';

/** identity.user.v1 user.registered → tạo hồ sơ (giữ tên người dùng đã tự sửa nếu hồ sơ có trước). */
export async function handleUserEvent(pool: Pool, event: EventEnvelope<unknown>) {
  if (event.type !== 'user.registered') return;
  const d = event.data as UserRegistered;
  await processOnce(pool, 'user-profile', event.id, async (c) => {
    await c.query(
      `INSERT INTO profiles (user_id, email, full_name) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email,
         full_name = CASE WHEN profiles.full_name = '' THEN EXCLUDED.full_name ELSE profiles.full_name END,
         updated_at = now()`,
      [d.userId, d.email ?? '', d.fullName ?? ''],
    );
  });
}

export async function registerConsumers(bus: EventBus, pool: Pool) {
  await bus.subscribe('user-profile', [Topics.identityUser], (event) => handleUserEvent(pool, event));
}
