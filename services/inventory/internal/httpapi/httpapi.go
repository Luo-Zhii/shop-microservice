// Package httpapi: REST của inventory (docs/architecture.md §5) + /healthz /readyz /metrics, lỗi {error:{code,message}}.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/trace"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/auth"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/inventory"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/metrics"
)

const maxSkuIDs = 200

// Check là một kiểm tra readiness (DB, Kafka…).
type Check func(ctx context.Context) error

type Server struct {
	svc          *inventory.Service
	auth         *auth.Verifier
	log          *slog.Logger
	checks       map[string]Check
	shuttingDown atomic.Bool
}

func New(svc *inventory.Service, v *auth.Verifier, log *slog.Logger, checks map[string]Check) *Server {
	return &Server{svc: svc, auth: v, log: log, checks: checks}
}

// SetShuttingDown: /readyz trả 503 để load balancer ngừng gửi request mới.
func (s *Server) SetShuttingDown() { s.shuttingDown.Store(true) }

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(requestID, s.recoverer, s.observe)
	r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Không có route này")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "NOT_FOUND", "Phương thức không được hỗ trợ")
	})

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": metrics.Service})
	})
	r.Get("/readyz", s.readyz)
	r.Method(http.MethodGet, "/metrics", metrics.Handler())

	r.Get("/stock", s.getStock)
	r.Group(func(r chi.Router) {
		r.Use(s.requireSeller)
		r.Get("/seller/stock", s.listSellerStock)
		r.Put("/seller/stock/{skuId}", s.putSellerStock)
	})

	return otelhttp.NewHandler(r, "http.server", otelhttp.WithFilter(func(r *http.Request) bool {
		return !isInfraPath(r.URL.Path)
	}))
}

func isInfraPath(p string) bool { return p == "/healthz" || p == "/readyz" || p == "/metrics" }

// ---- handlers ----

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	if s.shuttingDown.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "shutting_down"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	results := map[string]string{}
	ok := true
	for name, check := range s.checks {
		if err := check(ctx); err != nil {
			ok = false
			results[name] = err.Error()
		} else {
			results[name] = "ok"
		}
	}
	status, code := "ok", http.StatusOK
	if !ok {
		status, code = "degraded", http.StatusServiceUnavailable
	}
	writeJSON(w, code, map[string]any{"status": status, "checks": results})
}

func (s *Server) getStock(w http.ResponseWriter, r *http.Request) {
	var ids []string
	for _, p := range strings.Split(r.URL.Query().Get("skuIds"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			ids = append(ids, p)
		}
	}
	if len(ids) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Thiếu tham số skuIds")
		return
	}
	if len(ids) > maxSkuIDs {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Tối đa 200 skuIds mỗi lần")
		return
	}
	out, err := s.svc.GetStock(r.Context(), ids)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listSellerStock(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	q := r.URL.Query()
	page := clamp(atoiDefault(q.Get("page"), 1), 1, 1_000_000)
	pageSize := clamp(atoiDefault(q.Get("pageSize"), 20), 1, 100)
	items, total, err := s.svc.ListShopStock(r.Context(), u.ShopID, q.Get("productId"), pageSize, (page-1)*pageSize)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if items == nil {
		items = []inventory.SellerStock{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "page": page, "pageSize": pageSize, "total": total})
}

func (s *Server) putSellerStock(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var body struct {
		OnHand *json.Number `json:"onHand"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil || body.OnHand == nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Body phải có dạng {\"onHand\": số nguyên ≥ 0}")
		return
	}
	onHand, err := strconv.ParseInt(body.OnHand.String(), 10, 32)
	if err != nil || onHand < 0 || onHand > 1_000_000_000 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "onHand phải là số nguyên từ 0 đến 1.000.000.000")
		return
	}
	out, err := s.svc.SetOnHand(r.Context(), u.ShopID, u.ID, chi.URLParam(r, "skuId"), int(onHand))
	var insufficient *inventory.InsufficientStockError
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, out)
	case errors.Is(err, inventory.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Không tìm thấy SKU")
	case errors.Is(err, inventory.ErrForbidden):
		writeError(w, http.StatusForbidden, "FORBIDDEN", "SKU không thuộc shop của bạn")
	case errors.As(err, &insufficient):
		writeErrorDetails(w, http.StatusConflict, "INSUFFICIENT_STOCK",
			"Số tồn mới nhỏ hơn số đang giữ cho đơn hàng", map[string]int{"reserved": insufficient.Reserved})
	default:
		s.internalError(w, r, err)
	}
}

// ---- auth ----

type ctxKey struct{}

func userFrom(ctx context.Context) *auth.User { u, _ := ctx.Value(ctxKey{}).(*auth.User); return u }

func (s *Server) requireSeller(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(h, "Bearer ")
		if !ok || token == "" {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Chưa đăng nhập")
			return
		}
		u, err := s.auth.Verify(r.Context(), token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Token không hợp lệ hoặc đã hết hạn")
			return
		}
		if !u.HasRole("seller") || u.ShopID == "" {
			writeError(w, http.StatusForbidden, "FORBIDDEN", "Chỉ người bán đã có shop mới được quản lý tồn kho")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

// ---- middleware ----

func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("x-request-id")
		if id == "" || len(id) > 128 {
			id = uuid.NewString()
		}
		w.Header().Set("x-request-id", id)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				s.log.ErrorContext(r.Context(), "panic", "panic", rec, "url", r.URL.Path)
				writeError(w, http.StatusInternalServerError, "INTERNAL", "Lỗi hệ thống")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// observe: histogram RED theo route pattern của chi + log JSON mỗi request.
func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isInfraPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}
		route := "unknown"
		if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
			route = rc.RoutePattern()
		}
		elapsed := time.Since(start)
		metrics.HTTPDuration.WithLabelValues(r.Method, route, strconv.Itoa(status)).Observe(elapsed.Seconds())
		trace.SpanFromContext(r.Context()).SetName(r.Method + " " + route)
		attrs := []any{"method", r.Method, "url", r.URL.RequestURI(), "status", status, "ms", elapsed.Milliseconds()}
		if status >= 500 {
			s.log.ErrorContext(r.Context(), "request failed", attrs...)
		} else {
			s.log.InfoContext(r.Context(), "request", attrs...)
		}
	})
}

// ---- response helpers ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, errCode, msg string) {
	writeErrorDetails(w, code, errCode, msg, nil)
}

func writeErrorDetails(w http.ResponseWriter, code int, errCode, msg string, details any) {
	e := map[string]any{"code": errCode, "message": msg}
	if details != nil {
		e["details"] = details
	}
	writeJSON(w, code, map[string]any{"error": e})
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.log.ErrorContext(r.Context(), "unhandled error", "err", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL", "Lỗi hệ thống")
}

func atoiDefault(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func clamp(n, lo, hi int) int { return max(lo, min(hi, n)) }
