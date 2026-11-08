package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/events"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/telemetry"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func noBackoff(int) time.Duration { return 0 }

func TestDispatchRetriesThenDLQ(t *testing.T) {
	ev := events.Envelope{ID: "e1", Type: "inventory.commit", Subject: "r1", Data: json.RawMessage(`{"reservationId":"r1"}`),
		Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
	calls := 0
	var dlq []byte
	res := Dispatch(context.Background(), "inventory.command.v1", ev,
		func(ctx context.Context, _ string, _ events.Envelope) error {
			calls++
			// Sự kiện phát ra trong handler phải nối tiếp trace của message vào.
			if tp := telemetry.Traceparent(ctx); !strings.Contains(tp, "4bf92f3577b34da6a3ce929d0e0e4736") {
				t.Errorf("traceparent không được nối tiếp: %q", tp)
			}
			return errors.New("db down")
		},
		noBackoff, quiet, func(_ context.Context, p []byte) error { dlq = p; return nil }, "inventory")
	if res != "dlq" || calls != MaxAttempts {
		t.Fatalf("muốn thử %d lần rồi DLQ, có %d lần, kết quả %s", MaxAttempts, calls, res)
	}
	var got map[string]any
	if err := json.Unmarshal(dlq, &got); err != nil {
		t.Fatal(err)
	}
	if got["id"] != "e1" || got["error"] != "db down" || got["consumer"] != "inventory" || got["subject"] != "r1" {
		t.Fatalf("payload DLQ sai: %v", got)
	}
}

func TestDispatchRecoversWithoutDLQ(t *testing.T) {
	calls := 0
	res := Dispatch(context.Background(), "t", events.Envelope{ID: "e2", Type: "x"},
		func(context.Context, string, events.Envelope) error {
			calls++
			if calls < 2 {
				return errors.New("tạm thời")
			}
			return nil
		},
		noBackoff, quiet, func(context.Context, []byte) error { t.Fatal("không được ghi DLQ"); return nil }, "inventory")
	if res != "ok" || calls != 2 {
		t.Fatalf("kết quả %s sau %d lần", res, calls)
	}
}
