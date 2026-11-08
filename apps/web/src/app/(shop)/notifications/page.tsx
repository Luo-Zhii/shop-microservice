'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { Button, Card, EmptyState, LoadingBlock, PageTitle, QueryView, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { useNotifications } from '@/lib/hooks';
import type { AppNotification } from '@/lib/types';

export default function NotificationsPage() {
  const { ready } = useRequireAuth();
  const qc = useQueryClient();
  const q = useNotifications(ready);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readOne = useMutation({ mutationFn: (id: string) => api.post(`/notification/notifications/${id}/read`, {}, { silent: true }), onSettled: invalidate });
  const readAll = useMutation({ mutationFn: () => api.post('/notification/notifications/read-all'), onSettled: invalidate });
  if (!ready) return <LoadingBlock />;

  const Row = ({ n }: { n: AppNotification }) => {
    const link = n.link ?? n.url;
    const body = (
      <div className={cn('flex gap-3 px-4 py-3', !n.read && 'bg-primary-soft/40')}>
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-primary')} />
        <div className="min-w-0 flex-1">
          <p className={cn('break-words text-sm', !n.read && 'font-medium')}>{n.title}</p>
          {(n.body ?? n.message) && <p className="break-words text-sm text-muted">{n.body ?? n.message}</p>}
          <p className="mt-0.5 text-xs text-muted">{timeAgo(n.createdAt)}</p>
        </div>
      </div>
    );
    const onClick = () => { if (!n.read) readOne.mutate(n.id); };
    return link?.startsWith('/') ? <Link href={link} onClick={onClick} className="block">{body}</Link>
      : <button type="button" onClick={onClick} className="block w-full text-left">{body}</button>;
  };

  return (
    <div>
      <PageTitle actions={!!q.data?.unread && <Button variant="outline" size="sm" loading={readAll.isPending} onClick={() => readAll.mutate()}><CheckCheck className="size-4" /> Đánh dấu đã đọc</Button>}>
        Thông báo
      </PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={<Bell className="size-6" />} title="Chưa có thông báo" />}>
        {(d) => <Card className="divide-y divide-border overflow-hidden">{d.items.map((n) => <Row key={n.id} n={n} />)}</Card>}
      </QueryView>
    </div>
  );
}
