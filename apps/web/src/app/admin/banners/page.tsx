'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, ConfirmSheet, EmptyState, Field, Img, Input, PageTitle, QueryView, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { Banner } from '@/lib/types';

export default function AdminBannersPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-banners'], queryFn: async () => asArray<Banner>(await api.get('/catalog/banners')) });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', imageUrl: '', linkUrl: '', sort: '0' });
  const [del, setDel] = useState<Banner | null>(null);
  const done = (m: string) => { toast.success(m); setOpen(false); setDel(null); void qc.invalidateQueries({ queryKey: ['admin-banners'] }); void qc.invalidateQueries({ queryKey: ['home'] }); };
  const create = useMutation({
    mutationFn: () => api.post('/catalog/admin/banners', { title: f.title.trim(), imageUrl: f.imageUrl.trim(), linkUrl: f.linkUrl.trim() || null, sort: Number(f.sort) || 0 }),
    onSuccess: () => { setF({ title: '', imageUrl: '', linkUrl: '', sort: '0' }); done('Đã thêm banner'); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/catalog/admin/banners/${id}`), onSuccess: () => done('Đã xoá banner') });
  const valid = f.title.trim().length >= 2 && /^https?:\/\//.test(f.imageUrl.trim());

  return (
    <div>
      <PageTitle actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" /> Thêm banner</Button>}>Banner trang chủ</PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.length} empty={<EmptyState icon={<ImageIcon className="size-6" />} title="Chưa có banner" />}>
        {(list) => (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((b) => (
              <Card key={b.id} className="overflow-hidden">
                <Img src={b.imageUrl} alt={b.title} ratio="banner" rounded="rounded-none" />
                <div className="flex items-center gap-2 p-3">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{b.title}</p><p className="truncate text-xs text-muted">{b.linkUrl || 'Không có liên kết'} · thứ tự {b.sort ?? 0}</p></div>
                  <Button variant="ghost" size="icon" aria-label="Xoá banner" onClick={() => setDel(b)}><Trash2 className="size-4 text-danger" /></Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryView>
      <Sheet open={open} onClose={() => setOpen(false)} title="Thêm banner" footer={(
        <><Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button><Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>Thêm</Button></>
      )}>
        <div className="grid gap-3">
          <Field label="Tiêu đề"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="URL ảnh" hint="Tỉ lệ khuyến nghị 16:5 (desktop) — hiển thị 16:7 trên điện thoại"><Input type="url" inputMode="url" value={f.imageUrl} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} /></Field>
          {/^https?:\/\//.test(f.imageUrl) && <Img src={f.imageUrl} alt="Xem trước" ratio="banner" />}
          <Field label="Liên kết khi bấm" hint="VD: /search?q=ao-thun"><Input value={f.linkUrl} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} /></Field>
          <Field label="Thứ tự"><Input inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
      </Sheet>
      <ConfirmSheet open={!!del} onClose={() => setDel(null)} title="Xoá banner" danger confirmText="Xoá" message={`Xoá banner “${del?.title ?? ''}”?`}
        loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </div>
  );
}
