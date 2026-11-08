'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Loader2, MapPin, Store, Ticket, Truck, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AddressForm, EMPTY_ADDRESS, formatAddress, validateAddress } from '@/components/shop/address-form';
import { Button, Card, Checkbox, EmptyState, ErrorState, Img, Input, LinkButton, LoadingBlock, PageTitle, Select, cn } from '@/components/ui';
import { ApiError, api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { itemProblem, readSelection, writeSelection } from '@/lib/cart';
import { asArray, formatVND } from '@/lib/format';
import { useCart } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import type { Address, CheckoutStatus, PaymentMethod, Voucher } from '@/lib/types';

const METHODS: { value: PaymentMethod; label: string; desc: string; icon: typeof Wallet }[] = [
  { value: 'COD', label: 'Thanh toán khi nhận hàng', desc: 'Trả tiền mặt cho shipper', icon: Wallet },
  { value: 'VNPAY', label: 'VNPay', desc: 'Thẻ ATM / QR ngân hàng', icon: CreditCard },
  { value: 'MOCK', label: 'Cổng thử nghiệm', desc: 'Giả lập thanh toán online (dev)', icon: CreditCard },
];

const TERMINAL_OK = ['CONFIRMED', 'PAID', 'COMPLETED', 'SUCCEEDED'];
const TERMINAL_FAIL = ['CANCELLED', 'FAILED', 'EXPIRED'];

function estimateDiscount(v: Voucher, subtotal: number, shippingFee: number) {
  if (subtotal < (v.minOrder ?? v.minOrderValue ?? 0)) return 0;
  const value = v.value ?? 0;
  if (v.type === 'PERCENT') return Math.min(Math.floor((subtotal * value) / 100), v.maxDiscount ?? Infinity);
  if (v.type === 'FREESHIP') return Math.min(shippingFee, value || shippingFee);
  return Math.min(value, subtotal);
}

function voucherLabel(v: Voucher) {
  const val = v.type === 'PERCENT' ? `Giảm ${v.value}%` : v.type === 'FREESHIP' ? 'Miễn phí vận chuyển' : `Giảm ${formatVND(v.value)}`;
  const min = v.minOrder ?? v.minOrderValue;
  return `${v.code} · ${v.title ?? v.name ?? val}${min ? ` · đơn từ ${formatVND(min)}` : ''}`;
}

export default function CheckoutPage() {
  const { ready } = useRequireAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const cart = useCart();
  const [selection, setSelection] = useState<string[] | null>(null);
  useEffect(() => { setSelection(readSelection() ?? []); }, []);

  const shops = useMemo(() => {
    if (!cart.data || !selection) return [];
    return cart.data.shops
      .map((s) => ({ ...s, items: s.items.filter((i) => selection.includes(i.skuId) && itemProblem(i) !== 'out' && itemProblem(i) !== 'inactive') }))
      .filter((s) => s.items.length);
  }, [cart.data, selection]);

  const addresses = useQuery({
    queryKey: ['addresses'],
    enabled: ready,
    queryFn: async () => asArray<Address & { id: string }>(await api.get('/user-profile/me/addresses')),
  });
  const [addressId, setAddressId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Address>(EMPTY_ADDRESS);
  const [saveDraft, setSaveDraft] = useState(true);
  const [addrErrors, setAddrErrors] = useState<Partial<Record<keyof Address, string>>>({});
  useEffect(() => {
    if (addressId || !addresses.data) return;
    const def = addresses.data.find((a) => a.isDefault) ?? addresses.data[0];
    setAddressId(def ? def.id : 'new');
  }, [addresses.data, addressId]);
  useEffect(() => { if (addresses.isError && !addressId) setAddressId('new'); }, [addresses.isError, addressId]);
  const address: Address | undefined = addressId === 'new' ? draft : addresses.data?.find((a) => a.id === addressId);

  // Voucher
  const platformVouchers = useQuery({
    queryKey: ['vouchers', 'platform'],
    enabled: ready,
    queryFn: async () => asArray<Voucher>(await api.get('/promotion/vouchers')).filter((v) => !v.shopId),
  });
  const shopIds = shops.map((s) => s.shopId).join(',');
  const shopVouchers = useQuery({
    queryKey: ['vouchers', 'shops', shopIds],
    enabled: ready && shops.length > 0,
    queryFn: async () => {
      const res = await Promise.allSettled(shops.map((s) => api.get(`/promotion/vouchers`, { shopId: s.shopId })));
      return Object.fromEntries(shops.map((s, i) => [s.shopId, res[i].status === 'fulfilled' ? asArray<Voucher>((res[i] as PromiseFulfilledResult<unknown>).value) : []]));
    },
  });
  const [platformCode, setPlatformCode] = useState('');
  const [shopCodes, setShopCodes] = useState<Record<string, string>>({});
  const [typedCode, setTypedCode] = useState('');
  const voucherCodes = [platformCode, typedCode.trim().toUpperCase(), ...Object.values(shopCodes)].filter(Boolean);

  const [method, setMethod] = useState<PaymentMethod>('COD');

  // Ước tính phí ship + giảm giá (giá cuối do server tính lại khi đặt)
  const toProvince = address?.province?.trim();
  const quote = useQuery({
    queryKey: ['checkout-quote', shops.map((s) => s.items.map((i) => `${i.skuId}x${i.qty}`).join('+')).join('|'), toProvince],
    enabled: ready && shops.length > 0 && !!toProvince,
    retry: false,
    queryFn: async () => {
      const fees = await Promise.all(shops.map(async (s) => {
        try {
          const r = await api.post<{ fee: number; etaDays?: number }>('/shipping/quote', {
            fromProvince: s.pickupProvince ?? 'Hà Nội',
            toProvince,
            weightGrams: s.items.reduce((n, i) => n + (i.weightGrams ?? 300) * i.qty, 0),
          }, { silent: true });
          return { fee: r.fee, etaDays: r.etaDays };
        } catch {
          return { fee: undefined as number | undefined, etaDays: undefined };
        }
      }));
      return { fees };
    },
  });

  // promotion /quote là API nội bộ → FE tự ước tính giảm giá từ thông tin voucher; số cuối do order service tính
  const lines = shops.map((s, i) => {
    const subtotal = s.items.reduce((n, it) => n + it.price * it.qty, 0);
    const fee = quote.data?.fees[i]?.fee;
    const v = shopVouchers.data?.[s.shopId]?.find((x) => x.code === shopCodes[s.shopId]);
    const discount = v ? estimateDiscount(v, subtotal, fee ?? 0) : 0;
    return { shop: s, subtotal, fee, eta: quote.data?.fees[i]?.etaDays, discount, total: subtotal + (fee ?? 0) - discount };
  });
  const pv = platformVouchers.data?.find((x) => x.code === platformCode);
  const platformDiscount = pv ? estimateDiscount(pv, lines.reduce((n, l) => n + l.subtotal - l.discount, 0), lines.reduce((n, l) => n + (l.fee ?? 0), 0)) : 0;
  const grand = lines.reduce((n, l) => n + l.total, 0) - platformDiscount;

  // Đặt hàng + poll trạng thái saga
  const [phase, setPhase] = useState<'idle' | 'submitting' | 'polling'>('idle');
  const idemKey = useRef<string>('');
  useEffect(() => { idemKey.current = ''; }, [addressId, method, voucherCodes.join(','), shopIds]);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  const placeOrder = async () => {
    if (!address) { toast.error('Vui lòng chọn địa chỉ nhận hàng'); return; }
    if (addressId === 'new') {
      const errs = validateAddress(draft);
      setAddrErrors(errs);
      if (Object.keys(errs).length) { toast.error('Vui lòng kiểm tra địa chỉ nhận hàng'); return; }
    }
    setPhase('submitting');
    try {
      let useAddressId: string | undefined = addressId !== 'new' ? addressId ?? undefined : undefined;
      if (addressId === 'new' && saveDraft) {
        try {
          const created = await api.post<{ id?: string }>('/user-profile/me/addresses', draft, { silent: true });
          if (created?.id) useAddressId = created.id;
          void qc.invalidateQueries({ queryKey: ['addresses'] });
        } catch {
          /* không lưu được vẫn đặt bằng địa chỉ nhập tay */
        }
      }
      if (!idemKey.current) idemKey.current = newIdempotencyKey();
      const res = await api.post<{ checkoutId: string; status: string; orderIds?: string[] }>('/order/checkout', {
        items: shops.flatMap((s) => s.items.map((i) => ({ skuId: i.skuId, qty: i.qty }))),
        ...(useAddressId ? { addressId: useAddressId } : { shippingAddress: { ...draft, isDefault: undefined } }),
        voucherCodes,
        paymentMethod: method,
      }, { idempotencyKey: idemKey.current });
      writeSelection([]);
      void qc.invalidateQueries({ queryKey: ['cart'] });
      setPhase('polling');
      const started = Date.now();
      const resultUrl = `/checkout/result?checkoutId=${encodeURIComponent(res.checkoutId)}`;
      while (!cancelled.current && Date.now() - started < 60_000) {
        try {
          const st = await api.get<CheckoutStatus>(`/order/checkouts/${res.checkoutId}`);
          const status = String(st.status ?? '').toUpperCase();
          if (st.redirectUrl && method !== 'COD') { window.location.href = st.redirectUrl; return; }
          if (TERMINAL_OK.includes(status) || TERMINAL_FAIL.includes(status)) { router.replace(resultUrl); return; }
        } catch {
          /* tạm lỗi mạng: thử lại */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      router.replace(resultUrl);
    } catch (e) {
      setPhase('idle');
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') void qc.invalidateQueries({ queryKey: ['cart'] });
      if (!(e instanceof ApiError)) toast.error(errorMessage(e));
    }
  };

  if (!ready || cart.isPending || selection === null) return <LoadingBlock />;
  if (cart.isError) return <ErrorState error={cart.error} onRetry={() => cart.refetch()} />;
  if (!shops.length) {
    return <EmptyState title="Chưa chọn sản phẩm để thanh toán" action={<LinkButton href="/cart">Về giỏ hàng</LinkButton>} />;
  }

  return (
    <div>
      <PageTitle back="/cart">Thanh toán</PageTitle>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
        <div className="space-y-3">
          <Card as="section" className="p-3 md:p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><MapPin className="size-5 text-primary" /> Địa chỉ nhận hàng</h2>
            {addresses.isPending ? <LoadingBlock className="py-4" /> : (
              <div className="space-y-2">
                {addresses.data?.map((a) => (
                  <label key={a.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', addressId === a.id ? 'border-primary bg-primary-soft/40' : 'border-border')}>
                    <input type="radio" name="addr" className="mt-1 size-5 shrink-0 accent-[var(--app-primary)]" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                    <span className="min-w-0 text-sm">
                      <span className="font-medium">{a.fullName}</span> <span className="text-muted">· {a.phone}</span>
                      {a.isDefault && <span className="ml-2 rounded border border-primary px-1 text-xs text-primary">Mặc định</span>}
                      <span className="block break-words text-muted">{formatAddress(a)}</span>
                    </span>
                  </label>
                ))}
                <label className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3', addressId === 'new' ? 'border-primary bg-primary-soft/40' : 'border-border')}>
                  <input type="radio" name="addr" className="size-5 shrink-0 accent-[var(--app-primary)]" checked={addressId === 'new'} onChange={() => setAddressId('new')} />
                  <span className="text-sm font-medium">Nhập địa chỉ mới</span>
                </label>
                {addressId === 'new' && (
                  <div className="rounded-lg border border-border p-3">
                    <AddressForm value={draft} onChange={setDraft} showDefault={false} errors={addrErrors} />
                    <Checkbox className="mt-2" checked={saveDraft} onChange={setSaveDraft} label="Lưu vào sổ địa chỉ" />
                  </div>
                )}
              </div>
            )}
          </Card>

          {lines.map((l) => {
            const vs = shopVouchers.data?.[l.shop.shopId] ?? [];
            return (
              <Card key={l.shop.shopId} as="section" className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 md:px-4">
                  <Store className="size-4 text-muted" /><span className="min-w-0 truncate text-sm font-semibold">{l.shop.shopName ?? 'Shop'}</span>
                </div>
                <ul className="divide-y divide-border">
                  {l.shop.items.map((it) => (
                    <li key={it.skuId} className="flex gap-3 px-3 py-3 md:px-4">
                      <Img src={it.image} alt={it.title} className="w-16 shrink-0" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="line-clamp-2">{it.title}</p>
                        {it.variantLabel && <p className="truncate text-xs text-muted">{it.variantLabel}</p>}
                        <div className="mt-1 flex justify-between gap-2"><span className="text-muted">{formatVND(it.price)} × {it.qty}</span><span className="font-medium">{formatVND(it.price * it.qty)}</span></div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="space-y-2 border-t border-border px-3 py-3 text-sm md:px-4">
                  {vs.length > 0 && (
                    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                      <span className="inline-flex items-center gap-1.5 text-muted"><Ticket className="size-4" /> Voucher của shop</span>
                      <Select aria-label="Voucher shop" className="sm:max-w-72" value={shopCodes[l.shop.shopId] ?? ''}
                        onChange={(e) => setShopCodes((c) => ({ ...c, [l.shop.shopId]: e.target.value }))}>
                        <option value="">Không dùng</option>
                        {vs.map((v) => <option key={v.code} value={v.code}>{voucherLabel(v)}</option>)}
                      </Select>
                    </div>
                  )}
                  <div className="flex justify-between gap-2"><span className="inline-flex items-center gap-1.5 text-muted"><Truck className="size-4" /> Phí vận chuyển{l.eta ? ` (~${l.eta} ngày)` : ''}</span>
                    <span>{quote.isFetching ? '…' : l.fee != null ? formatVND(l.fee) : 'Tính khi đặt'}</span></div>
                  {l.discount > 0 && <div className="flex justify-between gap-2 text-success"><span>Giảm giá</span><span>-{formatVND(l.discount)}</span></div>}
                  <div className="flex justify-between gap-2 font-medium"><span>Tổng tiền shop</span><span className="text-primary">{formatVND(l.total)}</span></div>
                </div>
              </Card>
            );
          })}

          <Card as="section" className="p-3 md:p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><Ticket className="size-5 text-primary" /> Voucher ShopNow</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select aria-label="Voucher sàn" value={platformCode} onChange={(e) => setPlatformCode(e.target.value)}>
                <option value="">{platformVouchers.isPending ? 'Đang tải voucher…' : platformVouchers.data?.length ? 'Chọn voucher' : 'Không có voucher khả dụng'}</option>
                {platformVouchers.data?.map((v) => <option key={v.code} value={v.code}>{voucherLabel(v)}</option>)}
              </Select>
              <Input placeholder="Hoặc nhập mã voucher" value={typedCode} onChange={(e) => setTypedCode(e.target.value)} autoCapitalize="characters" aria-label="Mã voucher" />
            </div>
          </Card>

          <Card as="section" className="p-3 md:p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><Wallet className="size-5 text-primary" /> Phương thức thanh toán</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              {METHODS.map((m) => (
                <label key={m.value} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', method === m.value ? 'border-primary bg-primary-soft/40' : 'border-border')}>
                  <input type="radio" name="pm" className="mt-0.5 size-5 shrink-0 accent-[var(--app-primary)]" checked={method === m.value} onChange={() => setMethod(m.value)} />
                  <span className="min-w-0 text-sm"><span className="block font-medium">{m.label}</span><span className="text-xs text-muted">{m.desc}</span></span>
                </label>
              ))}
            </div>
          </Card>
        </div>

        <aside className="sticky bottom-[calc(var(--bottom-nav-h)+var(--safe-bottom))] z-20 -mx-4 mt-3 border-t border-border bg-surface px-4 py-3 md:bottom-0 lg:top-24 lg:mx-0 lg:mt-0 lg:self-start lg:rounded-xl lg:border lg:p-4">
          <div className="hidden space-y-2 text-sm lg:block">
            <div className="flex justify-between"><span className="text-muted">Tiền hàng</span><span>{formatVND(lines.reduce((n, l) => n + l.subtotal, 0))}</span></div>
            <div className="flex justify-between"><span className="text-muted">Phí vận chuyển</span><span>{formatVND(lines.reduce((n, l) => n + (l.fee ?? 0), 0))}</span></div>
            {(platformDiscount > 0 || lines.some((l) => l.discount)) && (
              <div className="flex justify-between text-success"><span>Giảm giá</span><span>-{formatVND(platformDiscount + lines.reduce((n, l) => n + l.discount, 0))}</span></div>
            )}
            <hr className="border-border" />
          </div>
          <div className="flex items-center gap-3 lg:mt-3 lg:flex-col lg:items-stretch">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted">Tổng thanh toán (tạm tính)</p>
              <p className="truncate text-lg font-semibold text-primary">{formatVND(grand)}</p>
            </div>
            <Button size="lg" className="shrink-0 lg:w-full" loading={phase !== 'idle'} onClick={placeOrder}>Đặt hàng</Button>
          </div>
          <p className="mt-2 hidden text-xs text-muted lg:block">Giá cuối cùng được hệ thống tính lại khi đặt hàng.</p>
        </aside>
      </div>

      {phase === 'polling' && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 px-4" role="alertdialog" aria-live="assertive">
          <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl bg-surface p-6 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="font-medium">Đang xử lý đơn hàng…</p>
            <p className="text-sm text-muted">Hệ thống đang giữ hàng{method !== 'COD' ? ' và chuẩn bị cổng thanh toán' : ''}. Vui lòng không đóng trang.</p>
          </div>
        </div>
      )}
    </div>
  );
}

