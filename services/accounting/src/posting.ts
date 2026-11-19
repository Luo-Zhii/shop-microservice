import { createEvent, enqueue, newId, processOnce, type EventBus, type Logger, type Pool, type PoolClient } from '@shopnow/platform';
import { Topics, type EventEnvelope, type OrderSnapshot } from '@shopnow/contracts';
import { localDate, postEntry, type EntryInput, type LineInput } from './ledger';

/**
 * Luật hạch toán mô hình sàn thu hộ (marketplace escrow):
 *   payment.succeeded (trả trước)  Nợ 1121 / Có 3388            — tiền người mua vào TK thu hộ
 *   order.delivered  (COD)         Nợ 1388 ĐVVC / Có 3388        — ĐVVC đang giữ tiền COD
 *   order.completed                Nợ 3388 tổng đơn / Có 331 seller (tổng − ship − hoa hồng)
 *                                    / Có 5113 hoa hồng chưa thuế / Có 33311 VAT / Có 3311 ĐVVC (phí ship)
 *                                  + phát hành hoá đơn GTGT phí hoa hồng cho seller
 *   payment.refunded               Nợ 3388 / Có 1121             — trả lại người mua
 *   payout paid (seller rút tiền)  Nợ 331 seller / Có 1121
 */
export interface Rates {
  commissionRate: number;
  vatRate: number;
  invoiceSeries: string;
  tz: string;
}

export function splitCompletion(o: Pick<OrderSnapshot, 'total' | 'shippingFee'>, r: Pick<Rates, 'commissionRate' | 'vatRate'>) {
  const shipping = Math.max(0, Math.round(o.shippingFee ?? 0));
  const base = Math.max(0, o.total - shipping);
  const commission = Math.round(base * r.commissionRate); // đã gồm VAT
  const vat = Math.round((commission * r.vatRate) / (1 + r.vatRate));
  return { shipping, commission, commissionNet: commission - vat, vat, seller: base - commission };
}

export function linesFor(event: EventEnvelope<any>, r: Rates): { lines: LineInput[]; description: string } | null {
  const d = event.data;
  switch (event.type) {
    case 'payment.succeeded':
      return {
        description: `Thu tiền thanh toán trực tuyến checkout ${d.checkoutId}`,
        lines: [
          { account: '1121', debit: d.amount, partyType: 'gateway', partyId: d.paymentId, memo: d.checkoutId },
          { account: '3388', credit: d.amount, partyType: 'checkout', partyId: d.checkoutId },
        ],
      };
    case 'payment.refunded':
      return {
        description: `Hoàn tiền đơn ${d.orderId}`,
        lines: [
          { account: '3388', debit: d.amount, partyType: 'checkout', partyId: d.checkoutId, orderId: d.orderId },
          { account: '1121', credit: d.amount, partyType: 'checkout', partyId: d.checkoutId, orderId: d.orderId },
        ],
      };
    case 'order.delivered': {
      const o = d as OrderSnapshot;
      if (o.paymentMethod !== 'COD') return null;
      return {
        description: `ĐVVC thu hộ COD đơn ${o.id}`,
        lines: [
          { account: '1388', debit: o.total, partyType: 'carrier', partyId: 'default', orderId: o.id },
          { account: '3388', credit: o.total, partyType: 'checkout', partyId: o.checkoutId, orderId: o.id },
        ],
      };
    }
    case 'order.completed': {
      const o = d as OrderSnapshot;
      const s = splitCompletion(o, r);
      return {
        description: `Quyết toán đơn ${o.id}: seller ${s.seller}, hoa hồng ${s.commission}, ship ${s.shipping}`,
        lines: [
          { account: '3388', debit: o.total, partyType: 'checkout', partyId: o.checkoutId, orderId: o.id },
          { account: '331', credit: s.seller, partyType: 'shop', partyId: o.shopId, orderId: o.id },
          { account: '5113', credit: s.commissionNet, partyType: 'shop', partyId: o.shopId, orderId: o.id },
          { account: '33311', credit: s.vat, orderId: o.id },
          { account: '3311', credit: s.shipping, partyType: 'carrier', partyId: 'default', orderId: o.id },
        ],
      };
    }
    default:
      return null;
  }
}

export async function issueInvoice(c: PoolClient, entryId: string, o: OrderSnapshot, r: Rates, date: string) {
  const s = splitCompletion(o, r);
  if (s.commission <= 0) return null;
  const seq = await c.query<{ n: number }>("SELECT nextval('invoice_no_seq') AS n");
  const { rows } = await c.query(
    `INSERT INTO vat_invoices (id, series, invoice_no, shop_id, order_id, entry_id, issue_date, amount_before_tax, vat_rate, vat_amount, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (order_id) DO NOTHING RETURNING *`,
    [newId(), r.invoiceSeries, String(seq.rows[0].n).padStart(7, '0'), o.shopId, o.id, entryId, date, s.commissionNet, r.vatRate, s.vat, s.commission],
  );
  return rows[0] ?? null;
}

export async function handleEvent(pool: Pool, event: EventEnvelope<any>, r: Rates, log: Logger) {
  const rule = linesFor(event, r);
  if (!rule) return false;
  const today = localDate(new Date(), r.tz);
  let posted = false;
  await processOnce(pool, 'accounting', event.id, async (c) => {
    const input: EntryInput = {
      date: localDate(event.time, r.tz),
      source: 'kafka',
      // hoàn tiền có thể nhiều lần một đơn → khử trùng theo id sự kiện; còn lại theo (loại, thực thể)
      sourceRef: event.type === 'payment.refunded' ? event.id : `${event.type}:${event.subject}`,
      eventType: event.type,
      description: rule.description,
      createdBy: `event:${event.source}`,
      lines: rule.lines,
    };
    const { entry, created } = await postEntry(c, input, today);
    if (!created) return;
    posted = true;
    if (event.type === 'order.completed') await issueInvoice(c, entry.id, event.data as OrderSnapshot, r, entry.entry_date);
    await enqueue(c, Topics.accounting, createEvent('journal.posted', 'accounting', entry.id, {
      entryId: entry.id, entryNo: entry.entry_no, period: entry.period, total: Number(entry.total), eventType: event.type,
    }));
  });
  if (posted) log.debug({ type: event.type, subject: event.subject }, 'đã hạch toán');
  return posted;
}

export async function registerConsumers(bus: EventBus, pool: Pool, r: Rates, log: Logger) {
  await bus.subscribe('accounting', [Topics.paymentEvent, Topics.order], async (event) => {
    await handleEvent(pool, event as EventEnvelope<any>, r, log);
  });
}
