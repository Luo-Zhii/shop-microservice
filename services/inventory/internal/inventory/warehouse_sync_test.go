package inventory

import (
	"testing"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/events"
)

// Kho sàn báo tồn → on_hand theo available của kho; không nhỏ hơn reserved; SKU khác shop / chưa đăng ký bị bỏ qua.
func TestWarehouseStockSync(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"wh-a": 0})
	ws := func(shop, sku string, avail int) events.Envelope {
		return f.envelope(EvWarehouseStockChanged, sku, WarehouseStock{ShopID: shop, SkuID: sku, OnHand: avail + 1, Available: avail, Reason: "receipt"})
	}
	f.handle(events.TopicWarehouse, ws("shop-1", "wh-a", 19))
	if oh, _ := f.stock("wh-a"); oh != 19 {
		t.Fatalf("on_hand phải = available kho 19, có %d", oh)
	}
	if got := f.outbox(EvStockChanged); len(got) == 0 {
		t.Fatal("phải phát stock.changed sau khi đồng bộ")
	}
	// checkout giữ 5 → kho kiểm kê hụt còn 3 → kẹp ở reserved, ghi WAREHOUSE_SHORT
	f.command(CmdReserve, reserveCmd("r-wh", ReserveItem{SkuID: "wh-a", Qty: 5}))
	f.handle(events.TopicWarehouse, ws("shop-1", "wh-a", 3))
	if oh, r := f.stock("wh-a"); oh != 5 || r != 5 {
		t.Fatalf("on_hand phải kẹp ở reserved 5, có %d/%d", oh, r)
	}
	var reason string
	if err := f.pool.QueryRow(f.ctx, "SELECT reason FROM stock_movements WHERE sku_id = 'wh-a' ORDER BY id DESC LIMIT 1").Scan(&reason); err != nil || reason != "WAREHOUSE_SHORT" {
		t.Fatalf("movement cuối phải WAREHOUSE_SHORT, có %q (%v)", reason, err)
	}
	// shop khác / SKU lạ → không đổi
	f.handle(events.TopicWarehouse, ws("shop-khac", "wh-a", 100))
	f.handle(events.TopicWarehouse, ws("shop-1", "khong-co", 100))
	if oh, _ := f.stock("wh-a"); oh != 5 {
		t.Fatalf("sự kiện sai shop không được đổi tồn, có %d", oh)
	}
}
