import type { ServerResponse } from 'node:http';
import type { Redis } from 'ioredis';
import { gauge, type Logger } from '@shopnow/platform';

export interface RealtimeMessage {
  userId: string;
  event: 'notification' | 'unread';
  data: unknown;
}

/** Giữ kết nối SSE trên replica này. */
export class SseHub {
  private clients = new Map<string, Set<ServerResponse>>();
  private conns = gauge('notification_sse_connections', 'Số kết nối SSE đang mở trên replica');

  add(userId: string, res: ServerResponse) {
    let set = this.clients.get(userId);
    if (!set) this.clients.set(userId, (set = new Set()));
    set.add(res);
    this.conns.inc();
    return () => {
      if (set!.delete(res)) this.conns.dec();
      if (set!.size === 0) this.clients.delete(userId);
    };
  }

  deliver(m: RealtimeMessage) {
    const set = this.clients.get(m.userId);
    if (!set) return 0;
    const frame = sseFrame(m.event, m.data);
    for (const res of set) res.write(frame);
    return set.size;
  }

  closeAll() {
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }
}

export const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export interface Fanout {
  publish(m: RealtimeMessage): Promise<void>;
  close(): Promise<void>;
}

/** Một replica (test / dev): giao thẳng cho hub. */
export function localFanout(hub: SseHub): Fanout {
  return { publish: async (m) => void hub.deliver(m), close: async () => undefined };
}

/**
 * Nhiều replica: mọi bản tin đi qua Redis pub/sub, mỗi replica nghe kênh và giao cho kết nối SSE của mình
 * (người dùng có thể đang mở stream ở replica khác với replica đang xử lý Kafka).
 */
export async function redisFanout(pub: Redis, sub: Redis, channel: string, hub: SseHub, log: Logger): Promise<Fanout> {
  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return;
    try {
      hub.deliver(JSON.parse(raw) as RealtimeMessage);
    } catch (err) {
      log.warn({ err }, 'bản tin realtime hỏng');
    }
  });
  await sub.subscribe(channel);
  return {
    publish: async (m) => {
      await pub.publish(channel, JSON.stringify(m));
    },
    close: async () => {
      await sub.unsubscribe(channel).catch(() => undefined);
    },
  };
}
