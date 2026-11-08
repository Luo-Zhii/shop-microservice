package httpapi_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/auth"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/events"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/httpapi"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/inventory"
	"github.com/Luo-Zhii/shop-microservice/services/inventory/internal/testutil"
)

const (
	issuer   = "shopnow-identity"
	audience = "shopnow"
	kid      = "test-key"
)

type env struct {
	t   *testing.T
	srv *httptest.Server
	svc *inventory.Service
	key *rsa.PrivateKey
}

// JWKS server httptest phục vụ khoá công khai RSA sinh trong test (giống identity /.well-known/jwks.json).
func jwksServer(t *testing.T, key *rsa.PublicKey) *httptest.Server {
	b64 := base64.RawURLEncoding.EncodeToString
	body, _ := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid,
		"n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes()),
	}}})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(s.Close)
	return s
}

func setup(t *testing.T) *env {
	pool := testutil.DB(t, "_http")
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	v, err := auth.New(ctx, jwksServer(t, &key.PublicKey).URL, issuer, audience, "secret")
	if err != nil {
		t.Fatal(err)
	}
	log := testutil.Logger()
	svc := inventory.New(pool, log, time.Minute)
	api := httpapi.New(svc, v, log, map[string]httpapi.Check{"db": func(ctx context.Context) error { return pool.Ping(ctx) }})
	srv := httptest.NewServer(api.Handler())
	t.Cleanup(srv.Close)
	e := &env{t: t, srv: srv, svc: svc, key: key}

	// shop-1 có a, b; shop-2 có c.
	e.product("p1", "shop-1", "a", "b")
	e.product("p2", "shop-2", "c")
	return e
}

func (e *env) product(id, shop string, skus ...string) {
	vs := []map[string]any{}
	for _, s := range skus {
		vs = append(vs, map[string]any{"id": s, "sku": strings.ToUpper(s), "status": "ACTIVE"})
	}
	ev, _ := events.New(context.Background(), "product.upserted", id, map[string]any{"id": id, "shopId": shop, "variants": vs})
	if err := e.svc.HandleEvent(context.Background(), events.TopicCatalogProduct, ev); err != nil {
		e.t.Fatal(err)
	}
}

type tokenOpt func(jwt.MapClaims)

func (e *env) token(sub string, roles []string, shopID string, opts ...tokenOpt) string {
	c := jwt.MapClaims{
		"sub": sub, "email": sub + "@shopnow.local", "roles": roles,
		"iss": issuer, "aud": audience, "iat": time.Now().Unix(), "exp": time.Now().Add(15 * time.Minute).Unix(),
	}
	if shopID != "" {
		c["shopId"] = shopID
	}
	for _, o := range opts {
		o(c)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
	tok.Header["kid"] = kid
	s, err := tok.SignedString(e.key)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *env) do(method, path, token, body string) (int, map[string]any, string) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return res.StatusCode, m, string(raw)
}

func errCode(m map[string]any) string {
	e, _ := m["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func TestSellerCannotEditOtherShopSku(t *testing.T) {
	e := setup(t)
	seller1 := e.token("u1", []string{"buyer", "seller"}, "shop-1")
	seller2 := e.token("u2", []string{"seller"}, "shop-2")

	if code, m, raw := e.do("PUT", "/seller/stock/a", seller1, `{"onHand":7}`); code != 200 || m["available"] != 7.0 {
		t.Fatalf("seller shop-1 sửa SKU của mình: %d %s", code, raw)
	}
	code, m, raw := e.do("PUT", "/seller/stock/a", seller2, `{"onHand":999}`)
	if code != 403 || errCode(m) != "FORBIDDEN" {
		t.Fatalf("seller shop-2 sửa SKU shop-1 phải 403 FORBIDDEN, có %d %s", code, raw)
	}
	if msg, _ := m["error"].(map[string]any)["message"].(string); !strings.Contains(msg, "shop") {
		t.Fatalf("thông báo lỗi tiếng Việt: %q", msg)
	}
	var list []map[string]any
	_, _, raw = e.do("GET", "/stock?skuIds=a", "", "")
	_ = json.Unmarshal([]byte(raw), &list)
	if len(list) != 1 || list[0]["onHand"] != 7.0 {
		t.Fatalf("tồn của a bị shop khác sửa: %s", raw)
	}
}

func TestAuthRequired(t *testing.T) {
	e := setup(t)
	if code, m, _ := e.do("GET", "/seller/stock", "", ""); code != 401 || errCode(m) != "UNAUTHORIZED" {
		t.Fatalf("không token phải 401, có %d", code)
	}
	if code, m, _ := e.do("GET", "/seller/stock", e.token("b1", []string{"buyer"}, ""), ""); code != 403 || errCode(m) != "FORBIDDEN" {
		t.Fatalf("buyer phải 403, có %d", code)
	}
	wrongAud := e.token("u1", []string{"seller"}, "shop-1", func(c jwt.MapClaims) { c["aud"] = "other" })
	if code, _, _ := e.do("GET", "/seller/stock", wrongAud, ""); code != 401 {
		t.Fatalf("sai audience phải 401, có %d", code)
	}
	expired := e.token("u1", []string{"seller"}, "shop-1", func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Minute).Unix() })
	if code, _, _ := e.do("GET", "/seller/stock", expired, ""); code != 401 {
		t.Fatalf("token hết hạn phải 401, có %d", code)
	}
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	forged := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": "x", "roles": []string{"seller"}, "shopId": "shop-1",
		"iss": issuer, "aud": audience, "exp": time.Now().Add(time.Minute).Unix()})
	forged.Header["kid"] = kid
	fs, _ := forged.SignedString(other)
	if code, _, _ := e.do("GET", "/seller/stock", fs, ""); code != 401 {
		t.Fatalf("token ký bằng khoá lạ phải 401, có %d", code)
	}
}

func TestSellerStockFlow(t *testing.T) {
	e := setup(t)
	seller := e.token("u1", []string{"seller"}, "shop-1")

	code, m, raw := e.do("GET", "/seller/stock?page=1&pageSize=1", seller, "")
	if code != 200 || m["total"] != 2.0 || m["pageSize"] != 1.0 || len(m["items"].([]any)) != 1 {
		t.Fatalf("phân trang sai: %d %s", code, raw)
	}
	if _, m, raw := e.do("GET", "/seller/stock?page=1&pageSize=50", seller, ""); strings.Contains(raw, `"c"`) || m["total"] != 2.0 {
		t.Fatalf("lộ SKU shop khác: %s", raw)
	}
	if code, m, _ := e.do("PUT", "/seller/stock/zzz", seller, `{"onHand":1}`); code != 404 || errCode(m) != "NOT_FOUND" {
		t.Fatalf("SKU không tồn tại phải 404, có %d", code)
	}
	for _, body := range []string{`{"onHand":-1}`, `{"onHand":1.5}`, `{}`, `nope`} {
		if code, m, _ := e.do("PUT", "/seller/stock/a", seller, body); code != 400 || errCode(m) != "VALIDATION_ERROR" {
			t.Fatalf("body %s phải 400, có %d", body, code)
		}
	}
	// Giữ 3 cái rồi seller hạ tồn xuống 2 → 409 INSUFFICIENT_STOCK.
	e.do("PUT", "/seller/stock/a", seller, `{"onHand":5}`)
	ev, _ := events.New(context.Background(), "inventory.reserve", "r1",
		inventory.ReserveCmd{ReservationID: "r1", Items: []inventory.ReserveItem{{SkuID: "a", Qty: 3}}, TTLSeconds: 60})
	if err := e.svc.HandleEvent(context.Background(), events.TopicInventoryCommand, ev); err != nil {
		t.Fatal(err)
	}
	if code, m, raw := e.do("PUT", "/seller/stock/a", seller, `{"onHand":2}`); code != 409 || errCode(m) != "INSUFFICIENT_STOCK" {
		t.Fatalf("onHand < reserved phải 409 INSUFFICIENT_STOCK, có %d %s", code, raw)
	}
	_, _, raw = e.do("GET", "/stock?skuIds=a,zzz,b", "", "")
	var list []inventory.StockView
	if err := json.Unmarshal([]byte(raw), &list); err != nil || len(list) != 2 || list[0] != (inventory.StockView{SkuID: "a", OnHand: 5, Reserved: 3, Available: 2}) {
		t.Fatalf("GET /stock = %s", raw)
	}
	if code, m, _ := e.do("GET", "/stock", "", ""); code != 400 || errCode(m) != "VALIDATION_ERROR" {
		t.Fatalf("thiếu skuIds phải 400, có %d", code)
	}
}

func TestOpsEndpoints(t *testing.T) {
	e := setup(t)
	e.do("PUT", "/seller/stock/a", e.token("u1", []string{"seller"}, "shop-1"), `{"onHand":1}`)
	if code, m, _ := e.do("GET", "/healthz", "", ""); code != 200 || m["status"] != "ok" {
		t.Fatalf("/healthz %d", code)
	}
	if code, m, raw := e.do("GET", "/readyz", "", ""); code != 200 || m["status"] != "ok" {
		t.Fatalf("/readyz %d %s", code, raw)
	}
	if code, m, _ := e.do("GET", "/khong-co", "", ""); code != 404 || errCode(m) != "NOT_FOUND" {
		t.Fatalf("route lạ phải 404 NOT_FOUND, có %d", code)
	}
	_, _, metrics := e.do("GET", "/metrics", "", "")
	for _, want := range []string{
		`http_server_requests_seconds_bucket{method="PUT",route="/seller/stock/{skuId}",service="inventory",status="200"`,
		`outbox_pending{service="inventory"}`, `go_goroutines{service="inventory"}`,
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("/metrics thiếu %s", want)
		}
	}
}
