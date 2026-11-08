import { MongoServerError } from 'mongodb';
import { counter, newId, type Logger } from '@shopnow/platform';
import type { Fanout } from './realtime';
import { unreadCount, type Collections, type NotificationDoc } from './store';
import type { Email } from './templates';

export interface Mailer {
  send(m: { to: string; subject: string; html: string; text: string }): Promise<void>;
}

export interface InApp {
  type: string;
  title: string;
  body: string;
  link?: string | null;
  data?: Record<string, unknown>;
}

const sent = () => counter('notifications_sent_total', 'Thông báo đã gửi', ['channel', 'type']);
const emailResult = () => counter('notification_email_total', 'Kết quả gửi email', ['result']);

export function toView(n: NotificationDoc) {
  return { id: n._id, type: n.type, title: n.title, body: n.body, link: n.link, data: n.data, read: n.read, createdAt: n.createdAt.toISOString() };
}

export function createNotifier(deps: { col: Collections; fanout: Fanout; mailer: Mailer; from: string; log: Logger }) {
  const { col, fanout, log } = deps;

  /** In-app: upsert theo dedupeKey (sự kiện lặp không tạo bản ghi mới), đẩy realtime chỉ khi thật sự tạo mới. */
  async function inApp(userId: string, dedupeKey: string, n: InApp) {
    const doc: NotificationDoc = {
      _id: newId(), dedupeKey, userId, type: n.type, title: n.title, body: n.body, link: n.link ?? null,
      data: n.data ?? {}, read: false, readAt: null, createdAt: new Date(),
    };
    const r = await col.notifications.updateOne({ dedupeKey }, { $setOnInsert: doc }, { upsert: true });
    if (!r.upsertedCount) return false;
    sent().inc({ channel: 'in_app', type: n.type });
    const unread = await unreadCount(col, userId);
    await fanout.publish({ userId, event: 'notification', data: { notification: toView(doc), unreadCount: unread } }).catch((err) =>
      log.warn({ err }, 'không đẩy được realtime (vẫn lưu in-app)'),
    );
    return true;
  }

  /**
   * Email at-least-once: nhật ký email theo dedupeKey; đã 'sent' → bỏ qua; lỗi SMTP → ghi 'failed' rồi ném lỗi để
   * consumer thử lại (in-app đã lưu nên không bị nhân đôi).
   */
  async function email(to: string, dedupeKey: string, type: string, e: Email) {
    try {
      await col.emails.updateOne(
        { _id: dedupeKey, status: { $ne: 'sent' } },
        { $set: { to, subject: e.subject, status: 'sending', error: null, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        emailResult().inc({ result: 'duplicate' });
        return false; // đã gửi trước đó
      }
      throw err;
    }
    try {
      await deps.mailer.send({ to, subject: e.subject, html: e.html, text: e.text });
    } catch (err) {
      await col.emails.updateOne({ _id: dedupeKey }, { $set: { status: 'failed', error: String((err as Error).message), updatedAt: new Date() } });
      emailResult().inc({ result: 'failed' });
      throw err;
    }
    await col.emails.updateOne({ _id: dedupeKey }, { $set: { status: 'sent', updatedAt: new Date() } });
    emailResult().inc({ result: 'sent' });
    sent().inc({ channel: 'email', type });
    return true;
  }

  return { inApp, email, skipEmail: (reason: string) => emailResult().inc({ result: reason }) };
}
export type Notifier = ReturnType<typeof createNotifier>;
