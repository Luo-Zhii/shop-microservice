import type { Redis } from 'ioredis';

export const MAX_QTY = 99;
export const MAX_LINES = 100;

export interface CartLine {
  skuId: string;
  qty: number;
  /** giá lúc thêm vào giỏ (để cảnh báo đổi giá) */
  priceAtAdd: number | null;
  addedAt: number;
}

export type CartRef = { kind: 'user'; id: string } | { kind: 'guest'; id: string };

// Thêm / đặt số lượng một dòng — nguyên tử trong Redis (không race giữa 2 tab).
// Trả: số lượng mới | -1 quá số dòng | -2 không có dòng (mode set)
const UPSERT_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then
  if ARGV[7] == 'set' then return -2 end
  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then return -1 end
  cur = 0
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[6])
end
local n
if ARGV[7] == 'set' then n = tonumber(ARGV[2]) else n = tonumber(cur) + tonumber(ARGV[2]) end
if n > tonumber(ARGV[3]) then n = tonumber(ARGV[3]) end
redis.call('HSET', KEYS[1], ARGV[1], n)
if tonumber(ARGV[5]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  redis.call('EXPIRE', KEYS[2], ARGV[5])
end
return n`;

// Gộp giỏ khách vào giỏ user: cộng dồn (chặn 99), giữ giới hạn 100 dòng, xoá giỏ khách. Trả {merged, skipped}.
const MERGE_LUA = `
local items = redis.call('HGETALL', KEYS[1])
local merged, skipped = 0, 0
for i = 1, #items, 2 do
  local sku, q = items[i], tonumber(items[i + 1])
  local cur = redis.call('HGET', KEYS[3], sku)
  if cur then
    local n = tonumber(cur) + q
    if n > tonumber(ARGV[1]) then n = tonumber(ARGV[1]) end
    redis.call('HSET', KEYS[3], sku, n)
    merged = merged + 1
  elseif redis.call('HLEN', KEYS[3]) < tonumber(ARGV[2]) then
    redis.call('HSET', KEYS[3], sku, q)
    local meta = redis.call('HGET', KEYS[2], sku)
    if meta then redis.call('HSET', KEYS[4], sku, meta) end
    merged = merged + 1
  else
    skipped = skipped + 1
  end
end
redis.call('DEL', KEYS[1], KEYS[2])
return {merged, skipped}`;

export function createCartStore(redis: Redis, prefix: string, guestTtlSeconds: number) {
  const keys = (ref: CartRef) => {
    const base = `${prefix}${ref.kind === 'user' ? 'u' : 'g'}:${ref.id}`;
    return { items: base, meta: `${base}:meta` };
  };
  const ttlOf = (ref: CartRef) => (ref.kind === 'guest' ? guestTtlSeconds : 0);

  async function list(ref: CartRef): Promise<CartLine[]> {
    const k = keys(ref);
    const [items, meta] = await Promise.all([redis.hgetall(k.items), redis.hgetall(k.meta)]);
    return Object.entries(items).map(([skuId, qty]) => {
      let m: { p?: number | null; t?: number } = {};
      try {
        m = JSON.parse(meta[skuId] ?? '{}');
      } catch {
        /* meta hỏng → bỏ qua */
      }
      return { skuId, qty: Number(qty), priceAtAdd: typeof m.p === 'number' ? m.p : null, addedAt: m.t ?? 0 };
    });
  }

  async function upsert(ref: CartRef, skuId: string, qty: number, mode: 'add' | 'set', price: number | null) {
    const k = keys(ref);
    const meta = JSON.stringify({ p: price, t: Date.now() });
    return Number(await redis.eval(UPSERT_LUA, 2, k.items, k.meta, skuId, qty, MAX_QTY, MAX_LINES, ttlOf(ref), meta, mode));
  }

  return {
    keys,
    list,
    add: (ref: CartRef, skuId: string, qty: number, price: number | null) => upsert(ref, skuId, qty, 'add', price),
    set: (ref: CartRef, skuId: string, qty: number) => upsert(ref, skuId, qty, 'set', null),
    async remove(ref: CartRef, skuIds: string[]) {
      if (skuIds.length === 0) return 0;
      const k = keys(ref);
      const [[, n]] = (await redis.multi().hdel(k.items, ...skuIds).hdel(k.meta, ...skuIds).exec()) as [[Error | null, number]];
      return Number(n);
    },
    /** Cập nhật giá tham chiếu sau khi đã báo "giá thay đổi" cho người dùng. */
    async updatePrices(ref: CartRef, lines: { skuId: string; price: number; addedAt: number }[]) {
      if (lines.length === 0) return;
      const k = keys(ref);
      const m = redis.multi();
      for (const l of lines) m.hset(k.meta, l.skuId, JSON.stringify({ p: l.price, t: l.addedAt }));
      await m.exec();
    },
    async merge(guestId: string, userId: string) {
      const g = keys({ kind: 'guest', id: guestId });
      const u = keys({ kind: 'user', id: userId });
      const [merged, skipped] = (await redis.eval(MERGE_LUA, 4, g.items, g.meta, u.items, u.meta, MAX_QTY, MAX_LINES)) as [number, number];
      return { merged: Number(merged), skipped: Number(skipped) };
    },
    /** Inbox cho consumer: true nếu event chưa từng xử lý. */
    async markEvent(eventId: string, ttlSeconds = 7 * 86_400) {
      return (await redis.set(`${prefix}evt:${eventId}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    },
    async unmarkEvent(eventId: string) {
      await redis.del(`${prefix}evt:${eventId}`);
    },
  };
}
export type CartStore = ReturnType<typeof createCartStore>;
