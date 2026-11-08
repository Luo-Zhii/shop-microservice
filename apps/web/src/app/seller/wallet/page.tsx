'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Clock, Wallet } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { StatCard } from '@/components/dash-shell';
import { Badge, Button, Card, EmptyState, Field, Input, PageTitle, QueryView, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import { asArray, formatDate, formatVND, pick } from '@/lib/format';
import { toast } from '@/lib/toast';

interface Entry { id: string; type?: string; amount: number; description?: string; note?: string; orderId?: string; createdAt: string }
interface Payout { id: string; amount: number; status: string; createdAt: string; paidAt?: string | null }

const PAYOUT_STATUS: Record<string, { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  PENDING: { label: 'Chờ xử lý', tone: 'warning' },
  REQUESTED: { label: 'Chờ xử lý', tone: 'warning' },
  PAID: { label: 'Đã chuyển', tone: 'success' },
  REJECTED: { label: 'Bị từ chối', tone: 'danger' },
};

export default function WalletPage() {
  const qc = useQueryClient();
  const w = useQuery({ queryKey: ['wallet'], queryFn: () => api.get<Record<string, unknown>>('/payment/seller/wallet') });
  const payouts = useQuery({
    queryKey: ['payouts'],
    enabled: w.isSuccess,
    queryFn: async () => {
      const inline = asArray<Payout>(w.data?.payouts);
      if (inline.length) return inline;
      try { return asArray<Payout>(await api.get('/payment/seller/payouts')); } catch { return []; }
    },
  });
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const balance = Number(pick(w.data, 'balance', 'available', 'availableBalance') ?? 0);
  const pending = Number(pick(w.data, 'pending', 'pendingBalance', 'holding') ?? 0);
  const request = useMutation({
    mutationFn: () => api.post('/payment/seller/payouts', { amount: Number(amount) }),
    onSuccess: () => { toast.success('Đã gửi yêu cầu rút tiền'); setOpen(false); setAmount(''); void qc.invalidateQueries({ queryKey: ['wallet'] }); void qc.invalidateQueries({ queryKey: ['payouts'] }); },
  });
  const amt = Number(amount);
  const err = amount && (amt < 50_000 ? 'Tối thiểu 50.000 ₫' : amt > balance ? 'Vượt quá số dư khả dụng' : null);

  return (
    <div>
      <PageTitle actions={<Button disabled={!w.isSuccess || balance <= 0} onClick={() => setOpen(true)}><ArrowDownToLine className="size-4" /> Rút tiền</Button>}>Ví & rút tiền</PageTitle>
      <QueryView q={w}>
        {(data) => {
          const entries = asArray<Entry>(pick(data, 'transactions', 'entries', 'ledger', 'history'));
          return (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <StatCard label="Số dư khả dụng" value={formatVND(balance)} icon={Wallet} tone="success" hint="Đã trừ 5% phí sàn" />
                <StatCard label="Đang chờ đối soát" value={formatVND(pending)} icon={Clock} tone="warning" hint="Đơn chưa hoàn thành" />
              </div>
              <Card className="p-3 md:p-4">
                <h2 className="mb-3 font-semibold">Yêu cầu rút tiền</h2>
                {payouts.isPending ? null : !payouts.data?.length ? <p className="text-sm text-muted">Chưa có yêu cầu rút tiền.</p> : (
                  <DataTable rows={payouts.data} rowKey={(p) => p.id} columns={[
                    { key: 'amount', header: 'Số tiền', primary: true, cell: (p) => <span className="font-semibold">{formatVND(p.amount)}</span> },
                    { key: 'status', header: 'Trạng thái', badge: true, cell: (p) => { const s = PAYOUT_STATUS[p.status] ?? { label: p.status, tone: 'neutral' as const }; return <Badge tone={s.tone}>{s.label}</Badge>; } },
                    { key: 'created', header: 'Ngày yêu cầu', cell: (p) => formatDate(p.createdAt) },
                    { key: 'paid', header: 'Ngày chuyển', cell: (p) => formatDate(p.paidAt) },
                  ]} />
                )}
              </Card>
              <Card className="p-3 md:p-4">
                <h2 className="mb-3 font-semibold">Biến động số dư</h2>
                {!entries.length ? <EmptyState title="Chưa có giao dịch" /> : (
                  <ul className="divide-y divide-border">
                    {entries.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                        <span className="min-w-0"><span className="block truncate">{e.description ?? e.note ?? e.type ?? 'Giao dịch'}</span><span className="text-xs text-muted">{formatDate(e.createdAt)}</span></span>
                        <span className={e.amount >= 0 ? 'shrink-0 font-medium text-success' : 'shrink-0 font-medium text-danger'}>{e.amount >= 0 ? '+' : ''}{formatVND(e.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          );
        }}
      </QueryView>
      <Sheet open={open} onClose={() => setOpen(false)} title="Rút tiền về tài khoản" footer={(
        <><Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button><Button disabled={!amount || !!err} loading={request.isPending} onClick={() => request.mutate()}>Gửi yêu cầu</Button></>
      )}>
        <p className="mb-3 text-sm text-muted">Số dư khả dụng: <span className="font-semibold text-fg">{formatVND(balance)}</span></p>
        <Field label="Số tiền muốn rút (₫)" error={err || null}>
          <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} autoFocus />
        </Field>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAmount(String(balance))}>Rút toàn bộ</Button>
      </Sheet>
    </div>
  );
}
