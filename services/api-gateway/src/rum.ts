import { histogram, counter, z, type FastifyInstance } from '@shopnow/platform';

/**
 * Real User Monitoring: trình duyệt gửi Core Web Vitals + lỗi JS (sendBeacon, gom lô) → metric Prometheus.
 * Chống bùng nổ cardinality: chỉ nhận 5 chỉ số cố định, chuẩn hoá đường dẫn về mẫu route (id/slug → :id),
 * cắt số route khác nhau ở MAX_ROUTES. AIOps dùng `web_vitals_seconds{name="LCP"}` p75 làm đặc trưng của service web.
 */
const VITALS = ['LCP', 'INP', 'FCP', 'TTFB', 'CLS'] as const;
const MAX_ROUTES = 200;
const seen = new Set<string>();

export function routeTemplate(path: string) {
  const p = (path.split(/[?#]/)[0] || '/')
    .split('/')
    .map((seg) => (/^[0-9a-f-]{16,}$/i.test(seg) || /^\d+$/.test(seg) || /-[0-9a-z]{6,}$/i.test(seg) ? ':id' : seg))
    .join('/')
    .slice(0, 80);
  if (seen.has(p)) return p;
  if (seen.size >= MAX_ROUTES) return 'other';
  seen.add(p);
  return p;
}

const body = z.object({
  events: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('vital'), name: z.enum(VITALS), value: z.number().min(0).max(600_000), rating: z.enum(['good', 'needs-improvement', 'poor']).optional(), path: z.string().max(300) }),
    z.object({ type: z.literal('error'), kind: z.enum(['error', 'unhandledrejection', 'react']), path: z.string().max(300) }),
  ])).min(1).max(30),
});

export function registerRum(app: FastifyInstance) {
  const vitals = histogram('web_vitals_seconds', 'Core Web Vitals đo ở trình duyệt người dùng (giây)', ['name', 'route', 'rating'],
    [0.05, 0.1, 0.2, 0.5, 0.8, 1, 1.8, 2.5, 4, 6, 10]);
  const cls = histogram('web_vitals_cls', 'Cumulative Layout Shift đo ở trình duyệt', ['route', 'rating'], [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1]);
  const errors = counter('web_errors_total', 'Lỗi JavaScript phía trình duyệt', ['route', 'kind']);

  // sendBeacon gửi text/plain để tránh preflight CORS → tự parse JSON
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 16_384 }, (_req, s, done) => {
    try {
      done(null, JSON.parse(String(s)));
    } catch {
      done(null, {});
    }
  });

  app.post('/api/rum', { bodyLimit: 16_384 }, async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'payload RUM không hợp lệ' } });
    for (const e of parsed.data.events) {
      const route = routeTemplate(e.path);
      if (e.type === 'error') errors.inc({ route, kind: e.kind });
      else if (e.name === 'CLS') cls.observe({ route, rating: e.rating ?? 'unknown' }, e.value);
      else vitals.observe({ name: e.name, route, rating: e.rating ?? 'unknown' }, e.value / 1000);
    }
    return reply.code(204).send();
  });
}
