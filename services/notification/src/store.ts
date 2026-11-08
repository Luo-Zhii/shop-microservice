import type { Db } from 'mongodb';

export interface NotificationDoc {
  _id: string;
  /** khoá chống trùng: `${eventId}:${userId}:${kind}` */
  dedupeKey: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  data: Record<string, unknown>;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface EmailLogDoc {
  _id: string; // dedupe key
  to: string;
  subject: string;
  status: 'sending' | 'sent' | 'failed';
  error: string | null;
  updatedAt: Date;
}

export interface OrderRefDoc {
  _id: string; // orderId
  buyerId: string;
  shopId: string;
  checkoutId: string;
  total: number;
}

export interface CheckoutRefDoc {
  _id: string; // checkoutId
  buyerId: string;
  orderIds: string[];
}

export function collections(db: Db) {
  return {
    notifications: db.collection<NotificationDoc>('notifications'),
    emails: db.collection<EmailLogDoc>('email_log'),
    orders: db.collection<OrderRefDoc>('order_refs'),
    checkouts: db.collection<CheckoutRefDoc>('checkout_refs'),
    processed: db.collection<{ _id: string; consumer: string; at: Date }>('processed_events'),
  };
}
export type Collections = ReturnType<typeof collections>;

export async function ensureIndexes(c: Collections) {
  await Promise.all([
    c.notifications.createIndex({ dedupeKey: 1 }, { unique: true }),
    c.notifications.createIndex({ userId: 1, createdAt: -1 }),
    c.notifications.createIndex({ userId: 1, read: 1 }),
    // in-app giữ 180 ngày
    c.notifications.createIndex({ createdAt: 1 }, { expireAfterSeconds: 180 * 86_400 }),
    c.processed.createIndex({ at: 1 }, { expireAfterSeconds: 30 * 86_400 }),
  ]);
}

export async function alreadyProcessed(c: Collections, consumer: string, eventId: string) {
  return (await c.processed.countDocuments({ _id: `${consumer}:${eventId}` }, { limit: 1 })) > 0;
}
export async function markProcessed(c: Collections, consumer: string, eventId: string) {
  await c.processed.updateOne({ _id: `${consumer}:${eventId}` }, { $setOnInsert: { consumer, at: new Date() } }, { upsert: true });
}

export const unreadCount = (c: Collections, userId: string) => c.notifications.countDocuments({ userId, read: false });
