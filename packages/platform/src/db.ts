import pg from 'pg';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger';

// BIGINT (tiền, số đếm) trả về number thay vì string — an toàn vì VND < 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/** max / timeout chờ kết nối đọc từ env PG_POOL_MAX, PG_CONNECT_TIMEOUT_MS (chờ quá lâu → 500, tránh dồn hàng vô hạn). */
export function createPool(url: string, max = Number(process.env.PG_POOL_MAX ?? 10), connectionTimeoutMillis = Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000)) {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis });
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Dev tiện lợi: tạo database nếu chưa có (cần quyền CREATEDB). Prod: database được tạo bằng IaC/operator. */
export async function ensureDatabase(url: string, log?: Logger) {
  const u = new URL(url);
  const db = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: u.toString() });
  try {
    await admin.connect();
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    if (r.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${db.replace(/"/g, '')}"`);
      log?.info({ db }, 'đã tạo database');
    }
  } catch (e) {
    log?.warn({ err: e, db }, 'không tự tạo được database (bỏ qua)');
  } finally {
    await admin.end().catch(() => undefined);
  }
}

const PLATFORM_SQL = `
CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_created_idx ON outbox (created_at);
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  consumer TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

/** Chạy migrations/*.sql theo thứ tự tên file, mỗi file một lần, có advisory lock khi nhiều replica khởi động cùng lúc. */
export async function migrate(pool: pg.Pool, dir: string, log?: Logger) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query(PLATFORM_SQL);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        log?.info({ migration: f }, 'migration applied');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} lỗi: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    c.release();
  }
}
