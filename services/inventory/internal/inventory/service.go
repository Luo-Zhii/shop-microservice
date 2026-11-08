// Package inventory: nghiệp vụ tồn kho — đăng ký SKU từ catalog, giữ/chốt/nhả hàng theo lệnh của order (saga),
// sweeper hết hạn, chỉnh tồn của seller. Mọi sự kiện phát qua outbox trong cùng transaction.
package inventory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/events"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/metrics"
)

// Consumer = tên consumer group + tiền tố khoá inbox.
const Consumer = "inventory"

// Kiểu sự kiện (docs/architecture.md §3).
const (
	EvProductUpserted = "product.upserted"
	EvProductDeleted  = "product.deleted"

	CmdReserve = "inventory.reserve"
	CmdCommit  = "inventory.commit"
	CmdRelease = "inventory.release"

	EvReserved      = "inventory.reserved"
	EvReserveFailed = "inventory.reserve_failed"
	EvCommitted     = "inventory.committed"
	EvReleased      = "inventory.released"
	EvExpired       = "inventory.expired"
	EvStockChanged  = "stock.changed"

	ReasonOutOfStock     = "OUT_OF_STOCK"
	ReasonInvalidRequest = "INVALID_REQUEST"
)

// Trạng thái reservation.
const (
	StatusReserved  = "RESERVED"
	StatusCommitted = "COMMITTED"
	StatusReleased  = "RELEASED"
	StatusExpired   = "EXPIRED"
	StatusFailed    = "FAILED"
)

const maxQty = 1_000_000_000

type Service struct {
	pool       *pgxpool.Pool
	log        *slog.Logger
	defaultTTL time.Duration
}

func New(pool *pgxpool.Pool, log *slog.Logger, defaultTTL time.Duration) *Service {
	if defaultTTL <= 0 {
		defaultTTL = 15 * time.Minute
	}
	return &Service{pool: pool, log: log, defaultTTL: defaultTTL}
}

// ---- payload ----

type ReserveItem struct {
	SkuID string `json:"skuId"`
	Qty   int    `json:"qty"`
}

type ReserveCmd struct {
	ReservationID string        `json:"reservationId"`
	OrderIDs      []string      `json:"orderIds"`
	Items         []ReserveItem `json:"items"`
	TTLSeconds    int           `json:"ttlSeconds"`
}

type RefCmd struct {
	ReservationID string `json:"reservationId"`
	Reason        string `json:"reason,omitempty"`
}

type Reserved struct {
	ReservationID string `json:"reservationId"`
	ExpiresAt     string `json:"expiresAt"`
}

type ReserveFailed struct {
	ReservationID string   `json:"reservationId"`
	Reason        string   `json:"reason"`
	SkuIDs        []string `json:"skuIds"`
}

type StockChanged struct {
	SkuID     string `json:"skuId"`
	Available int    `json:"available"`
}

type productSnapshot struct {
	ID       string `json:"id"`
	ShopID   string `json:"shopId"`
	Variants []struct {
		ID     string `json:"id"`
		Sku    string `json:"sku"`
		Status string `json:"status"`
	} `json:"variants"`
}

// ErrPermanent: lỗi dữ liệu không thể tự khỏi khi thử lại (vẫn đi DLQ để điều tra).
var ErrPermanent = errors.New("sự kiện không hợp lệ")

// HandleEvent định tuyến theo type, chạy idempotent qua inbox. Dùng làm kafka.Handler.
func (s *Service) HandleEvent(ctx context.Context, topic string, ev events.Envelope) error {
	var fn func(pgx.Tx) error
	switch ev.Type {
	case EvProductUpserted:
		var p productSnapshot
		if err := json.Unmarshal(ev.Data, &p); err != nil {
			return fmt.Errorf("%w: %v", ErrPermanent, err)
		}
		fn = func(tx pgx.Tx) error { return s.upsertProduct(ctx, tx, p) }
	case EvProductDeleted:
		var d struct {
			ProductID string `json:"productId"`
		}
		_ = json.Unmarshal(ev.Data, &d)
		if d.ProductID == "" {
			d.ProductID = ev.Subject
		}
		fn = func(tx pgx.Tx) error { return s.deleteProduct(ctx, tx, d.ProductID) }
	case CmdReserve:
		var c ReserveCmd
		if err := json.Unmarshal(ev.Data, &c); err != nil {
			return fmt.Errorf("%w: %v", ErrPermanent, err)
		}
		if c.ReservationID == "" {
			c.ReservationID = ev.Subject
		}
		fn = func(tx pgx.Tx) error { return s.reserve(ctx, tx, c) }
	case CmdCommit, CmdRelease:
		var c RefCmd
		if err := json.Unmarshal(ev.Data, &c); err != nil {
			return fmt.Errorf("%w: %v", ErrPermanent, err)
		}
		if c.ReservationID == "" {
			c.ReservationID = ev.Subject
		}
		if ev.Type == CmdCommit {
			fn = func(tx pgx.Tx) error { return s.commit(ctx, tx, c) }
		} else {
			fn = func(tx pgx.Tx) error { return s.release(ctx, tx, c) }
		}
	case CmdRestock:
		var c RestockCmd
		if err := json.Unmarshal(ev.Data, &c); err != nil {
			return fmt.Errorf("%w: %v", ErrPermanent, err)
		}
		if c.ReservationID == "" {
			c.ReservationID = ev.Subject
		}
		fn = func(tx pgx.Tx) error { return s.restock(ctx, tx, c) }
	default:
		return nil // sự kiện khác trên cùng topic → bỏ qua
	}
	fresh, err := events.ProcessOnce(ctx, s.pool, Consumer, ev.ID, fn)
	if err != nil {
		return err
	}
	if !fresh {
		s.log.DebugContext(ctx, "bỏ qua sự kiện trùng", "type", ev.Type, "eventId", ev.ID)
	}
	return nil
}

// ---- catalog ----

func (s *Service) upsertProduct(ctx context.Context, tx pgx.Tx, p productSnapshot) error {
	if p.ID == "" || p.ShopID == "" {
		return fmt.Errorf("%w: product.upserted thiếu id/shopId", ErrPermanent)
	}
	ids := make([]string, 0, len(p.Variants))
	b := &pgx.Batch{}
	for _, v := range p.Variants {
		if v.ID == "" {
			continue
		}
		ids = append(ids, v.ID)
		b.Queue(`INSERT INTO skus (sku_id, product_id, shop_id, sku_code, active) VALUES ($1, $2, $3, NULLIF($4, ''), $5)
			ON CONFLICT (sku_id) DO UPDATE SET product_id = EXCLUDED.product_id, shop_id = EXCLUDED.shop_id,
			  sku_code = EXCLUDED.sku_code, active = EXCLUDED.active, updated_at = now()`,
			v.ID, p.ID, p.ShopID, v.Sku, v.Status == "ACTIVE")
		b.Queue(`INSERT INTO stock (sku_id) VALUES ($1) ON CONFLICT DO NOTHING`, v.ID)
	}
	// Biến thể bị xoá khỏi sản phẩm → ngừng bán (giữ lịch sử tồn).
	b.Queue(`UPDATE skus SET active = false, updated_at = now() WHERE product_id = $1 AND active AND NOT (sku_id = ANY($2))`, p.ID, ids)
	return tx.SendBatch(ctx, b).Close()
}

func (s *Service) deleteProduct(ctx context.Context, tx pgx.Tx, productID string) error {
	if productID == "" {
		return fmt.Errorf("%w: product.deleted thiếu productId", ErrPermanent)
	}
	_, err := tx.Exec(ctx, `UPDATE skus SET active = false, updated_at = now() WHERE product_id = $1`, productID)
	return err
}

// ---- saga ----

func formatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// reserve: giữ TẤT CẢ hoặc KHÔNG món nào. Khoá dòng stock theo thứ tự sku_id để tránh deadlock.
func (s *Service) reserve(ctx context.Context, tx pgx.Tx, c ReserveCmd) error {
	if c.ReservationID == "" {
		return fmt.Errorf("%w: inventory.reserve thiếu reservationId", ErrPermanent)
	}
	// Reserve trùng reservationId → trả lại kết quả cũ.
	var (
		status, reason string
		expiresAt      *time.Time
		failedSkus     []string
	)
	err := tx.QueryRow(ctx, `SELECT status, COALESCE(reason, ''), expires_at, failed_sku_ids FROM reservations
		WHERE reservation_id = $1 FOR UPDATE`, c.ReservationID).Scan(&status, &reason, &expiresAt, &failedSkus)
	switch {
	case err == nil:
		metrics.ReserveTotal.WithLabelValues("duplicate").Inc()
		if status == StatusFailed {
			return s.emit(ctx, tx, EvReserveFailed, c.ReservationID, ReserveFailed{c.ReservationID, reason, nonNil(failedSkus)})
		}
		return s.emit(ctx, tx, EvReserved, c.ReservationID, Reserved{c.ReservationID, formatTime(*expiresAt)})
	case !errors.Is(err, pgx.ErrNoRows):
		return err
	}

	qty, invalid := aggregate(c.Items)
	if len(invalid) > 0 || len(qty) == 0 {
		return s.fail(ctx, tx, c, ReasonInvalidRequest, invalid)
	}
	skus := make([]string, 0, len(qty))
	for id := range qty {
		skus = append(skus, id)
	}
	sort.Strings(skus)

	sp, err := tx.Begin(ctx) // SAVEPOINT: hết hàng → rollback riêng phần giữ hàng, vẫn ghi FAILED + inbox
	if err != nil {
		return err
	}
	b := &pgx.Batch{}
	for _, id := range skus {
		b.Queue(`UPDATE stock s SET reserved = s.reserved + $2, version = s.version + 1, updated_at = now()
			FROM skus k WHERE s.sku_id = $1 AND k.sku_id = s.sku_id AND k.active AND s.on_hand - s.reserved >= $2
			RETURNING s.on_hand - s.reserved`, id, qty[id])
	}
	br := sp.SendBatch(ctx, b)
	var short []string
	changes := make([]StockChanged, 0, len(skus))
	for _, id := range skus {
		var avail int
		if err := br.QueryRow().Scan(&avail); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				_ = br.Close()
				_ = sp.Rollback(ctx)
				return err
			}
			short = append(short, id)
			continue
		}
		changes = append(changes, StockChanged{id, avail})
	}
	if err := br.Close(); err != nil {
		_ = sp.Rollback(ctx)
		return err
	}
	if len(short) > 0 {
		if err := sp.Rollback(ctx); err != nil {
			return err
		}
		return s.fail(ctx, tx, c, ReasonOutOfStock, short)
	}
	if err := sp.Commit(ctx); err != nil {
		return err
	}

	ttl := s.defaultTTL
	if c.TTLSeconds > 0 {
		ttl = time.Duration(c.TTLSeconds) * time.Second
	}
	exp := time.Now().Add(ttl).UTC().Truncate(time.Millisecond)
	if _, err := tx.Exec(ctx, `INSERT INTO reservations (reservation_id, order_ids, status, expires_at) VALUES ($1, $2, $3, $4)`,
		c.ReservationID, nonNil(c.OrderIDs), StatusReserved, exp); err != nil {
		return err
	}
	rows := make([][]any, 0, len(skus))
	for _, id := range skus {
		rows = append(rows, []any{c.ReservationID, id, qty[id]})
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"reservation_items"}, []string{"reservation_id", "sku_id", "qty"}, pgx.CopyFromRows(rows)); err != nil {
		return err
	}
	metrics.ReserveTotal.WithLabelValues("reserved").Inc()
	if err := s.emit(ctx, tx, EvReserved, c.ReservationID, Reserved{c.ReservationID, formatTime(exp)}); err != nil {
		return err
	}
	return s.emitStock(ctx, tx, changes)
}

func (s *Service) fail(ctx context.Context, tx pgx.Tx, c ReserveCmd, reason string, skus []string) error {
	skus = nonNil(skus)
	if _, err := tx.Exec(ctx, `INSERT INTO reservations (reservation_id, order_ids, status, reason, failed_sku_ids) VALUES ($1, $2, $3, $4, $5)`,
		c.ReservationID, nonNil(c.OrderIDs), StatusFailed, reason, skus); err != nil {
		return err
	}
	metrics.ReserveTotal.WithLabelValues("failed").Inc()
	return s.emit(ctx, tx, EvReserveFailed, c.ReservationID, ReserveFailed{c.ReservationID, reason, skus})
}

// aggregate gộp các dòng cùng SKU; trả danh sách SKU không hợp lệ (rỗng / qty ≤ 0).
func aggregate(items []ReserveItem) (map[string]int, []string) {
	qty := make(map[string]int, len(items))
	var invalid []string
	for _, it := range items {
		if it.SkuID == "" || it.Qty <= 0 || it.Qty > maxQty {
			invalid = append(invalid, it.SkuID)
			continue
		}
		qty[it.SkuID] += it.Qty
	}
	return qty, invalid
}

var ErrUnknownReservation = fmt.Errorf("%w: reservation không tồn tại", ErrPermanent)

func (s *Service) lockReservation(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM reservations WHERE reservation_id = $1 FOR UPDATE`, id).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnknownReservation
	}
	return status, err
}

// commit: trừ hẳn on_hand & reserved, ghi sổ xuất kho, COMMITTED.
func (s *Service) commit(ctx context.Context, tx pgx.Tx, c RefCmd) error {
	status, err := s.lockReservation(ctx, tx, c.ReservationID)
	if err != nil {
		return err // reservation lạ → thử lại rồi DLQ để điều tra
	}
	ref := map[string]string{"reservationId": c.ReservationID}
	switch status {
	case StatusCommitted:
		return s.emit(ctx, tx, EvCommitted, c.ReservationID, ref)
	case StatusExpired, StatusReleased:
		// Hàng đã nhả (vd thanh toán về sau khi hết hạn) → báo lại trạng thái thật để order huỷ + hoàn tiền.
		s.log.WarnContext(ctx, "commit reservation đã nhả", "reservationId", c.ReservationID, "status", status)
		typ := EvExpired
		if status == StatusReleased {
			typ = EvReleased
		}
		return s.emit(ctx, tx, typ, c.ReservationID, ref)
	case StatusFailed:
		s.log.WarnContext(ctx, "commit reservation giữ hàng thất bại — bỏ qua", "reservationId", c.ReservationID)
		return nil
	}

	items, err := reservationItems(ctx, tx, c.ReservationID)
	if err != nil {
		return err
	}
	b := &pgx.Batch{}
	for _, it := range items {
		b.Queue(`UPDATE stock SET on_hand = on_hand - $2, reserved = reserved - $2, version = version + 1, updated_at = now()
			WHERE sku_id = $1 RETURNING on_hand, on_hand - reserved`, it.SkuID, it.Qty)
	}
	br := tx.SendBatch(ctx, b)
	changes := make([]StockChanged, 0, len(items))
	mv := &pgx.Batch{}
	for _, it := range items {
		var onHand, avail int
		if err := br.QueryRow().Scan(&onHand, &avail); err != nil {
			_ = br.Close()
			return fmt.Errorf("commit %s/%s: %w", c.ReservationID, it.SkuID, err)
		}
		changes = append(changes, StockChanged{it.SkuID, avail})
		mv.Queue(`INSERT INTO stock_movements (sku_id, delta, on_hand_after, reason, ref) VALUES ($1, $2, $3, 'ORDER_COMMIT', $4)`,
			it.SkuID, -it.Qty, onHand, c.ReservationID)
	}
	if err := br.Close(); err != nil {
		return err
	}
	mv.Queue(`UPDATE reservations SET status = $2, updated_at = now() WHERE reservation_id = $1`, c.ReservationID, StatusCommitted)
	if err := tx.SendBatch(ctx, mv).Close(); err != nil {
		return err
	}
	if err := s.emit(ctx, tx, EvCommitted, c.ReservationID, ref); err != nil {
		return err
	}
	return s.emitStock(ctx, tx, changes)
}

// release: chỉ nhả khi còn RESERVED (theo hợp đồng). Đã RELEASED → phát lại released (idempotent).
func (s *Service) release(ctx context.Context, tx pgx.Tx, c RefCmd) error {
	status, err := s.lockReservation(ctx, tx, c.ReservationID)
	if errors.Is(err, ErrUnknownReservation) {
		s.log.WarnContext(ctx, "release reservation không tồn tại — bỏ qua", "reservationId", c.ReservationID)
		return nil
	}
	if err != nil {
		return err
	}
	payload := RefCmd{ReservationID: c.ReservationID, Reason: c.Reason}
	switch status {
	case StatusReserved:
		return s.freeReservation(ctx, tx, c.ReservationID, StatusReleased, c.Reason, EvReleased, payload)
	case StatusReleased:
		return s.emit(ctx, tx, EvReleased, c.ReservationID, payload)
	default:
		s.log.WarnContext(ctx, "release bỏ qua — reservation không còn RESERVED", "reservationId", c.ReservationID, "status", status)
		return nil
	}
}

// freeReservation trả phần reserved về available, đổi trạng thái, phát sự kiện + stock.changed.
func (s *Service) freeReservation(ctx context.Context, tx pgx.Tx, id, newStatus, reason, evType string, payload any) error {
	items, err := reservationItems(ctx, tx, id)
	if err != nil {
		return err
	}
	b := &pgx.Batch{}
	for _, it := range items {
		b.Queue(`UPDATE stock SET reserved = reserved - $2, version = version + 1, updated_at = now()
			WHERE sku_id = $1 RETURNING on_hand - reserved`, it.SkuID, it.Qty)
	}
	b.Queue(`UPDATE reservations SET status = $2, reason = NULLIF($3, ''), updated_at = now() WHERE reservation_id = $1`, id, newStatus, reason)
	br := tx.SendBatch(ctx, b)
	changes := make([]StockChanged, 0, len(items))
	for _, it := range items {
		var avail int
		if err := br.QueryRow().Scan(&avail); err != nil {
			_ = br.Close()
			return fmt.Errorf("nhả %s/%s: %w", id, it.SkuID, err)
		}
		changes = append(changes, StockChanged{it.SkuID, avail})
	}
	if err := br.Close(); err != nil {
		return err
	}
	if err := s.emit(ctx, tx, evType, id, payload); err != nil {
		return err
	}
	return s.emitStock(ctx, tx, changes)
}

func reservationItems(ctx context.Context, tx pgx.Tx, id string) ([]ReserveItem, error) {
	rows, err := tx.Query(ctx, `SELECT sku_id, qty FROM reservation_items WHERE reservation_id = $1 ORDER BY sku_id`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ReserveItem, error) {
		var it ReserveItem
		return it, r.Scan(&it.SkuID, &it.Qty)
	})
}

// ---- sweeper ----

// ExpireDue cho hết hạn tối đa limit reservation quá expires_at; mỗi cái một transaction,
// FOR UPDATE SKIP LOCKED → nhiều replica chạy song song không đụng nhau. Trả số đã xử lý.
func (s *Service) ExpireDue(ctx context.Context, limit int) (int, error) {
	n := 0
	for n < limit {
		done := false
		err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			var id string
			err := tx.QueryRow(ctx, `SELECT reservation_id FROM reservations WHERE status = 'RESERVED' AND expires_at <= now()
				ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id)
			if errors.Is(err, pgx.ErrNoRows) {
				done = true
				return nil
			}
			if err != nil {
				return err
			}
			return s.freeReservation(ctx, tx, id, StatusExpired, "EXPIRED", EvExpired, map[string]string{"reservationId": id})
		})
		if err != nil {
			return n, err
		}
		if done {
			return n, nil
		}
		n++
		metrics.ExpiredTotal.Inc()
	}
	return n, nil
}

// RunSweeper chạy ExpireDue định kỳ tới khi ctx huỷ.
func (s *Service) RunSweeper(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for {
			n, err := s.ExpireDue(ctx, 100)
			if err != nil {
				if ctx.Err() == nil {
					s.log.WarnContext(ctx, "sweeper lỗi", "err", err)
				}
				break
			}
			if n > 0 {
				s.log.InfoContext(ctx, "reservation hết hạn", "count", n)
			}
			if n < 100 {
				break
			}
		}
	}
}

// ---- outbox helpers ----

func (s *Service) emit(ctx context.Context, tx pgx.Tx, typ, subject string, data any) error {
	ev, err := events.New(ctx, typ, subject, data)
	if err != nil {
		return err
	}
	return events.Enqueue(ctx, tx, events.TopicInventoryEvent, ev)
}

func (s *Service) emitStock(ctx context.Context, tx pgx.Tx, changes []StockChanged) error {
	evs := make([]events.Envelope, 0, len(changes))
	for _, c := range changes {
		ev, err := events.New(ctx, EvStockChanged, c.SkuID, c)
		if err != nil {
			return err
		}
		evs = append(evs, ev)
	}
	return events.Enqueue(ctx, tx, events.TopicInventoryEvent, evs...)
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
