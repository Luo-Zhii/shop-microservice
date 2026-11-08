CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  full_name TEXT NOT NULL DEFAULT '',
  roles TEXT[] NOT NULL DEFAULT '{buyer}',
  shop_id UUID,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  google_sub TEXT UNIQUE,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  totp_last_step BIGINT NOT NULL DEFAULT 0,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  disabled BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_created_idx ON users (created_at DESC);

-- OTP chỉ lưu bản băm; mỗi (user, purpose) chỉ một mã còn hiệu lực
CREATE TABLE otp_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_user_idx ON otp_codes (user_id, purpose, created_at DESC);

-- Refresh token: lưu sha256, xoay vòng theo "family"
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Khoá ký JWT tự sinh (khi không cấp JWT_PRIVATE_KEY) — dùng chung giữa các replica / lần khởi động
CREATE TABLE signing_keys (
  kid TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ
);
