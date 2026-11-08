// Package telemetry: OpenTelemetry (OTLP HTTP), propagation W3C traceparent, log slog JSON có trace_id/span_id.
package telemetry

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var propagator = propagation.TraceContext{}

// Setup bật tracer OTLP khi có endpoint (giống packages/platform/src/otel.ts). Trả hàm shutdown (flush span).
func Setup(ctx context.Context, service, endpoint string) (func(context.Context) error, error) {
	otel.SetTextMapPropagator(propagator)
	if endpoint == "" || os.Getenv("OTEL_SDK_DISABLED") == "true" {
		return func(context.Context) error { return nil }, nil
	}
	exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(strings.TrimRight(endpoint, "/")+"/v1/traces"))
	if err != nil {
		return nil, err
	}
	name := service
	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		name = v
	}
	res := resource.NewSchemaless(
		attribute.String("service.name", name),
		attribute.String("service.version", envOr("APP_VERSION", "dev")),
		attribute.String("deployment.environment", envOr("DEPLOY_ENV", "local")),
	)
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	return tp.Shutdown, nil
}

func Tracer() trace.Tracer { return otel.Tracer("shopnow-inventory") }

// Traceparent trả header W3C của span hiện tại ("" nếu không có span hợp lệ).
func Traceparent(ctx context.Context) string {
	c := propagation.MapCarrier{}
	propagator.Inject(ctx, c)
	return c["traceparent"]
}

// WithTraceparent dựng lại context cha từ field traceparent của phong bì sự kiện.
func WithTraceparent(ctx context.Context, tp string) context.Context {
	if tp == "" {
		return ctx
	}
	return propagator.Extract(ctx, propagation.MapCarrier{"traceparent": tp})
}

// NewLogger: JSON ra stdout, có service + trace_id/span_id (để Loki nhảy sang Tempo).
func NewLogger(service, level string, w io.Writer) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug", "trace":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error", "fatal":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: lv,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			switch a.Key {
			case slog.MessageKey:
				a.Key = "msg"
			case slog.LevelKey:
				a.Value = slog.StringValue(strings.ToLower(a.Value.String()))
			}
			return a
		},
	})
	return slog.New(traceHandler{h}).With("service", service)
}

type traceHandler struct{ slog.Handler }

func (h traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(as)}
}
func (h traceHandler) WithGroup(n string) slog.Handler { return traceHandler{h.Handler.WithGroup(n)} }

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
