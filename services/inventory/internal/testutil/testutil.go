// Package testutil: database Postgres sạch cho test tích hợp (TEST_DATABASE_URL).
package testutil

import (
	"context"
	"io"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/db"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/telemetry"
)

var (
	once    sync.Once
	pool    *pgxpool.Pool
	initErr error
)

// DB trả pool tới database "<tên trong TEST_DATABASE_URL><suffix>" — tạo lại sạch ở lần gọi đầu của mỗi process
// (mỗi package test một suffix riêng vì go test chạy các package song song), xoá dữ liệu trước mỗi test.
func DB(t testing.TB, suffix string) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("cần TEST_DATABASE_URL (vd postgres://shopnow:shopnow@localhost:55432/inventory_test)")
	}
	once.Do(func() { pool, initErr = create(base, suffix) })
	if initErr != nil {
		t.Fatalf("tạo database test: %v", initErr)
	}
	// DELETE thay TRUNCATE: bảng test nhỏ, TRUNCATE phải fsync file mới → chậm trên ổ yếu.
	_, err := pool.Exec(context.Background(), `DELETE FROM reservation_restock_items; DELETE FROM reservation_restocks; DELETE FROM reservation_items; DELETE FROM reservations; DELETE FROM stock;
		DELETE FROM skus; DELETE FROM stock_movements; DELETE FROM outbox; DELETE FROM processed_events`)
	if err != nil {
		t.Fatalf("dọn dữ liệu: %v", err)
	}
	return pool
}

func create(base, suffix string) (*pgxpool.Pool, error) {
	ctx := context.Background()
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	name := strings.TrimPrefix(u.Path, "/") + suffix
	admin := *u
	admin.Path = "/postgres"
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		return nil, err
	}
	defer conn.Close(ctx)
	ident := pgx.Identifier{name}.Sanitize()
	if _, err := conn.Exec(ctx, "DROP DATABASE IF EXISTS "+ident+" WITH (FORCE)"); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+ident); err != nil {
		return nil, err
	}
	u.Path = "/" + name
	q := u.Query()
	q.Set("synchronous_commit", "off") // chỉ cho DB test: bỏ chờ fsync mỗi commit
	u.RawQuery = q.Encode()
	p, err := db.Connect(ctx, u.String(), 30)
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx, p, Logger()); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// Logger im lặng (đặt TEST_LOG=1 để xem log).
func Logger() *slog.Logger {
	var w io.Writer = io.Discard
	if os.Getenv("TEST_LOG") != "" {
		w = os.Stderr
	}
	return telemetry.NewLogger("inventory-test", "debug", w)
}
