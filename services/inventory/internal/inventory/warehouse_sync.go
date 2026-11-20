package inventory

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// EvWarehouseStockChanged: kho sàn (ShopNow Fulfillment) báo tồn của SKU gửi kho thay đổi (nhận hàng, xuất, kiểm kê).
const EvWarehouseStockChanged = "warehouse.stock_changed"

// WarehouseStock = data của warehouse.stock_changed. Available = hàng bán được trong kho sàn
// (đã trừ hàng giữ cho phiếu lấy hàng và hàng cách ly QRT).
type WarehouseStock struct {
	ShopID    string `json:"shopId"`
	SkuID     string `json:"skuId"`
	OnHand    int    `json:"on_hand"`
	Available int    `json:"available"`
	Reason    string `json:"reason"`
}

// syncFromWarehouse đặt on_hand của SKU gửi kho = available của kho sàn.
//
// Vì sao không dùng on_hand của kho: đơn đã commit ở inventory (on_hand đã trừ) thì kho cũng đã giữ hàng đó cho phiếu
// lấy (reserved ở lô) → dùng available của kho thì không trừ hai lần. Hàng inventory đang giữ cho checkout (reserved) vẫn
// nằm trong available của kho, nên on_hand mới không được nhỏ hơn reserved; nếu nhỏ hơn (kiểm kê hụt) thì kẹp ở reserved
// và ghi movement WAREHOUSE_SHORT để đối soát — reservation đang chờ sẽ được xử lý khi hết hạn/huỷ.
func (s *Service) syncFromWarehouse(ctx context.Context, tx pgx.Tx, w WarehouseStock) error {
	var owner string
	var old, reserved int
	err := tx.QueryRow(ctx, `SELECT k.shop_id, s.on_hand, s.reserved FROM skus k JOIN stock s ON s.sku_id = k.sku_id
		WHERE k.sku_id = $1 FOR UPDATE OF s`, w.SkuID).Scan(&owner, &old, &reserved)
	if errors.Is(err, pgx.ErrNoRows) {
		s.log.WarnContext(ctx, "kho sàn báo SKU chưa đăng ký ở catalog — bỏ qua", "sku", w.SkuID, "shop", w.ShopID)
		return nil
	}
	if err != nil {
		return err
	}
	if owner != w.ShopID {
		s.log.WarnContext(ctx, "kho sàn báo SKU khác shop — bỏ qua", "sku", w.SkuID, "owner", owner, "shop", w.ShopID)
		return nil
	}
	target, reason := w.Available, "WAREHOUSE_SYNC"
	if target < reserved {
		target, reason = reserved, "WAREHOUSE_SHORT"
	}
	if target == old {
		return nil
	}
	b := &pgx.Batch{}
	b.Queue(`UPDATE stock SET on_hand = $2, version = version + 1, updated_at = now() WHERE sku_id = $1`, w.SkuID, target)
	b.Queue(`INSERT INTO stock_movements (sku_id, delta, on_hand_after, reason, ref, actor) VALUES ($1, $2, $3, $4, $5, 'warehouse')`,
		w.SkuID, target-old, target, reason, w.Reason)
	if err := tx.SendBatch(ctx, b).Close(); err != nil {
		return err
	}
	return s.emitStock(ctx, tx, []StockChanged{{w.SkuID, target - reserved}})
}
