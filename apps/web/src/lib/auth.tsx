'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api, decodeJwt, getAccessToken, getRefreshToken, onTokenChange, peekGuestCartId, refreshSession, setGuestCartId, setSession,
} from './api';
import type { AuthUser, LoginResponse, Role } from './types';

interface Claims { sub: string; email: string; roles?: Role[]; shopId?: string; fullName?: string; name?: string }

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthCtx {
  status: Status;
  user: AuthUser | null;
  token: string | null;
  hasRole: (r: Role) => boolean;
  login: (email: string, password: string, totp?: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /** Lấy access token mới (vd. sau khi shop được duyệt để có role seller + shopId). */
  refresh: () => Promise<boolean>;
  reloadMe: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

function userFromToken(token: string | null, extra?: Partial<AuthUser>): AuthUser | null {
  const c = decodeJwt<Claims>(token);
  if (!c) return null;
  return {
    id: c.sub,
    email: c.email,
    fullName: extra?.fullName ?? c.fullName ?? c.name,
    roles: c.roles?.length ? c.roles : ['buyer'],
    shopId: c.shopId,
    emailVerified: extra?.emailVerified,
    twoFactorEnabled: extra?.twoFactorEnabled ?? extra?.totpEnabled,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Partial<AuthUser> | undefined>();
  const booted = useRef(false);

  const reloadMe = useCallback(async () => {
    try {
      const r = await api.get<Partial<AuthUser> & { user?: Partial<AuthUser> }>('/identity/auth/me');
      setMe(r?.user ?? r);
    } catch {
      /* /me lỗi không chặn phiên */
    }
  }, []);

  useEffect(() => {
    const off = onTokenChange((t) => {
      setToken(t);
      setStatus(t ? 'authenticated' : 'anonymous');
      if (!t) setMe(undefined);
    });
    if (!booted.current) {
      booted.current = true;
      if (getAccessToken()) {
        setToken(getAccessToken());
        setStatus('authenticated');
      } else if (getRefreshToken()) {
        refreshSession().then((ok) => {
          if (ok) void reloadMe();
          else setStatus(getAccessToken() ? 'authenticated' : 'anonymous');
        });
      } else {
        setStatus('anonymous');
      }
    }
    return off;
  }, [reloadMe]);

  const user = useMemo(() => userFromToken(token, me), [token, me]);

  const login = useCallback(async (email: string, password: string, totp?: string) => {
    const r = await api.post<LoginResponse>('/identity/auth/login', { email, password, ...(totp ? { totp } : {}) }, { silent: true });
    setSession(r.accessToken, r.refreshToken);
    if (r.user) setMe(r.user);
    // Gộp giỏ khách vào giỏ tài khoản
    const guest = peekGuestCartId();
    if (guest) {
      try {
        await api.post('/cart/cart/merge', { guestCartId: guest }, { silent: true });
        setGuestCartId(null);
      } catch {
        /* giữ giỏ khách để thử lại lần sau */
      }
    }
    await qc.invalidateQueries();
    void reloadMe();
    return userFromToken(r.accessToken, r.user)!;
  }, [qc, reloadMe]);

  const logout = useCallback(async () => {
    const rt = getRefreshToken();
    try {
      if (rt) await api.post('/identity/auth/logout', { refreshToken: rt }, { silent: true });
    } catch {
      /* bỏ qua */
    }
    setSession(null, null);
    qc.clear();
  }, [qc]);

  const refresh = useCallback(async () => {
    const ok = await refreshSession();
    if (ok) await qc.invalidateQueries();
    return ok;
  }, [qc]);

  const value = useMemo<AuthCtx>(() => ({
    status,
    user,
    token,
    hasRole: (r) => !!user?.roles.includes(r),
    login,
    logout,
    refresh,
    reloadMe,
  }), [status, user, token, login, logout, refresh, reloadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth phải nằm trong AuthProvider');
  return c;
}

/** Chuyển sang /login nếu chưa đăng nhập. Trả về true khi đã sẵn sàng hiển thị nội dung cần đăng nhập. */
export function useRequireAuth(): { ready: boolean; status: Status } {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === 'anonymous') {
      const next = typeof window !== 'undefined' ? window.location.pathname + window.location.search : pathname;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [status, router, pathname]);
  return { ready: status === 'authenticated', status };
}
