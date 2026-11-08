'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AddressForm, EMPTY_ADDRESS, formatAddress, validateAddress } from '@/components/shop/address-form';
import { Badge, Button, Card, ConfirmSheet, EmptyState, PageTitle, QueryView, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { Address } from '@/lib/types';

type Addr = Address & { id: string };

export default function AddressesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['addresses'], queryFn: async () => asArray<Addr>(await api.get('/user-profile/me/addresses')) });
  const [editing, setEditing] = useState<Address | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Address, string>>>({});
  const [deleting, setDeleting] = useState<Addr | null>(null);
  const done = (m: string) => { toast.success(m); setEditing(null); setDeleting(null); void qc.invalidateQueries({ queryKey: ['addresses'] }); };
  const save = useMutation({
    mutationFn: (a: Address) => {
      const { id, ...body } = a;
      return id ? api.put(`/user-profile/me/addresses/${id}`, body) : api.post('/user-profile/me/addresses', body);
    },
    onSuccess: () => done('Đã lưu địa chỉ'),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/user-profile/me/addresses/${id}`), onSuccess: () => done('Đã xoá địa chỉ') });
  const submit = () => {
    if (!editing) return;
    const e = validateAddress(editing);
    setErrors(e);
    if (!Object.keys(e).length) save.mutate(editing);
  };

  return (
    <div>
      <PageTitle actions={<Button onClick={() => { setErrors({}); setEditing({ ...EMPTY_ADDRESS }); }}><Plus className="size-4" /> Thêm địa chỉ</Button>}>Sổ địa chỉ</PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.length} empty={<EmptyState icon={<MapPin className="size-6" />} title="Chưa có địa chỉ" description="Thêm địa chỉ để đặt hàng nhanh hơn." />}>
        {(list) => (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((a) => (
              <Card key={a.id} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{a.fullName}</span><span className="text-sm text-muted">{a.phone}</span>{a.isDefault && <Badge tone="primary">Mặc định</Badge>}</div>
                <p className="break-words text-sm text-muted">{formatAddress(a)}</p>
                <div className="mt-auto flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setErrors({}); setEditing(a); }}><Pencil className="size-4" /> Sửa</Button>
                  <Button variant="ghost" size="sm" className="text-danger" onClick={() => setDeleting(a)}><Trash2 className="size-4" /> Xoá</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryView>
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Sửa địa chỉ' : 'Địa chỉ mới'} wide
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Huỷ</Button><Button loading={save.isPending} onClick={submit}>Lưu</Button></>}>
        {editing && <AddressForm value={editing} onChange={setEditing} errors={errors} />}
      </Sheet>
      <ConfirmSheet open={!!deleting} onClose={() => setDeleting(null)} title="Xoá địa chỉ" danger confirmText="Xoá"
        message={deleting ? formatAddress(deleting) : ''} loading={del.isPending} onConfirm={() => deleting && del.mutate(deleting.id)} />
    </div>
  );
}
