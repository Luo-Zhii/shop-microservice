// Package db: pool pgx, tự tạo database (dev), migration nhúng (go:embed) có advisory lock.
package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Cùng khoá với bản Node (advisory lock theo từng database).
const migrateLockKey = 727274

// Bảng outbox / processed_events giống hệt packages/platform/src/db.ts.
const platformSQL = `
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
);
CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`

// Connect tạo pool (đã ping). maxConns <= 0 → mặc định pgx.
func Connect(ctx context.Context, dsn string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL không hợp lệ: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	cfg.MaxConnIdleTime = 30 * time.Second
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// EnsureDatabase (dev): tạo database trong DSN nếu chưa có. Prod: database do IaC tạo → lỗi chỉ cảnh báo.
func EnsureDatabase(ctx context.Context, dsn string, log *slog.Logger) {
	u, err := url.Parse(dsn)
	if err != nil {
		return
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" {
		return
	}
	u.Path = "/postgres"
	conn, err := pgx.Connect(ctx, u.String())
	if err != nil {
		log.Warn("không tự tạo được database (bỏ qua)", "db", name, "err", err)
		return
	}
	defer conn.Close(context.Background())
	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists); err != nil {
		log.Warn("không kiểm tra được database", "db", name, "err", err)
		return
	}
	if exists {
		return
	}
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		log.Warn("không tự tạo được database (bỏ qua)", "db", name, "err", err)
		return
	}
	log.Info("đã tạo database", "db", name)
}

// Migrate chạy migrations/*.sql theo thứ tự tên, mỗi file một lần, trong transaction riêng.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrateLockKey); err != nil {
		return err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", migrateLockKey) //nolint:errcheck

	if _, err := conn.Exec(ctx, platformSQL); err != nil {
		return fmt.Errorf("platform schema: %w", err)
	}
	done := map[string]bool{}
	rows, err := conn.Query(ctx, "SELECT name FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return err
		}
		done[n] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if done[name] {
			continue
		}
		sqlText, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(sqlText)); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "INSERT INTO schema_migrations(name) VALUES ($1)", name)
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s lỗi: %w", name, err)
		}
		log.Info("migration applied", "migration", name)
	}
	return nil
}

// IsUniqueViolation: lỗi trùng khoá (23505).
func IsUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	return errors.As(err, &pgErr) && pgErr.SQLState() == "23505"
}
