// Package metrics: metric Prometheus bắt buộc theo docs/architecture.md §6, mọi metric gắn nhãn service="inventory".
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const Service = "inventory"

var (
	Registry = prometheus.NewRegistry()
	reg      = prometheus.WrapRegistererWith(prometheus.Labels{"service": Service}, Registry)

	HTTPDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_server_requests_seconds",
		Help:    "Thời gian xử lý HTTP (RED)",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
	}, []string{"method", "route", "status"})

	KafkaConsumed = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "kafka_messages_consumed_total",
		Help: "Số message Kafka đã xử lý",
	}, []string{"topic", "type", "result"})

	KafkaProduced = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "kafka_messages_produced_total",
		Help: "Số message Kafka đã gửi",
	}, []string{"topic"})

	OutboxPending = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "outbox_pending",
		Help: "Số sự kiện outbox chưa gửi",
	})

	// result: reserved | failed | duplicate
	ReserveTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "inventory_reserve_total",
		Help: "Số lệnh giữ hàng theo kết quả",
	}, []string{"result"})

	ExpiredTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "inventory_reservations_expired_total",
		Help: "Số reservation bị sweeper cho hết hạn",
	})
)

func init() {
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		HTTPDuration, KafkaConsumed, KafkaProduced, OutboxPending, ReserveTotal, ExpiredTotal,
	)
}

func Handler() http.Handler {
	return promhttp.HandlerFor(Registry, promhttp.HandlerOpts{})
}
