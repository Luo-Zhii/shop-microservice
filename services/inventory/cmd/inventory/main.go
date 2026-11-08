// Inventory service (Go): tồn kho + giữ hàng cho saga đặt hàng. Xem docs/architecture.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/auth"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/config"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/db"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/events"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/httpapi"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/inventory"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/kafka"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/telemetry"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "inventory:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("cấu hình không hợp lệ: %w", err)
	}
	log := telemetry.NewLogger(cfg.ServiceName, cfg.LogLevel, os.Stdout)
	slog.SetDefault(log)

	sigCtx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stopSignals()

	startCtx, cancelStart := context.WithTimeout(sigCtx, 60*time.Second)
	defer cancelStart()

	shutdownTracer, err := telemetry.Setup(startCtx, cfg.ServiceName, cfg.OTLPEndpoint)
	if err != nil {
		return fmt.Errorf("otel: %w", err)
	}

	db.EnsureDatabase(startCtx, cfg.DatabaseURL, log)
	pool, err := db.Connect(startCtx, cfg.DatabaseURL, 20)
	if err != nil {
		return fmt.Errorf("kết nối Postgres: %w", err)
	}
	defer pool.Close()
	if err := db.Migrate(startCtx, pool, log); err != nil {
		return err
	}

	// Context nền cho worker (relay, sweeper, JWKS refresh) — huỷ khi tắt.
	bgCtx, cancelBg := context.WithCancel(context.Background())
	defer cancelBg()

	verifier, err := auth.New(bgCtx, cfg.JWKSURL, cfg.JWTIssuer, cfg.JWTAudience, cfg.InternalToken)
	if err != nil {
		return fmt.Errorf("JWKS: %w", err)
	}

	svc := inventory.New(pool, log, cfg.DefaultTTL)
	checks := map[string]httpapi.Check{"db": func(ctx context.Context) error { return pool.Ping(ctx) }}

	var (
		workers  sync.WaitGroup
		producer *kafka.Producer
		consumer *kafka.Consumer
	)
	consumeCtx, cancelConsume := context.WithCancel(context.Background())
	defer cancelConsume()
	if cfg.KafkaEnabled {
		if producer, err = kafka.NewProducer(cfg.KafkaBrokers, cfg.ServiceName); err != nil {
			return fmt.Errorf("kafka producer: %w", err)
		}
		defer producer.Close()
		producer.EnsureTopics(startCtx, log, events.TopicInventoryEvent, events.TopicInventoryCommand, events.TopicCatalogProduct)
		consumer, err = kafka.NewConsumer(cfg.KafkaBrokers, inventory.Consumer,
			[]string{events.TopicCatalogProduct, events.TopicInventoryCommand}, producer, svc.HandleEvent, log)
		if err != nil {
			return fmt.Errorf("kafka consumer: %w", err)
		}
		checks["kafka"] = producer.Ping
		go consumer.Run(consumeCtx)
		workers.Add(1)
		go func() { defer workers.Done(); events.RunRelay(bgCtx, pool, producer, cfg.RelayInterval, log) }()
	} else {
		log.Warn("KAFKA_ENABLED=false — không consume, sự kiện nằm lại trong outbox")
	}
	workers.Add(1)
	go func() { defer workers.Done(); svc.RunSweeper(bgCtx, cfg.SweepInterval) }()

	api := httpapi.New(svc, verifier, log, checks)
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	srvErr := make(chan error, 1)
	go func() {
		log.Info(cfg.ServiceName+" sẵn sàng", "port", cfg.Port, "kafka", cfg.KafkaEnabled)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			srvErr <- err
		}
	}()

	select {
	case <-sigCtx.Done():
	case err := <-srvErr:
		return fmt.Errorf("http: %w", err)
	}

	// ---- Graceful shutdown (≤ 15s) ----
	log.Info("đang tắt êm (graceful shutdown)")
	force := time.AfterFunc(cfg.ShutdownBudget, func() {
		log.Error("quá hạn tắt êm → thoát cưỡng bức")
		os.Exit(1)
	})
	defer force.Stop()
	deadline, cancelDeadline := context.WithTimeout(context.Background(), cfg.ShutdownBudget-time.Second)
	defer cancelDeadline()

	api.SetShuttingDown()
	httpCtx, cancelHTTP := context.WithTimeout(deadline, 8*time.Second)
	if err := srv.Shutdown(httpCtx); err != nil {
		log.Warn("http shutdown", "err", err)
	}
	cancelHTTP()

	cancelConsume() // ngừng poll; lô đang xử lý được làm xong + commit offset
	if consumer != nil {
		if err := consumer.Close(deadline); err != nil {
			log.Warn("consumer shutdown", "err", err)
		}
	}
	cancelBg()
	workers.Wait()
	if producer != nil { // đẩy nốt sự kiện vừa ghi vào outbox
		flushCtx, cancelFlush := context.WithTimeout(deadline, 2*time.Second)
		if _, err := events.RelayOnce(flushCtx, pool, producer, 500); err != nil {
			log.Warn("flush outbox", "err", err)
		}
		cancelFlush()
	}
	if err := shutdownTracer(deadline); err != nil {
		log.Warn("otel shutdown", "err", err)
	}
	log.Info("đã tắt")
	return nil
}
