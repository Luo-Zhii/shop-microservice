import Redis from 'ioredis';
import type { Pool, PoolClient } from '@shopnow/platform';

/**
 * Giữ suất flash sale NGUYÊN TỬ bằng Lua (Redis đơn luồng → không bao giờ bán vượt quota, kể cả hàng trăm
 * request đồng thời). Idempotent theo checkoutId: gọi lại trả đúng số suất đã giữ.
 * KEYS: sold, user, hold   ARGV: qty, quota, perUserLimit (0 = không giới hạn), ttlSeconds
 */
const RESERVE_LUA = `
local h = redis.call('GET', KEYS[3])
if h then
  if h == 'R' then return {0, 'RELEASED'} end
  return {1, h}
end
local qty = tonumber(ARGV[1])
local quota = tonumber(ARGV[2])
local per = tonumber(ARGV[3])
local sold = tonumber(redis.call('GET', KEYS[1]) or '0')
if sold + qty > quota then return {0, 'SOLD_OUT'} end
if per > 0 then
  local u = tonumber(redis.call('GET', KEYS[2]) or '0')
  if u + qty > per then return {0, 'USER_LIMIT'} end
end
redis.call('INCRBY', KEYS[1], qty)
redis.call('INCRBY', KEYS[2], qty)
redis.call('SET', KEYS[3], tostring(qty), 'EX', tonumber(ARGV[4]))
return {1, tostring(qty)}
`;

/** Nhả suất (idempotent: hold đã đánh dấu 'R' thì bỏ qua). KEYS: sold, user, hold   ARGV: qty, ttlSeconds */
const RELEASE_LUA = `
if redis.call('GET', KEYS[3]) == 'R' then return 0 end
local qty = tonumber(ARGV[1])
local s = redis.call('DECRBY', KEYS[1], qty)
if s < 0 then redis.call('SET', KEYS[1], '0') end
local u = redis.call('DECRBY', KEYS[2], qty)
if u <= 0 then redis.call('DEL', KEYS[2]) end
redis.call('SET', KEYS[3], 'R', 'EX', tonumber(ARGV[2]))
return qty
`;

const HOLD_TTL_SECONDS = 30 * 86_400;

type FlashRedis = Redis & {
  fsReserve(sold: string, user: string, hold: string, qty: number, quota: number, per: number, ttl: number): Promise<[number, string]>;
  fsRelease(sold: string, user: string, hold: string, qty: number, ttl: number): Promise<number>;
};

export interface FlashItem {
  id: string;
  sku_id: string;
  sale_price: number;
  quota: number;
  per_user_limit: number | null;
}

export type ReserveResult = { ok: true; qty: number } | { ok: false; reason: 'SOLD_OUT' | 'USER_LIMIT' | 'RELEASED' };

export function createFlashStore(redis: Redis, prefix: string) {
  const r = redis as FlashRedis;
  if (!('fsReserve' in r)) {
    redis.defineCommand('fsReserve', { numberOfKeys: 3, lua: RESERVE_LUA });
    redis.defineCommand('fsRelease', { numberOfKeys: 3, lua: RELEASE_LUA });
  }
  const k = {
    sold: (itemId: string) => `${prefix}fs:${itemId}:sold`,
    user: (itemId: string, buyerId: string) => `${prefix}fs:${itemId}:u:${buyerId}`,
    hold: (itemId: string, checkoutId: string) => `${prefix}fs:${itemId}:h:${checkoutId}`,
  };

  /** Redis mất dữ liệu (restart không AOF) → dựng lại bộ đếm từ sổ Postgres trước khi bán tiếp. */
  async function ensureCounter(db: Pool | PoolClient, itemId: string) {
    if (await redis.exists(k.sold(itemId))) return;
    const { rows } = await db.query(
      `SELECT COALESCE(sum(qty), 0)::int n FROM flash_sale_holds WHERE item_id = $1 AND status IN ('LOCKED','USED')`,
      [itemId],
    );
    await redis.set(k.sold(itemId), String(rows[0].n), 'NX');
  }

  return {
    keys: k,
    ensureCounter,
    async reserve(item: FlashItem, checkoutId: string, buyerId: string, qty: number): Promise<ReserveResult> {
      const [ok, v] = await r.fsReserve(
        k.sold(item.id), k.user(item.id, buyerId), k.hold(item.id, checkoutId), qty, item.quota, item.per_user_limit ?? 0, HOLD_TTL_SECONDS,
      );
      return ok === 1 ? { ok: true, qty: Number(v) } : { ok: false, reason: v as 'SOLD_OUT' | 'USER_LIMIT' | 'RELEASED' };
    },
    async release(itemId: string, checkoutId: string, buyerId: string, qty: number) {
      return r.fsRelease(k.sold(itemId), k.user(itemId, buyerId), k.hold(itemId, checkoutId), qty, HOLD_TTL_SECONDS);
    },
    /** Số suất đã bán/giữ theo item (Redis là nguồn đếm). */
    async soldMany(itemIds: string[]): Promise<Map<string, number>> {
      if (itemIds.length === 0) return new Map();
      const vals = await redis.mget(...itemIds.map(k.sold));
      return new Map(itemIds.map((id, i) => [id, Number(vals[i] ?? 0)]));
    },
    async userCount(itemId: string, buyerId: string) {
      return Number((await redis.get(k.user(itemId, buyerId))) ?? 0);
    },
  };
}
export type FlashStore = ReturnType<typeof createFlashStore>;
