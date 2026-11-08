'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Ticket } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import { api } from '@/lib/api';
import { asArray, formatDate, formatNumber, formatVND, toDateTimeLocal } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { Voucher } from '@/lib/types';
import { DataTable } from './data-table';
import { Badge, Button, EmptyState, Field, Input, PageTitle, QueryView, Select, Sheet } from './ui';

function voucherValue(v: Voucher) {
  if (v.type === 'PERCENT') return `${v.value}%${v.maxDiscount ? ` (tối đa ${formatVND(v.maxDiscount)})` : ''}`;
  if (v.type === 'FREESHIP') return `Freeship${v.value ? ` ${formatVND(v.value)}` : ''}`;
  return formatVND(v.value);
}

function voucherState(v: Voucher) {
  const now = Date.now();
  if (v.active === false) return { label: 'Đã tắt', tone: 'neutral' as const };
  if (v.startsAt && new Date(v.startsAt).getTime() > now) return { label: 'Sắp diễn ra', tone: 'info' as const };
  if (v.endsAt && new Date(v.endsAt).getTime() < now) return { label: 'Đã kết thúc', tone: 'neutral' as const };
  return { label: 'Đang chạy', tone: 'success' as const };
}

export function VoucherManager({ title, endpoint, scope }: { title: string; endpoint: string; scope: 'shop' | 'platform' }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['vouchers-admin', endpoint], queryFn: async () => asArray<Voucher>(await api.get(endpoint)) });
  const [open, setOpen] = useState(false);
  const blank = () => ({
    code: '', name: '', type: 'FIXED', value: '', maxDiscount: '', minOrder: '', quota: '100',
    startsAt: toDateTimeLocal(), endsAt: toDateTimeLocal(new Date(Date.now() + 7 * 86400_000).toISOString()),
  });
  const [f, setF] = useState(blank);
  const create = useMutation({
    mutationFn: () => api.post(endpoint, {
      code: f.code.trim().toUpperCase(),
      title: f.name.trim() || f.code.trim().toUpperCase(),
      type: f.type,
      value: Number(f.value) || 0,
      maxDiscount: f.maxDiscount ? Number(f.maxDiscount) : null,
      minOrder: f.minOrder ? Number(f.minOrder) : 0,
      usageLimit: Number(f.quota) || null,
      startsAt: new Date(f.startsAt).toISOString(),
      endsAt: new Date(f.endsAt).toISOString(),
    }),
    onSuccess: () => { toast.success('Đã tạo voucher'); setOpen(false); setF(blank()); void qc.invalidateQueries({ queryKey: ['vouchers-admin', endpoint] }); },
  });
  const num = (k: keyof ReturnType<typeof blank>) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') });
  const valid = f.code.trim().length >= 3 && (!f.name.trim() || f.name.trim().length >= 2) && (f.type === 'FREESHIP' || Number(f.value) > 0) && (f.type !== 'PERCENT' || Number(f.value) <= 100) && new Date(f.endsAt) > new Date(f.startsAt);

  return (
    <div>
      <PageTitle actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" /> Tạo voucher</Button>}>{title}</PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.length} empty={<EmptyState icon={<Ticket className="size-6" />} title="Chưa có voucher" description={scope === 'shop' ? 'Tạo voucher để thu hút người mua đến shop.' : 'Voucher sàn áp dụng cho mọi shop.'} />}>
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(v) => v.id ?? v.code}
            columns={[
              { key: 'code', header: 'Mã', primary: true, cell: (v) => <span><span className="font-mono font-semibold">{v.code}</span>{(v.title ?? v.name) && <span className="block text-xs font-normal text-muted">{v.title ?? v.name}</span>}</span> },
              { key: 'state', header: 'Trạng thái', badge: true, cell: (v) => { const s = voucherState(v); return <Badge tone={s.tone}>{s.label}</Badge>; } },
              { key: 'value', header: 'Giá trị', cell: voucherValue },
              { key: 'min', header: 'Đơn tối thiểu', align: 'right', cell: (v) => formatVND(v.minOrder ?? v.minOrderValue ?? 0) },
              { key: 'used', header: 'Đã dùng', align: 'right', cell: (v) => `${formatNumber(v.used ?? v.usedCount ?? 0)} / ${v.usageLimit ?? v.quota ? formatNumber(v.usageLimit ?? v.quota ?? 0) : '∞'}` },
              { key: 'time', header: 'Thời gian', cell: (v) => <span className="text-xs">{formatDate(v.startsAt)} → {formatDate(v.endsAt)}</span> },
            ]}
          />
        )}
      </QueryView>
      <Sheet open={open} onClose={() => setOpen(false)} title="Tạo voucher" wide footer={(
        <><Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button><Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>Tạo voucher</Button></>
      )}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mã voucher" hint="Chữ in hoa, không dấu"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} autoCapitalize="characters" maxLength={32} /></Field>
          <Field label="Tên hiển thị" hint="Bỏ trống sẽ dùng mã voucher"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="VD: Giảm 20k cho đơn từ 200k" /></Field>
          <Field label="Loại">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="FIXED">Giảm số tiền</option><option value="PERCENT">Giảm theo %</option><option value="FREESHIP">Miễn phí vận chuyển</option>
            </Select>
          </Field>
          <Field label={f.type === 'PERCENT' ? 'Phần trăm giảm (%)' : f.type === 'FREESHIP' ? 'Giảm phí ship tối đa (₫, bỏ trống = toàn bộ)' : 'Số tiền giảm (₫)'}>
            <Input inputMode="numeric" value={f.value} onChange={num('value')} />
          </Field>
          {f.type === 'PERCENT' && <Field label="Giảm tối đa (₫)"><Input inputMode="numeric" value={f.maxDiscount} onChange={num('maxDiscount')} /></Field>}
          <Field label="Giá trị đơn tối thiểu (₫)"><Input inputMode="numeric" value={f.minOrder} onChange={num('minOrder')} /></Field>
          <Field label="Số lượt sử dụng" hint="Bỏ trống = không giới hạn"><Input inputMode="numeric" value={f.quota} onChange={num('quota')} /></Field>
          <Field label="Bắt đầu"><Input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
          <Field label="Kết thúc" error={new Date(f.endsAt) <= new Date(f.startsAt) ? 'Phải sau thời điểm bắt đầu' : null}><Input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field>
        </div>
      </Sheet>
    </div>
  );
}
