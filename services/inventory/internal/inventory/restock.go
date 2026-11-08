package inventory

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

const (
	CmdRestock     = "inventory.restock"
	EvRestocked    = "inventory.restocked"
	ReasonCancel   = "BUYER_CANCELLED"
	ReasonReturned = "RETURNED"
)

// RestockCmd: trả hàng của một order (thuộc reservation đã COMMITTED) về on_hand.
type RestockCmd struct {
	ReservationID string        `json:"reservationId"`
	OrderID       string        `json:"orderId"`
	Items         []ReserveItem `json:"items"`
	Reason        string        `json:"reason"`
}

type Restocked struct {
	ReservationID string `json:"reservationId"`
	OrderID       string `json:"orderId"`
}

// restock: idempotent theo (reservationId, orderId). Tổng số trả của mỗi SKU (qua mọi order) không vượt số đã commit.
func (s *Service) restock(ctx context.Context, tx pgx.Tx, c RestockCmd) error {
	if c.ReservationID == "" || c.OrderID == "" {
		return fmt.Errorf("%w: inventory.restock thiếu reservationId/orderId", ErrPermanent)
	}
	if c.Reason != ReasonCancel && c.Reason != ReasonReturned {
		return fmt.Errorf("%w: reason %q không hợp lệ", ErrPermanent, c.Reason)
	}
	status, err := s.lockReservation(ctx, tx, c.ReservationID) // khoá reservation → các restock cùng reservation chạy tuần tự
	if err != nil {
		return err
	}
	done := Restocked{c.ReservationID, c.OrderID}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM reservation_restocks WHERE reservation_id = $1 AND order_id = $2)`,
		c.ReservationID, c.OrderID).Scan(&exists); err != nil {
		return err
	}
	if exists { // gửi lại → phát lại kết quả, không cộng kho lần nữa
		return s.emit(ctx, tx, EvRestocked, c.ReservationID, done)
	}
	if status != StatusCommitted {
		return fmt.Errorf("%w: restock chỉ cho reservation COMMITTED (đang %s)", ErrPermanent, status)
	}
	qty, invalid := aggregate(c.Items)
	if len(invalid) > 0 || len(qty) == 0 {
		return fmt.Errorf("%w: items restock không hợp lệ", ErrPermanent)
	}

	// Còn được trả = đã commit − đã trả trước đó.
	rows, err := tx.Query(ctx, `SELECT i.sku_id, i.qty - COALESCE((SELECT sum(r.qty) FROM reservation_restock_items r
			WHERE r.reservation_id = i.reservation_id AND r.sku_id = i.sku_id), 0)
		FROM reservation_items i WHERE i.reservation_id = $1`, c.ReservationID)
	if err != nil {
		return err
	}
	remaining := map[string]int{}
	for rows.Next() {
		var sku string
		var n int
		if err := rows.Scan(&sku, &n); err != nil {
			rows.Close()
			return err
		}
		remaining[sku] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	skus := make([]string, 0, len(qty))
	for sku, n := range qty {
		if n > remaining[sku] {
			return fmt.Errorf("%w: SKU %s trả %d vượt số còn lại %d", ErrPermanent, sku, n, remaining[sku])
		}
		skus = append(skus, sku)
	}
	sort.Strings(skus)

	b := &pgx.Batch{}
	b.Queue(`INSERT INTO reservation_restocks (reservation_id, order_id, reason) VALUES ($1, $2, $3)`, c.ReservationID, c.OrderID, c.Reason)
	for _, sku := range skus {
		b.Queue(`INSERT INTO reservation_restock_items (reservation_id, order_id, sku_id, qty) VALUES ($1, $2, $3, $4)`,
			c.ReservationID, c.OrderID, sku, qty[sku])
		b.Queue(`UPDATE stock SET on_hand = on_hand + $2, version = version + 1, updated_at = now()
			WHERE sku_id = $1 RETURNING on_hand, on_hand - reserved`, sku, qty[sku])
	}
	br := tx.SendBatch(ctx, b)
	if _, err := br.Exec(); err != nil {
		_ = br.Close()
		return err
	}
	changes := make([]StockChanged, 0, len(skus))
	mv := &pgx.Batch{}
	for _, sku := range skus {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return err
		}
		var onHand, avail int
		if err := br.QueryRow().Scan(&onHand, &avail); err != nil {
			_ = br.Close()
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("%w: không có dòng stock cho %s", ErrPermanent, sku)
			}
			return err
		}
		changes = append(changes, StockChanged{sku, avail})
		mv.Queue(`INSERT INTO stock_movements (sku_id, delta, on_hand_after, reason, ref) VALUES ($1, $2, $3, $4, $5)`,
			sku, qty[sku], onHand, "RESTOCK_"+c.Reason, c.ReservationID+"/"+c.OrderID)
	}
	if err := br.Close(); err != nil {
		return err
	}
	if err := tx.SendBatch(ctx, mv).Close(); err != nil {
		return err
	}
	if err := s.emit(ctx, tx, EvRestocked, c.ReservationID, done); err != nil {
		return err
	}
	return s.emitStock(ctx, tx, changes)
}
