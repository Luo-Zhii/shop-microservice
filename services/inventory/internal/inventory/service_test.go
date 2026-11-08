package inventory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/events"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/testutil"
)

type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	svc  *Service
	ctx  context.Context
}

func setup(t *testing.T) *fixture {
	p := testutil.DB(t, "")
	return &fixture{t: t, pool: p, svc: New(p, testutil.Logger(), time.Minute), ctx: context.Background()}
}

func (f *fixture) envelope(typ, subject string, data any) events.Envelope {
	f.t.Helper()
	ev, err := events.New(f.ctx, typ, subject, data)
	if err != nil {
		f.t.Fatal(err)
	}
	return ev
}

func (f *fixture) handle(topic string, ev events.Envelope) {
	f.t.Helper()
	if err := f.svc.HandleEvent(f.ctx, topic, ev); err != nil {
		f.t.Fatalf("%s: %v", ev.Type, err)
	}
}

func (f *fixture) command(typ string, data any) {
	f.t.Helper()
	f.handle(events.TopicInventoryCommand, f.envelope(typ, "", data))
}

func (f *fixture) product(id, shop string, variants ...[2]string) {
	f.t.Helper()
	vs := make([]map[string]any, 0, len(variants))
	for _, v := range variants {
		vs = append(vs, map[string]any{"id": v[0], "sku": "SKU-" + v[0], "status": v[1], "price": 1000})
	}
	f.handle(events.TopicCatalogProduct, f.envelope(EvProductUpserted, id,
		map[string]any{"id": id, "shopId": shop, "title": "Áo thun", "status": "APPROVED", "variants": vs}))
}

// seed: SKU đang bán của shop-1 với on_hand cho trước.
func (f *fixture) seed(onHand map[string]int) {
	f.t.Helper()
	for sku, n := range onHand {
		f.product("p-"+sku, "shop-1", [2]string{sku, "ACTIVE"})
		if _, err := f.svc.SetOnHand(f.ctx, "shop-1", "seller-1", sku, n); err != nil {
			f.t.Fatal(err)
		}
	}
	f.exec("DELETE FROM outbox")
}

func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) stock(sku string) (onHand, reserved int) {
	f.t.Helper()
	if err := f.pool.QueryRow(f.ctx, "SELECT on_hand, reserved FROM stock WHERE sku_id = $1", sku).Scan(&onHand, &reserved); err != nil {
		f.t.Fatal(err)
	}
	return
}

func (f *fixture) status(resID string) string {
	f.t.Helper()
	var s string
	if err := f.pool.QueryRow(f.ctx, "SELECT status FROM reservations WHERE reservation_id = $1", resID).Scan(&s); err != nil {
		f.t.Fatal(err)
	}
	return s
}

// outbox trả các phong bì đã ghi theo type (theo thứ tự ghi).
func (f *fixture) outbox(typ string) []events.Envelope {
	f.t.Helper()
	rows, err := f.pool.Query(f.ctx, "SELECT topic, key, payload FROM outbox WHERE payload->>'type' = $1 ORDER BY created_at, id", typ)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out []events.Envelope
	for rows.Next() {
		var topic, key string
		var raw []byte
		if err := rows.Scan(&topic, &key, &raw); err != nil {
			f.t.Fatal(err)
		}
		var ev events.Envelope
		if err := json.Unmarshal(raw, &ev); err != nil {
			f.t.Fatal(err)
		}
		if topic != events.TopicInventoryEvent || key != ev.Subject {
			f.t.Fatalf("outbox sai topic/key: %s %s (subject %s)", topic, key, ev.Subject)
		}
		out = append(out, ev)
	}
	return out
}

func decode[T any](t *testing.T, ev events.Envelope) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(ev.Data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func reserveCmd(id string, items ...ReserveItem) ReserveCmd {
	return ReserveCmd{ReservationID: id, OrderIDs: []string{"order-" + id}, Items: items, TTLSeconds: 900}
}

func TestProductUpsertRegistersSkus(t *testing.T) {
	f := setup(t)
	f.product("p1", "shop-1", [2]string{"a", "ACTIVE"}, [2]string{"b", "INACTIVE"})
	var n, active int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*), count(*) FILTER (WHERE active) FROM skus WHERE product_id = 'p1'").Scan(&n, &active); err != nil {
		t.Fatal(err)
	}
	if n != 2 || active != 1 {
		t.Fatalf("muốn 2 SKU (1 active), có %d (%d active)", n, active)
	}
	if oh, r := f.stock("a"); oh != 0 || r != 0 {
		t.Fatalf("stock mới phải = 0, có %d/%d", oh, r)
	}
	// Bản snapshot mới bỏ biến thể a → a ngừng bán; b bật lại.
	f.product("p1", "shop-1", [2]string{"b", "ACTIVE"})
	var aActive, bActive bool
	_ = f.pool.QueryRow(f.ctx, "SELECT (SELECT active FROM skus WHERE sku_id='a'), (SELECT active FROM skus WHERE sku_id='b')").Scan(&aActive, &bActive)
	if aActive || !bActive {
		t.Fatalf("a phải inactive, b active; có a=%v b=%v", aActive, bActive)
	}
	f.handle(events.TopicCatalogProduct, f.envelope(EvProductDeleted, "p1", map[string]string{"productId": "p1"}))
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FILTER (WHERE active) FROM skus WHERE product_id = 'p1'").Scan(&active); err != nil || active != 0 {
		t.Fatalf("product.deleted phải tắt hết SKU, còn %d", active)
	}
}

func TestReserveAllOrNothing(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 5, "b": 1})

	f.command(CmdReserve, reserveCmd("r1", ReserveItem{"a", 2}, ReserveItem{"b", 2}))
	failed := f.outbox(EvReserveFailed)
	if len(failed) != 1 {
		t.Fatalf("muốn 1 reserve_failed, có %d", len(failed))
	}
	d := decode[ReserveFailed](t, failed[0])
	if d.ReservationID != "r1" || d.Reason != ReasonOutOfStock || len(d.SkuIDs) != 1 || d.SkuIDs[0] != "b" {
		t.Fatalf("payload reserve_failed sai: %+v", d)
	}
	if _, r := f.stock("a"); r != 0 {
		t.Fatalf("all-or-nothing: a không được giữ, reserved=%d", r)
	}
	if s := f.status("r1"); s != StatusFailed {
		t.Fatalf("status = %s", s)
	}
	if n := len(f.outbox(EvStockChanged)); n != 0 {
		t.Fatalf("thất bại không được phát stock.changed (%d)", n)
	}

	// Dòng trùng SKU được gộp: a 1 + a 1 = 2.
	f.command(CmdReserve, reserveCmd("r2", ReserveItem{"b", 1}, ReserveItem{"a", 1}, ReserveItem{"a", 1}))
	ok := f.outbox(EvReserved)
	if len(ok) != 1 {
		t.Fatalf("muốn 1 reserved, có %d", len(ok))
	}
	res := decode[Reserved](t, ok[0])
	exp, err := time.Parse(time.RFC3339, res.ExpiresAt)
	if res.ReservationID != "r2" || err != nil || time.Until(exp) < 14*time.Minute {
		t.Fatalf("payload reserved sai: %+v (%v)", res, err)
	}
	if oh, r := f.stock("a"); oh != 5 || r != 2 {
		t.Fatalf("a = %d/%d", oh, r)
	}
	if _, r := f.stock("b"); r != 1 {
		t.Fatalf("b reserved = %d", r)
	}
	avail := map[string]int{}
	for _, ev := range f.outbox(EvStockChanged) {
		sc := decode[StockChanged](t, ev)
		avail[sc.SkuID] = sc.Available
	}
	if avail["a"] != 3 || avail["b"] != 0 || len(avail) != 2 {
		t.Fatalf("stock.changed sai: %v", avail)
	}
}

func TestReserveInvalidAndInactive(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 5})
	f.command(CmdReserve, reserveCmd("bad", ReserveItem{"a", 0}))
	if d := decode[ReserveFailed](t, f.outbox(EvReserveFailed)[0]); d.Reason != ReasonInvalidRequest {
		t.Fatalf("qty 0 phải INVALID_REQUEST, có %+v", d)
	}
	f.product("p-a", "shop-1", [2]string{"a", "INACTIVE"})
	f.command(CmdReserve, reserveCmd("r-inactive", ReserveItem{"a", 1}))
	f.command(CmdReserve, reserveCmd("r-unknown", ReserveItem{"zzz", 1}))
	if n := len(f.outbox(EvReserveFailed)); n != 3 {
		t.Fatalf("SKU ngừng bán / không tồn tại phải thất bại, có %d reserve_failed", n)
	}
}

func TestReserveDuplicateReservationReturnsPreviousResult(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 3})
	f.command(CmdReserve, reserveCmd("r1", ReserveItem{"a", 2}))
	// Lệnh khác (event id khác) nhưng cùng reservationId, vd order gửi lại.
	f.command(CmdReserve, reserveCmd("r1", ReserveItem{"a", 2}))
	ok := f.outbox(EvReserved)
	if len(ok) != 2 {
		t.Fatalf("muốn phát lại reserved, có %d", len(ok))
	}
	if a, b := decode[Reserved](t, ok[0]), decode[Reserved](t, ok[1]); a != b {
		t.Fatalf("kết quả cũ phải giống hệt: %+v vs %+v", a, b)
	}
	if _, r := f.stock("a"); r != 2 {
		t.Fatalf("không được giữ 2 lần, reserved=%d", r)
	}
	// Thất bại cũng trả lại thất bại cũ (dù giờ đã đủ hàng).
	f.command(CmdReserve, reserveCmd("r2", ReserveItem{"a", 5}))
	f.exec("UPDATE stock SET on_hand = 100 WHERE sku_id = 'a'")
	f.command(CmdReserve, reserveCmd("r2", ReserveItem{"a", 5}))
	if n := len(f.outbox(EvReserveFailed)); n != 2 {
		t.Fatalf("muốn 2 reserve_failed, có %d", n)
	}
	if _, r := f.stock("a"); r != 2 {
		t.Fatalf("reserved=%d", r)
	}
}

func TestDuplicateEventProcessedOnce(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 10})
	ev := f.envelope(CmdReserve, "r1", reserveCmd("r1", ReserveItem{"a", 4}))
	for range 3 {
		f.handle(events.TopicInventoryCommand, ev) // Kafka giao lại cùng message
	}
	commit := f.envelope(CmdCommit, "r1", RefCmd{ReservationID: "r1"})
	f.handle(events.TopicInventoryCommand, commit)
	f.handle(events.TopicInventoryCommand, commit)
	if n := len(f.outbox(EvReserved)); n != 1 {
		t.Fatalf("reserve trùng event id chỉ được xử lý 1 lần, có %d reserved", n)
	}
	if n := len(f.outbox(EvCommitted)); n != 1 {
		t.Fatalf("commit trùng event id chỉ được xử lý 1 lần, có %d committed", n)
	}
	if oh, r := f.stock("a"); oh != 6 || r != 0 {
		t.Fatalf("a = %d/%d, muốn 6/0", oh, r)
	}
	var processed int
	_ = f.pool.QueryRow(f.ctx, "SELECT count(*) FROM processed_events WHERE consumer = 'inventory' AND event_id LIKE 'inventory:%'").Scan(&processed)
	if processed != 3 { // product.upserted (seed) + reserve + commit
		t.Fatalf("processed_events = %d, muốn 3", processed)
	}
}

func TestCommit(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 5, "b": 2})
	f.command(CmdReserve, reserveCmd("r1", ReserveItem{"a", 3}, ReserveItem{"b", 2}))
	f.command(CmdCommit, RefCmd{ReservationID: "r1"})
	if s := f.status("r1"); s != StatusCommitted {
		t.Fatalf("status = %s", s)
	}
	if oh, r := f.stock("a"); oh != 2 || r != 0 {
		t.Fatalf("a = %d/%d, muốn 2/0", oh, r)
	}
	if oh, r := f.stock("b"); oh != 0 || r != 0 {
		t.Fatalf("b = %d/%d, muốn 0/0", oh, r)
	}
	var delta, after int
	if err := f.pool.QueryRow(f.ctx, "SELECT delta, on_hand_after FROM stock_movements WHERE sku_id='a' AND reason='ORDER_COMMIT' AND ref='r1'").Scan(&delta, &after); err != nil || delta != -3 || after != 2 {
		t.Fatalf("stock_movements sai: delta=%d after=%d err=%v", delta, after, err)
	}
	committed := f.outbox(EvCommitted)
	if len(committed) != 1 || committed[0].Subject != "r1" {
		t.Fatalf("committed = %+v", committed)
	}
	// Commit lại (lệnh mới) → idempotent, không trừ kho lần nữa.
	f.command(CmdCommit, RefCmd{ReservationID: "r1"})
	if oh, _ := f.stock("a"); oh != 2 {
		t.Fatalf("commit lần 2 trừ kho: on_hand=%d", oh)
	}
	if n := len(f.outbox(EvCommitted)); n != 2 {
		t.Fatalf("muốn phát lại committed, có %d", n)
	}
	// Release sau khi đã COMMITTED → không nhả (hợp đồng: chỉ nhả khi còn RESERVED).
	f.command(CmdRelease, RefCmd{ReservationID: "r1", Reason: "CANCELLED"})
	if s := f.status("r1"); s != StatusCommitted || len(f.outbox(EvReleased)) != 0 {
		t.Fatalf("release sau commit không được đổi gì: %s", s)
	}
	// Commit reservation lạ → lỗi (đi DLQ).
	err := f.svc.HandleEvent(f.ctx, events.TopicInventoryCommand, f.envelope(CmdCommit, "nope", RefCmd{ReservationID: "nope"}))
	if !errors.Is(err, ErrUnknownReservation) {
		t.Fatalf("muốn ErrUnknownReservation, có %v", err)
	}
}

func TestRelease(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 5})
	f.command(CmdReserve, reserveCmd("r1", ReserveItem{"a", 4}))
	f.command(CmdRelease, RefCmd{ReservationID: "r1", Reason: "PAYMENT_FAILED"})
	if s := f.status("r1"); s != StatusReleased {
		t.Fatalf("status = %s", s)
	}
	if oh, r := f.stock("a"); oh != 5 || r != 0 {
		t.Fatalf("a = %d/%d", oh, r)
	}
	rel := f.outbox(EvReleased)
	if len(rel) != 1 || decode[RefCmd](t, rel[0]).Reason != "PAYMENT_FAILED" {
		t.Fatalf("released = %+v", rel)
	}
	f.command(CmdRelease, RefCmd{ReservationID: "r1"})
	if _, r := f.stock("a"); r != 0 || len(f.outbox(EvReleased)) != 2 {
		t.Fatalf("release lần 2 phải idempotent (reserved=%d)", r)
	}
	f.command(CmdRelease, RefCmd{ReservationID: "khong-co"}) // reservation lạ → bỏ qua, không lỗi
}

func TestExpire(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 5})
	f.command(CmdReserve, reserveCmd("r1", ReserveItem{"a", 2}))
	f.command(CmdReserve, reserveCmd("r2", ReserveItem{"a", 1}))
	f.exec("UPDATE reservations SET expires_at = now() - interval '1 second' WHERE reservation_id = 'r1'")

	n, err := f.svc.ExpireDue(f.ctx, 100)
	if err != nil || n != 1 {
		t.Fatalf("ExpireDue = %d, %v", n, err)
	}
	if s := f.status("r1"); s != StatusExpired {
		t.Fatalf("status = %s", s)
	}
	if s := f.status("r2"); s != StatusReserved {
		t.Fatalf("r2 chưa hết hạn mà status = %s", s)
	}
	if _, r := f.stock("a"); r != 1 {
		t.Fatalf("reserved = %d, muốn 1", r)
	}
	exp := f.outbox(EvExpired)
	if len(exp) != 1 || decode[RefCmd](t, exp[0]).ReservationID != "r1" {
		t.Fatalf("expired = %+v", exp)
	}
	if n, _ := f.svc.ExpireDue(f.ctx, 100); n != 0 {
		t.Fatalf("lần 2 không được hết hạn lại (%d)", n)
	}
	// Thanh toán về muộn → commit reservation đã hết hạn: không trừ kho, báo lại expired.
	f.command(CmdCommit, RefCmd{ReservationID: "r1"})
	if oh, r := f.stock("a"); oh != 5 || r != 1 || len(f.outbox(EvExpired)) != 2 {
		t.Fatalf("commit sau hết hạn sai: %d/%d", oh, r)
	}
}

func TestSweeperSafeAcrossReplicas(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 100})
	for i := range 20 {
		f.command(CmdReserve, reserveCmd(fmt.Sprintf("r%02d", i), ReserveItem{"a", 1}))
	}
	f.exec("UPDATE reservations SET expires_at = now() - interval '1 second'")
	var wg sync.WaitGroup
	counts := make([]int, 3)
	for i := range counts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n, err := f.svc.ExpireDue(f.ctx, 100)
			if err != nil {
				t.Error(err)
			}
			counts[i] = n
		}()
	}
	wg.Wait()
	if total := counts[0] + counts[1] + counts[2]; total != 20 {
		t.Fatalf("3 sweeper song song phải hết hạn đúng 20, có %v", counts)
	}
	if n := len(f.outbox(EvExpired)); n != 20 {
		t.Fatalf("inventory.expired = %d", n)
	}
	if _, r := f.stock("a"); r != 0 {
		t.Fatalf("reserved = %d", r)
	}
}

// 50 goroutine cùng giữ 1 đơn vị khi tồn = 10 → đúng 10 thành công, không âm kho.
func TestConcurrentReserveNeverOversells(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"hot": 10})
	const workers = 50
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ev, _ := events.New(f.ctx, CmdReserve, "", reserveCmd(fmt.Sprintf("c%02d", i), ReserveItem{"hot", 1}))
			if err := f.svc.HandleEvent(f.ctx, events.TopicInventoryCommand, ev); err != nil {
				t.Error(err)
			}
		}()
	}
	close(start)
	wg.Wait()
	ok, failed := len(f.outbox(EvReserved)), len(f.outbox(EvReserveFailed))
	oh, r := f.stock("hot")
	t.Logf("đồng thời %d goroutine: %d reserved, %d reserve_failed, on_hand=%d reserved=%d", workers, ok, failed, oh, r)
	if ok != 10 || failed != 40 {
		t.Fatalf("muốn đúng 10 thành công / 40 thất bại, có %d / %d", ok, failed)
	}
	if oh != 10 || r != 10 || oh-r < 0 {
		t.Fatalf("tồn sai: on_hand=%d reserved=%d", oh, r)
	}
	var reservedRows int
	_ = f.pool.QueryRow(f.ctx, "SELECT count(*) FROM reservations WHERE status = 'RESERVED'").Scan(&reservedRows)
	if reservedRows != 10 {
		t.Fatalf("reservations RESERVED = %d", reservedRows)
	}
}

// Nhiều đơn giữ cùng 2 SKU theo thứ tự ngược nhau → không deadlock (khoá theo thứ tự sku_id).
func TestConcurrentMultiSkuNoDeadlock(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"x": 15, "y": 15})
	var wg sync.WaitGroup
	for i := range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			items := []ReserveItem{{"x", 1}, {"y", 1}}
			if i%2 == 1 {
				items = []ReserveItem{{"y", 1}, {"x", 1}}
			}
			ev, _ := events.New(f.ctx, CmdReserve, "", reserveCmd(fmt.Sprintf("m%02d", i), items...))
			if err := f.svc.HandleEvent(f.ctx, events.TopicInventoryCommand, ev); err != nil {
				t.Error(err) // deadlock_detected sẽ hiện ở đây
			}
		}()
	}
	wg.Wait()
	_, rx := f.stock("x")
	_, ry := f.stock("y")
	if ok := len(f.outbox(EvReserved)); ok != 15 || rx != 15 || ry != 15 {
		t.Fatalf("muốn 15 reserved, x=y=15; có %d, x=%d y=%d", ok, rx, ry)
	}
}

func TestSetOnHand(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 5})
	f.command(CmdReserve, reserveCmd("r1", ReserveItem{"a", 3}))
	f.exec("DELETE FROM outbox")

	var insufficient *InsufficientStockError
	if _, err := f.svc.SetOnHand(f.ctx, "shop-1", "u1", "a", 2); !errors.As(err, &insufficient) || insufficient.Reserved != 3 {
		t.Fatalf("onHand < reserved phải lỗi, có %v", err)
	}
	if _, err := f.svc.SetOnHand(f.ctx, "shop-2", "u2", "a", 50); !errors.Is(err, ErrForbidden) {
		t.Fatalf("shop khác phải ErrForbidden, có %v", err)
	}
	if _, err := f.svc.SetOnHand(f.ctx, "shop-1", "u1", "nope", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("muốn ErrNotFound, có %v", err)
	}
	v, err := f.svc.SetOnHand(f.ctx, "shop-1", "u1", "a", 8)
	if err != nil || v.Available != 5 || v.Reserved != 3 {
		t.Fatalf("SetOnHand = %+v, %v", v, err)
	}
	var delta int
	var actor string
	_ = f.pool.QueryRow(f.ctx, "SELECT delta, actor FROM stock_movements WHERE sku_id='a' ORDER BY id DESC LIMIT 1").Scan(&delta, &actor)
	if delta != 3 || actor != "u1" {
		t.Fatalf("movement delta=%d actor=%s", delta, actor)
	}
	sc := f.outbox(EvStockChanged)
	if len(sc) != 1 || decode[StockChanged](t, sc[0]).Available != 5 {
		t.Fatalf("stock.changed = %+v", sc)
	}
}

func TestRestock(t *testing.T) {
	f := setup(t)
	f.seed(map[string]int{"a": 10, "b": 5})
	// Checkout 2 shop: order o1 lấy a×3, order o2 lấy b×2.
	f.command(CmdReserve, ReserveCmd{ReservationID: "r1", OrderIDs: []string{"o1", "o2"}, TTLSeconds: 900,
		Items: []ReserveItem{{"a", 3}, {"b", 2}}})
	f.command(CmdCommit, RefCmd{ReservationID: "r1"})
	f.exec("DELETE FROM outbox")

	restock := RestockCmd{ReservationID: "r1", OrderID: "o1", Items: []ReserveItem{{"a", 3}}, Reason: ReasonCancel}
	ev := f.envelope(CmdRestock, "r1", restock)
	f.handle(events.TopicInventoryCommand, ev)
	f.handle(events.TopicInventoryCommand, ev) // cùng event id → inbox chặn
	f.command(CmdRestock, restock)             // lệnh mới, cùng (reservationId, orderId) → không cộng lần 2
	if oh, r := f.stock("a"); oh != 10 || r != 0 {
		t.Fatalf("a sau restock = %d/%d, muốn 10/0", oh, r)
	}
	if oh, _ := f.stock("b"); oh != 3 {
		t.Fatalf("b không thuộc o1 nên giữ nguyên 3, có %d", oh)
	}
	done := f.outbox(EvRestocked)
	if len(done) != 2 || decode[Restocked](t, done[0]) != (Restocked{"r1", "o1"}) || done[0].Subject != "r1" {
		t.Fatalf("restocked = %+v", done)
	}
	sc := f.outbox(EvStockChanged)
	if len(sc) != 1 || decode[StockChanged](t, sc[0]) != (StockChanged{"a", 10}) {
		t.Fatalf("stock.changed = %+v", sc)
	}
	var delta int
	var reason, ref string
	_ = f.pool.QueryRow(f.ctx, "SELECT delta, reason, ref FROM stock_movements WHERE sku_id='a' ORDER BY id DESC LIMIT 1").Scan(&delta, &reason, &ref)
	if delta != 3 || reason != "RESTOCK_BUYER_CANCELLED" || ref != "r1/o1" {
		t.Fatalf("movement = %d %s %s", delta, reason, ref)
	}
	if s := f.status("r1"); s != StatusCommitted {
		t.Fatalf("restock không đổi trạng thái reservation, có %s", s)
	}

	// Trả hàng order o2 một phần, rồi vượt số đã commit → lỗi (DLQ), kho không đổi.
	f.command(CmdRestock, RestockCmd{ReservationID: "r1", OrderID: "o2", Items: []ReserveItem{{"b", 1}}, Reason: ReasonReturned})
	if oh, _ := f.stock("b"); oh != 4 {
		t.Fatalf("b = %d, muốn 4", oh)
	}
	for _, bad := range []RestockCmd{
		{ReservationID: "r1", OrderID: "o3", Items: []ReserveItem{{"b", 2}}, Reason: ReasonReturned}, // còn lại 1
		{ReservationID: "r1", OrderID: "o4", Items: []ReserveItem{{"zzz", 1}}, Reason: ReasonReturned},
		{ReservationID: "r1", OrderID: "o5", Items: []ReserveItem{{"a", 1}}, Reason: "LOST"},
		{ReservationID: "nope", OrderID: "o1", Items: []ReserveItem{{"a", 1}}, Reason: ReasonCancel},
	} {
		err := f.svc.HandleEvent(f.ctx, events.TopicInventoryCommand, f.envelope(CmdRestock, bad.ReservationID, bad))
		if !errors.Is(err, ErrPermanent) {
			t.Fatalf("%+v phải lỗi ErrPermanent, có %v", bad, err)
		}
	}
	if oh, _ := f.stock("b"); oh != 4 {
		t.Fatalf("restock lỗi không được đổi kho, b = %d", oh)
	}

	// Reservation chưa commit → không restock (phải dùng release).
	f.command(CmdReserve, reserveCmd("r2", ReserveItem{"a", 1}))
	err := f.svc.HandleEvent(f.ctx, events.TopicInventoryCommand,
		f.envelope(CmdRestock, "r2", RestockCmd{ReservationID: "r2", OrderID: "x", Items: []ReserveItem{{"a", 1}}, Reason: ReasonCancel}))
	if !errors.Is(err, ErrPermanent) {
		t.Fatalf("restock reservation RESERVED phải lỗi, có %v", err)
	}
}
