// Package config đọc biến môi trường giống bản Node (packages/platform/src/config.ts).
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ServiceName   string
	Port          int
	LogLevel      string
	DatabaseURL   string
	KafkaBrokers  []string
	KafkaEnabled  bool
	JWKSURL       string
	JWTIssuer     string
	JWTAudience   string
	InternalToken string
	OTLPEndpoint  string

	DefaultTTL     time.Duration // ttlSeconds mặc định khi lệnh reserve không gửi
	SweepInterval  time.Duration
	RelayInterval  time.Duration
	ShutdownBudget time.Duration
}

// Load đọc env; lỗi cấu hình trả về error để main thoát ngay (fail fast).
func Load() (Config, error) {
	c := Config{
		ServiceName:    env("SERVICE_NAME", "inventory"),
		LogLevel:       env("LOG_LEVEL", "info"),
		DatabaseURL:    env("DATABASE_URL", "postgres://shopnow:shopnow@localhost:55432/inventory"),
		KafkaBrokers:   splitList(env("KAFKA_BROKERS", "localhost:59092")),
		JWKSURL:        env("JWKS_URL", "http://localhost:8101/.well-known/jwks.json"),
		JWTIssuer:      env("JWT_ISSUER", "shopnow-identity"),
		JWTAudience:    env("JWT_AUDIENCE", "shopnow"),
		InternalToken:  env("INTERNAL_TOKEN", "dev-internal-token"),
		OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		ShutdownBudget: 15 * time.Second,
	}
	var err error
	if c.Port, err = intEnv("PORT", 8106); err != nil {
		return c, err
	}
	if c.KafkaEnabled, err = boolEnv("KAFKA_ENABLED", true); err != nil {
		return c, err
	}
	ttl, err := intEnv("RESERVATION_DEFAULT_TTL_SECONDS", 900)
	if err != nil {
		return c, err
	}
	c.DefaultTTL = time.Duration(ttl) * time.Second
	sweep, err := intEnv("RESERVATION_SWEEP_INTERVAL_MS", 2000)
	if err != nil {
		return c, err
	}
	c.SweepInterval = time.Duration(sweep) * time.Millisecond
	relay, err := intEnv("OUTBOX_RELAY_INTERVAL_MS", 250)
	if err != nil {
		return c, err
	}
	c.RelayInterval = time.Duration(relay) * time.Millisecond
	if len(c.KafkaBrokers) == 0 && c.KafkaEnabled {
		return c, fmt.Errorf("KAFKA_BROKERS rỗng")
	}
	return c, nil
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func intEnv(k string, def int) (int, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s không hợp lệ: %q", k, v)
	}
	return n, nil
}

func boolEnv(k string, def bool) (bool, error) {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(k)))
	switch v {
	case "":
		return def, nil
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	}
	return false, fmt.Errorf("%s không hợp lệ: %q", k, v)
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
