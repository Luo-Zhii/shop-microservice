package inventory

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Lỗi nghiệp vụ cho tầng HTTP.
var (
	ErrNotFound  = errors.New("không tìm thấy SKU")
	ErrForbidden = errors.New("SKU không thuộc shop của bạn")
)

// InsufficientStockError: onHand mới nhỏ hơn số đang giữ cho đơn.
type InsufficientStockError struct{ Reserved int }

func (e *InsufficientStockError) Error() string {
	return "onHand nhỏ hơn số đang giữ cho đơn"
}

type StockView struct {
	SkuID     string `json:"skuId"`
	OnHand    int    `json:"onHand"`
	Reserved  int    `json:"reserved"`
	Available int    `json:"available"`
}

type SellerStock struct {
	StockView
	ProductID string    `json:"productId"`
	Sku       *string   `json:"sku"`
	Active    bool      `json:"active"`
	Version   int64     `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// GetStock trả tồn theo thứ tự skuIds yêu cầu; SKU không tồn tại bị bỏ qua.
func (s *Service) GetStock(ctx context.Context, skuIDs []string) ([]StockView, error) {
	rows, err := s.pool.Query(ctx, `SELECT sku_id, on_hand, reserved FROM stock WHERE sku_id = ANY($1)`, skuIDs)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (StockView, error) {
		var v StockView
		err := r.Scan(&v.SkuID, &v.OnHand, &v.Reserved)
		v.Available = v.OnHand - v.Reserved
		return v, err
	})
	if err != nil {
		return nil, err
	}
	byID := make(map[string]StockView, len(found))
	for _, v := range found {
		byID[v.SkuID] = v
	}
	out := make([]StockView, 0, len(found))
	seen := make(map[string]bool, len(skuIDs))
	for _, id := range skuIDs {
		if v, ok := byID[id]; ok && !seen[id] {
			seen[id] = true
			out = append(out, v)
		}
	}
	return out, nil
}

// ListShopStock: tồn kho các SKU của shop (phân trang), lọc tuỳ chọn theo productId.
func (s *Service) ListShopStock(ctx context.Context, shopID, productID string, limit, offset int) ([]SellerStock, int, error) {
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM skus WHERE shop_id = $1 AND ($2::text = '' OR product_id = $2::text)`,
		shopID, productID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx, `SELECT k.sku_id, s.on_hand, s.reserved, k.product_id, k.sku_code, k.active, s.version, s.updated_at
		FROM skus k JOIN stock s ON s.sku_id = k.sku_id
		WHERE k.shop_id = $1 AND ($2::text = '' OR k.product_id = $2::text)
		ORDER BY k.product_id, k.sku_id LIMIT $3 OFFSET $4`, shopID, productID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (SellerStock, error) {
		var v SellerStock
		err := r.Scan(&v.SkuID, &v.OnHand, &v.Reserved, &v.ProductID, &v.Sku, &v.Active, &v.Version, &v.UpdatedAt)
		v.Available = v.OnHand - v.Reserved
		return v, err
	})
	return items, total, err
}

// SetOnHand: seller đặt lại số tồn thực tế. SKU phải thuộc shopID; onHand ≥ reserved; ghi sổ + stock.changed.
func (s *Service) SetOnHand(ctx context.Context, shopID, actor, skuID string, onHand int) (StockView, error) {
	var out StockView
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var owner string
		var old, reserved int
		err := tx.QueryRow(ctx, `SELECT k.shop_id, s.on_hand, s.reserved FROM skus k JOIN stock s ON s.sku_id = k.sku_id
			WHERE k.sku_id = $1 FOR UPDATE OF s`, skuID).Scan(&owner, &old, &reserved)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if owner != shopID {
			return ErrForbidden
		}
		if onHand < reserved {
			return &InsufficientStockError{Reserved: reserved}
		}
		out = StockView{SkuID: skuID, OnHand: onHand, Reserved: reserved, Available: onHand - reserved}
		if onHand == old {
			return nil
		}
		b := &pgx.Batch{}
		b.Queue(`UPDATE stock SET on_hand = $2, version = version + 1, updated_at = now() WHERE sku_id = $1`, skuID, onHand)
		b.Queue(`INSERT INTO stock_movements (sku_id, delta, on_hand_after, reason, ref, actor) VALUES ($1, $2, $3, 'MANUAL_ADJUST', 'seller', $4)`,
			skuID, onHand-old, onHand, actor)
		if err := tx.SendBatch(ctx, b).Close(); err != nil {
			return err
		}
		return s.emitStock(ctx, tx, []StockChanged{{skuID, out.Available}})
	})
	return out, err
}
