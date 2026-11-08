import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/** Đổi authorization code lấy id_token và xác minh chữ ký qua JWKS của Google. */
export type GoogleExchanger = (code: string, redirectUri: string) => Promise<GoogleProfile>;

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function createGoogleExchanger(clientId: string, clientSecret: string): GoogleExchanger {
  return async (code, redirectUri) => {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) throw new Error(`Google token endpoint: ${body.error ?? res.status}`);
    const { payload } = await jwtVerify(body.id_token, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
    });
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? '').toLowerCase(),
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: String(payload.name ?? ''),
    };
  };
}

export function googleAuthUrl(clientId: string, redirectUri: string, state: string) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}
