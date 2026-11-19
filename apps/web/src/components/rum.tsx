'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { useEffect } from 'react';
import { API_URL } from '@/lib/api';

/**
 * Real User Monitoring: gom Core Web Vitals + lỗi JS, gửi lô qua sendBeacon (text/plain → không preflight CORS)
 * khi trang ẩn hoặc lô đủ 10 sự kiện. Không gửi nội dung lỗi/URL đầy đủ (tránh lộ dữ liệu cá nhân) — chỉ loại lỗi + path.
 */
type RumEvent =
  | { type: 'vital'; name: string; value: number; rating?: string; path: string }
  | { type: 'error'; kind: 'error' | 'unhandledrejection' | 'react'; path: string };

const queue: RumEvent[] = [];
const VITALS = new Set(['LCP', 'INP', 'FCP', 'TTFB', 'CLS']);

function flush() {
  if (!queue.length) return;
  const body = JSON.stringify({ events: queue.splice(0, 30) });
  const url = `${API_URL}/rum`;
  if (!navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) {
    void fetch(url, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, keepalive: true }).catch(() => undefined);
  }
}

function push(e: RumEvent) {
  queue.push(e);
  if (queue.length >= 10) flush();
}

export function reportClientError(kind: 'react' | 'error' = 'react') {
  push({ type: 'error', kind, path: location.pathname });
}

export function Rum() {
  useReportWebVitals((m) => {
    if (VITALS.has(m.name)) push({ type: 'vital', name: m.name, value: m.value, rating: m.rating, path: location.pathname });
  });
  useEffect(() => {
    const onErr = () => push({ type: 'error', kind: 'error', path: location.pathname });
    const onRej = () => push({ type: 'error', kind: 'unhandledrejection', path: location.pathname });
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, []);
  return null;
}
