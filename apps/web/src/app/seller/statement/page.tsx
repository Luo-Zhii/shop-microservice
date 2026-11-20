'use client';

import { useQuery } from '@tanstack/react-query';
import { FileText, Receipt } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { Stat } from '@/components/stat';
import { EmptyState, Field, Input, PageTitle, QueryView, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatVND } from '@/lib/format';

interface Line { entry_no: string; entry_date: string; description: string; order_id: string | null; debit: number; credit: number }
interface Invoice { invoice_no: string; series: string; order_id: string; issue_date: string; amount_before_tax: number; vat_amount: number; total: number }
interface Statement { period: string; items: Line[]; balance: number; invoices: Invoice[] }

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Sao kê công nợ sàn ↔ shop (TK 331) + hoá đơn phí hoa hồng — để seller tự đối soát với ví. */
export default function SellerStatementPage() {
  const [period, setPeriod] = useState(thisMonth());
  const q = useQuery({ queryKey: ['seller-statement', period], queryFn: () => api.get<Statement>('/accounting/seller/statement', { period }) });
  return (
    <div>
      <PageTitle actions={<Field label="Kỳ" htmlFor="sp" className="w-48 max-w-full"><Input id="sp" type="month" value={period} onChange={(e) => setPeriod(e.target.value || thisMonth())} /></Field>}>
        Sao kê công nợ
      </PageTitle>
      <QueryView q={q}>
        {(d) => {
          const accrued = d.items.reduce((s, l) => s + Number(l.credit), 0);
          const paid = d.items.reduce((s, l) => s + Number(l.debit), 0);
          return (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Phải nhận trong kỳ" value={formatVND(accrued)} />
                <Stat label="Đã nhận / trừ trong kỳ" value={formatVND(paid)} />
                <Stat label="Sàn còn nợ shop (luỹ kế)" value={formatVND(d.balance)} tone="success" className="col-span-2 sm:col-span-1" />
              </div>
              <section>
                <SectionTitle>Chi tiết</SectionTitle>
                <DataTable rows={d.items} rowKey={(l) => `${l.entry_no}-${l.order_id}-${l.debit}-${l.credit}`}
                  empty={<EmptyState icon={<FileText className="size-6" />} title="Kỳ này chưa có phát sinh" />}
                  columns={[
                    { key: 'desc', header: 'Diễn giải', primary: true, cell: (l) => <span className="line-clamp-2 break-words">{l.description}</span> },
                    { key: 'date', header: 'Ngày', cell: (l) => formatDate(l.entry_date, false) },
                    { key: 'no', header: 'Số chứng từ', hideOnMobile: true, cell: (l) => <span className="font-mono text-xs">{l.entry_no}</span> },
                    { key: 'in', header: 'Phải nhận', align: 'right', cell: (l) => (Number(l.credit) ? <span className="text-success">+{formatVND(l.credit)}</span> : '—') },
                    { key: 'out', header: 'Đã nhận / trừ', align: 'right', cell: (l) => (Number(l.debit) ? `−${formatVND(l.debit)}` : '—') },
                  ]} />
              </section>
              <section>
                <SectionTitle>Hoá đơn phí hoa hồng</SectionTitle>
                <DataTable rows={d.invoices} rowKey={(i) => `${i.series}-${i.invoice_no}`}
                  empty={<EmptyState icon={<Receipt className="size-6" />} title="Chưa có hoá đơn trong kỳ" />}
                  columns={[
                    { key: 'no', header: 'Số hoá đơn', primary: true, cell: (i) => <span className="font-mono">{i.series}-{i.invoice_no}</span> },
                    { key: 'date', header: 'Ngày', cell: (i) => formatDate(i.issue_date, false) },
                    { key: 'net', header: 'Chưa thuế', align: 'right', cell: (i) => formatVND(Number(i.amount_before_tax)) },
                    { key: 'vat', header: 'VAT', align: 'right', cell: (i) => formatVND(Number(i.vat_amount)) },
                    { key: 'total', header: 'Tổng', align: 'right', cell: (i) => <b>{formatVND(Number(i.total))}</b> },
                  ]} />
              </section>
            </div>
          );
        }}
      </QueryView>
    </div>
  );
}
