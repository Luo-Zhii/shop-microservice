// Package auth: xác minh JWT RS256 qua JWKS của identity (zero-trust), giống packages/platform/src/auth.ts.
package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"time"

	"github.com/MicahParks/jwkset"
	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/time/rate"
)

type User struct {
	ID     string   `json:"id"`
	Email  string   `json:"email"`
	Roles  []string `json:"roles"`
	ShopID string   `json:"shopId,omitempty"`
}

func (u *User) HasRole(roles ...string) bool {
	for _, r := range roles {
		if slices.Contains(u.Roles, r) {
			return true
		}
	}
	return false
}

type claims struct {
	Email  string   `json:"email"`
	Roles  []string `json:"roles"`
	ShopID string   `json:"shopId"`
	jwt.RegisteredClaims
}

type Verifier struct {
	kf            keyfunc.Keyfunc
	parser        *jwt.Parser
	internalToken []byte
}

// New: JWKS tải nền, làm mới mỗi 10 phút; kid lạ → tải lại ngay nhưng tối đa 1 lần/30s (như jose cooldownDuration).
// identity chưa chạy lúc khởi động không làm service chết (lần tải đầu lỗi chỉ ghi log).
func New(ctx context.Context, jwksURL, issuer, audience, internalToken string) (*Verifier, error) {
	u, err := url.ParseRequestURI(jwksURL)
	if err != nil {
		return nil, fmt.Errorf("JWKS_URL không hợp lệ: %w", err)
	}
	store, err := jwkset.NewStorageFromHTTP(u, jwkset.HTTPClientStorageOptions{
		Ctx:                       ctx,
		HTTPTimeout:               5 * time.Second,
		NoErrorReturnFirstHTTPReq: true,
		RefreshInterval:           10 * time.Minute,
		RefreshErrorHandler: func(ctx context.Context, err error) {
			slog.Default().WarnContext(ctx, "không tải được JWKS", "url", jwksURL, "err", err)
		},
	})
	if err != nil {
		return nil, err
	}
	client, err := jwkset.NewHTTPClient(jwkset.HTTPClientOptions{
		HTTPURLs:          map[string]jwkset.Storage{u.String(): store},
		RefreshUnknownKID: rate.NewLimiter(rate.Every(30*time.Second), 1),
	})
	if err != nil {
		return nil, err
	}
	kf, err := keyfunc.New(keyfunc.Options{Ctx: ctx, Storage: client})
	if err != nil {
		return nil, err
	}
	return &Verifier{
		kf: kf,
		parser: jwt.NewParser(
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithIssuer(issuer),
			jwt.WithAudience(audience),
			jwt.WithExpirationRequired(),
		),
		internalToken: []byte(internalToken),
	}, nil
}

var ErrInvalidToken = errors.New("token không hợp lệ hoặc đã hết hạn")

// Verify: ctx có hạn 5s — kid lạ trong thời gian chờ rate limit (30s) bị từ chối ngay thay vì treo request.
func (v *Verifier) Verify(ctx context.Context, token string) (*User, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var c claims
	if _, err := v.parser.ParseWithClaims(token, &c, v.kf.KeyfuncCtx(ctx)); err != nil {
		return nil, errors.Join(ErrInvalidToken, err)
	}
	roles := c.Roles
	if len(roles) == 0 {
		roles = []string{"buyer"}
	}
	return &User{ID: c.Subject, Email: c.Email, Roles: roles, ShopID: c.ShopID}, nil
}

// InternalOK: header x-internal-token cho /internal/* (so sánh thời gian hằng).
func (v *Verifier) InternalOK(token string) bool {
	return len(v.internalToken) > 0 && subtle.ConstantTimeCompare([]byte(token), v.internalToken) == 1
}
