// Package kafka: franz-go cho producer (relay outbox) và consumer group (thử lại 3 lần → <topic>.dlq).
package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/events"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/metrics"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/telemetry"
)

// Handler xử lý một sự kiện; trả lỗi → thử lại (tối đa MaxAttempts) rồi đẩy DLQ.
type Handler func(ctx context.Context, topic string, ev events.Envelope) error

const MaxAttempts = 3

// Producer gửi bản ghi (dùng cho relay outbox và DLQ).
type Producer struct{ cl *kgo.Client }

func NewProducer(brokers []string, clientID string) (*Producer, error) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ClientID(clientID),
		kgo.AllowAutoTopicCreation(),
		// kafkajs (các service Node) chỉ giải nén được GZIP sẵn có → không dùng snappy/lz4/zstd.
		kgo.ProducerBatchCompression(kgo.GzipCompression()),
		kgo.RecordRetries(8),
	)
	if err != nil {
		return nil, err
	}
	return &Producer{cl: cl}, nil
}

func (p *Producer) Publish(ctx context.Context, msgs []events.Message) error {
	recs := make([]*kgo.Record, 0, len(msgs))
	for _, m := range msgs {
		r := &kgo.Record{Topic: m.Topic, Key: []byte(m.Key), Value: m.Payload}
		if m.Type != "" {
			r.Headers = []kgo.RecordHeader{{Key: "ce-type", Value: []byte(m.Type)}}
		}
		recs = append(recs, r)
	}
	if err := p.cl.ProduceSync(ctx, recs...).FirstErr(); err != nil {
		return err
	}
	for _, m := range msgs {
		metrics.KafkaProduced.WithLabelValues(m.Topic).Inc()
	}
	return nil
}

func (p *Producer) Ping(ctx context.Context) error { return p.cl.Ping(ctx) }

// EnsureTopics tạo topic + <topic>.dlq nếu thiếu (lỗi chỉ cảnh báo — broker có thể tự tạo).
func (p *Producer) EnsureTopics(ctx context.Context, log *slog.Logger, topics ...string) {
	adm := kadm.NewClient(p.cl)
	all := make([]string, 0, len(topics)*2)
	for _, t := range topics {
		all = append(all, t, t+".dlq")
	}
	existing, err := adm.ListTopics(ctx, all...)
	if err != nil {
		log.Warn("không liệt kê được topic (bỏ qua)", "err", err)
		return
	}
	var missing []string
	for _, t := range all {
		if d, ok := existing[t]; !ok || d.Err != nil {
			missing = append(missing, t)
		}
	}
	if len(missing) == 0 {
		return
	}
	resp, err := adm.CreateTopics(ctx, 3, -1, nil, missing...)
	if err != nil {
		log.Warn("không tạo được topic (bỏ qua)", "err", err)
		return
	}
	for _, r := range resp.Sorted() {
		if r.Err != nil && !errors.Is(r.Err, kerr.TopicAlreadyExists) {
			log.Warn("không tạo được topic", "topic", r.Topic, "err", r.Err)
		}
	}
}

func (p *Producer) Close() { p.cl.Close() }

// Consumer group; mỗi lần poll xử lý các partition song song (thứ tự trong partition giữ nguyên), xong mới commit offset.
type Consumer struct {
	cl       *kgo.Client
	group    string
	dlq      *Producer
	handler  Handler
	log      *slog.Logger
	backoff  func(attempt int) time.Duration
	done     chan struct{}
	stopOnce sync.Once
}

func NewConsumer(brokers []string, group string, topics []string, dlq *Producer, h Handler, log *slog.Logger) (*Consumer, error) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ClientID(group),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topics...),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()), // giống fromBeginning: true
		kgo.DisableAutoCommit(),
		kgo.BlockRebalanceOnPoll(),
		kgo.SessionTimeout(30*time.Second),
		kgo.HeartbeatInterval(3*time.Second),
	)
	if err != nil {
		return nil, err
	}
	return &Consumer{
		cl: cl, group: group, dlq: dlq, handler: h, log: log, done: make(chan struct{}),
		backoff: func(a int) time.Duration { return time.Duration(200*(1<<a)) * time.Millisecond },
	}, nil
}

func (c *Consumer) Ping(ctx context.Context) error { return c.cl.Ping(ctx) }

// Run vòng poll tới khi ctx huỷ. Lô đang xử lý được làm xong và commit trước khi thoát.
func (c *Consumer) Run(ctx context.Context) {
	defer close(c.done)
	for {
		fetches := c.cl.PollFetches(ctx)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			c.cl.AllowRebalance()
			return
		}
		fetches.EachError(func(t string, p int32, err error) {
			c.log.Warn("kafka fetch lỗi", "topic", t, "partition", p, "err", err)
		})
		var wg sync.WaitGroup
		fetches.EachPartition(func(ftp kgo.FetchTopicPartition) {
			if len(ftp.Records) == 0 {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				for _, r := range ftp.Records {
					// Dùng context riêng: SIGTERM không cắt ngang message đang xử lý.
					c.process(context.WithoutCancel(ctx), r)
				}
			}()
		})
		wg.Wait()
		if err := c.cl.CommitUncommittedOffsets(context.WithoutCancel(ctx)); err != nil {
			c.log.Warn("commit offset lỗi", "err", err)
		}
		c.cl.AllowRebalance()
	}
}

func (c *Consumer) process(ctx context.Context, r *kgo.Record) {
	var ev events.Envelope
	if err := json.Unmarshal(r.Value, &ev); err != nil || ev.ID == "" || ev.Type == "" {
		metrics.KafkaConsumed.WithLabelValues(r.Topic, "invalid", "dropped").Inc()
		c.log.Warn("bỏ message không đúng phong bì", "topic", r.Topic, "offset", r.Offset)
		return
	}
	Dispatch(ctx, r.Topic, ev, c.handler, c.backoff, c.log, func(ctx context.Context, payload []byte) error {
		if c.dlq == nil {
			return errors.New("không có producer DLQ")
		}
		return c.dlq.Publish(ctx, []events.Message{{Topic: r.Topic + ".dlq", Key: ev.Subject, Type: ev.Type, Payload: payload}})
	}, c.group)
}

// Dispatch: dựng trace từ traceparent, gọi handler, thử lại MaxAttempts lần (backoff) rồi gửi DLQ.
// Tách riêng để test được không cần Kafka. Trả kết quả: "ok" | "dlq".
func Dispatch(ctx context.Context, topic string, ev events.Envelope, h Handler, backoff func(int) time.Duration,
	log *slog.Logger, sendDLQ func(context.Context, []byte) error, consumer string) string {
	ctx = telemetry.WithTraceparent(ctx, ev.Traceparent)
	ctx, span := telemetry.Tracer().Start(ctx, "consume "+ev.Type, trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination.name", topic),
			attribute.String("event.type", ev.Type),
			attribute.String("event.id", ev.ID),
		))
	defer span.End()
	for attempt := 1; ; attempt++ {
		err := h(ctx, topic, ev)
		if err == nil {
			metrics.KafkaConsumed.WithLabelValues(topic, ev.Type, "ok").Inc()
			return "ok"
		}
		if attempt >= MaxAttempts {
			log.ErrorContext(ctx, "xử lý sự kiện thất bại → DLQ", "topic", topic, "type", ev.Type, "eventId", ev.ID, "err", err)
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			metrics.KafkaConsumed.WithLabelValues(topic, ev.Type, "dlq").Inc()
			payload, mErr := dlqPayload(ev, err, consumer)
			if mErr == nil {
				mErr = sendDLQ(ctx, payload)
			}
			if mErr != nil {
				log.ErrorContext(ctx, "không ghi được DLQ", "err", mErr)
			}
			return "dlq"
		}
		log.WarnContext(ctx, "xử lý sự kiện lỗi, thử lại", "type", ev.Type, "eventId", ev.ID, "attempt", attempt, "err", err)
		time.Sleep(backoff(attempt))
	}
}

// Giống bản Node: {...event, error, consumer}.
func dlqPayload(ev events.Envelope, err error, consumer string) ([]byte, error) {
	return json.Marshal(struct {
		events.Envelope
		Error    string `json:"error"`
		Consumer string `json:"consumer"`
	}{ev, err.Error(), consumer})
}

// Close: dừng consumer (rời group, offset đã commit sau mỗi lô).
func (c *Consumer) Close(ctx context.Context) error {
	var err error
	c.stopOnce.Do(func() {
		select {
		case <-c.done:
		case <-ctx.Done():
			err = fmt.Errorf("consumer chưa dừng kịp: %w", ctx.Err())
		}
		c.cl.Close()
	})
	return err
}
