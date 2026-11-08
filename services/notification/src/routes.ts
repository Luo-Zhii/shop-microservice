import { parsePage, requireUser, type Auth, type FastifyInstance } from '@shopnow/platform';
import type { Filter } from 'mongodb';
import { toView } from './notifier';
import { sseFrame, type Fanout, type SseHub } from './realtime';
import { unreadCount, type Collections, type NotificationDoc } from './store';

export interface RouteDeps {
  col: Collections;
  auth: Auth;
  hub: SseHub;
  fanout: Fanout;
  heartbeatMs?: number;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { col, auth, hub, fanout } = deps;
  const authed = { preHandler: auth.authenticate };
  const heartbeatMs = deps.heartbeatMs ?? 25_000;

  app.get('/notifications', authed, async (req) => {
    const user = requireUser(req);
    const q = req.query as { unread?: string };
    const { page, pageSize, offset, limit } = parsePage(req.query as Record<string, unknown>, 50);
    const filter: Filter<NotificationDoc> = { userId: user.id };
    if (q.unread === 'true') filter.read = false;
    const [items, total, unread] = await Promise.all([
      col.notifications.find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
      col.notifications.countDocuments(filter),
      unreadCount(col, user.id),
    ]);
    return { items: items.map(toView), page, pageSize, total, unreadCount: unread };
  });

  app.get('/notifications/unread-count', authed, async (req) => ({ unreadCount: await unreadCount(col, requireUser(req).id) }));

  app.post<{ Params: { id: string } }>('/notifications/:id/read', authed, async (req) => {
    const user = requireUser(req);
    const r = await col.notifications.updateOne({ _id: req.params.id, userId: user.id, read: false }, { $set: { read: true, readAt: new Date() } });
    const unread = await unreadCount(col, user.id);
    if (r.modifiedCount) await fanout.publish({ userId: user.id, event: 'unread', data: { unreadCount: unread } }).catch(() => undefined);
    return { ok: true, unreadCount: unread };
  });

  app.post('/notifications/read-all', authed, async (req) => {
    const user = requireUser(req);
    const r = await col.notifications.updateMany({ userId: user.id, read: false }, { $set: { read: true, readAt: new Date() } });
    if (r.modifiedCount) await fanout.publish({ userId: user.id, event: 'unread', data: { unreadCount: 0 } }).catch(() => undefined);
    return { ok: true, updated: r.modifiedCount, unreadCount: 0 };
  });

  // SSE: EventSource không gửi được header → token qua ?token= (createAuth đã hỗ trợ).
  app.get('/notifications/stream', authed, async (req, reply) => {
    const user = requireUser(req);
    const unread = await unreadCount(col, user.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // giữ CORS + x-request-id đã gắn ở hook
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(sseFrame('ready', { unreadCount: unread }));
    const remove = hub.add(user.id, res);
    const hb = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    const cleanup = () => {
      clearInterval(hb);
      remove();
    };
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
  });
}
