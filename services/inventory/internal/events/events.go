// Package events: phong bì sự kiện (docs/architecture.md §3), Transactional Outbox + relay, Inbox (processed_events).
// Tương đương packages/platform/src/kafka.ts của bản Node.
package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/metrics"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/telemetry"
)

// Topic theo packages/contracts/src/index.ts.
const (
	TopicCatalogProduct   = "catalog.product.v1"
	TopicInventoryCommand = "inventory.command.v1"
	TopicInventoryEvent   = "inventory.event.v1"

	Source = "inventory"
)

// Envelope = CloudEvents-lite. Data giữ nguyên JSON thô để mỗi handler tự giải mã.
type Envelope struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	Source      string          `json:"source"`
	Time        string          `json:"time"`
	Subject     string          `json:"subject"`
	Traceparent string          `json:"traceparent,omitempty"`
	Data        json.RawMessage `json:"data"`
}

// New tạo phong bì, gắn traceparent của span hiện tại để consumer nối tiếp trace.
func New(ctx context.Context, typ, subject string, data any) (Envelope, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Envelope{}, err
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{
		ID:          id.String(),
		Type:        typ,
		Source:      Source,
		Time:        time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Subject:     subject,
		Traceparent: telemetry.Traceparent(ctx),
		Data:        raw,
	}, nil
}

// Enqueue ghi sự kiện vào outbox TRONG CÙNG transaction với thay đổi nghiệp vụ. Key Kafka = subject.
func Enqueue(ctx context.Context, tx pgx.Tx, topic string, evs ...Envelope) error {
	if len(evs) == 0 {
		return nil
	}
	b := &pgx.Batch{}
	for _, e := range evs {
		payload, err := json.Marshal(e)
		if err != nil {
			return err
		}
		b.Queue("INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)", e.ID, topic, e.Subject, payload)
	}
	return tx.SendBatch(ctx, b).Close()
}

// ProcessOnce chạy fn trong transaction chỉ khi consumer chưa xử lý eventID (Kafka at-least-once).
// Trả false nếu là bản trùng. event_id lưu dạng "<consumer>:<id>" giống bản Node.
func ProcessOnce(ctx context.Context, pool *pgxpool.Pool, consumer, eventID string, fn func(pgx.Tx) error) (bool, error) {
	fresh := false
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			"INSERT INTO processed_events (event_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			consumer+":"+eventID, consumer)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil // bản trùng → commit transaction rỗng
		}
		fresh = true
		return fn(tx)
	})
	if err != nil {
		return false, err
	}
	return fresh, nil
}

// Message là một bản ghi outbox chờ gửi.
type Message struct {
	Topic   string
	Key     string
	Type    string
	Payload []byte
}

// Publisher gửi đồng bộ một lô message (trả lỗi nếu bất kỳ message nào thất bại).
type Publisher interface {
	Publish(ctx context.Context, msgs []Message) error
}

// RelayOnce: lấy tối đa limit bản ghi (FOR UPDATE SKIP LOCKED → nhiều replica an toàn), gửi, xoá. Trả số đã gửi.
func RelayOnce(ctx context.Context, pool *pgxpool.Pool, pub Publisher, limit int) (int, error) {
	sent := 0
	var ids []uuid.UUID
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			"SELECT id, topic, key, payload, payload->>'type' FROM outbox ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED", limit)
		if err != nil {
			return err
		}
		var msgs []Message
		for rows.Next() {
			var (
				id  uuid.UUID
				m   Message
				typ *string
			)
			if err := rows.Scan(&id, &m.Topic, &m.Key, &m.Payload, &typ); err != nil {
				rows.Close()
				return err
			}
			if typ != nil {
				m.Type = *typ
			}
			ids = append(ids, id)
			msgs = append(msgs, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(msgs) == 0 {
			return nil
		}
		if err := pub.Publish(ctx, msgs); err != nil {
			return fmt.Errorf("publish: %w", err)
		}
		if _, err := tx.Exec(ctx, "DELETE FROM outbox WHERE id = ANY($1)", ids); err != nil {
			return err
		}
		sent = len(msgs)
		return nil
	})
	if err != nil && len(ids) > 0 {
		// Ghi nhận số lần thử để dễ soi bản ghi "kẹt" (ngoài transaction đã rollback).
		_, _ = pool.Exec(context.WithoutCancel(ctx), "UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY($1)", ids)
	}
	return sent, err
}

// RunRelay chạy relay tới khi ctx huỷ; gửi xong một lô đầy thì chạy tiếp ngay, rảnh thì nghỉ interval.
func RunRelay(ctx context.Context, pool *pgxpool.Pool, pub Publisher, interval time.Duration, log *slog.Logger) {
	gauge := time.NewTicker(5 * time.Second)
	defer gauge.Stop()
	updateGauge := func() {
		var n int64
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM outbox").Scan(&n); err == nil {
			metrics.OutboxPending.Set(float64(n))
		}
	}
	updateGauge()
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-gauge.C:
			updateGauge()
			continue
		case <-timer.C:
		}
		n, err := RelayOnce(ctx, pool, pub, 200)
		if err != nil && !errors.Is(err, context.Canceled) {
			log.WarnContext(ctx, "outbox relay lỗi, sẽ thử lại", "err", err)
		}
		next := interval
		if n > 0 {
			next = 0
		}
		timer.Reset(next)
	}
}
