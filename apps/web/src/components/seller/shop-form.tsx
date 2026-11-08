'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { Shop } from '@/lib/types';
import { Button, Field, Input, Textarea } from '../ui';

const PHONE = /^(0|\+84)\d{9,10}$/;

/**
 * Hồ sơ shop theo seller service: tên, SĐT, địa chỉ lấy hàng, KYC (CCCD/MST), tài khoản nhận tiền.
 * Sửa hồ sơ: KYC/tài khoản ngân hàng server chỉ trả dạng che → chỉ gửi lại khi người dùng nhập mới.
 */
export function ShopForm({ initial, mode, onDone }: { initial?: Partial<Shop>; mode: 'create' | 'resubmit' | 'edit'; onDone?: () => void }) {
  const pa = initial?.pickupAddress;
  const [f, setF] = useState({
    name: initial?.name ?? '',
    phone: initial?.phone ?? '',
    description: initial?.description ?? '',
    logoUrl: initial?.logoUrl ?? '',
    line1: pa?.line1 ?? '',
    ward: pa?.ward ?? '',
    district: pa?.district ?? '',
    province: pa?.province ?? initial?.pickupProvince ?? '',
    legalName: initial?.kyc?.legalName ?? '',
    taxCode: '',
    idNumber: '',
    bankName: initial?.bankAccount?.bankName ?? '',
    accountNumber: '',
    holder: initial?.bankAccount?.holder ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const creating = mode === 'create';

  const errors: Partial<Record<keyof typeof f, string>> = {};
  if (f.name.trim().length < 3) errors.name = 'Tên shop tối thiểu 3 ký tự';
  if (!PHONE.test(f.phone.trim())) errors.phone = 'Số điện thoại dạng 0xxxxxxxxx';
  if (f.line1.trim().length < 3) errors.line1 = 'Nhập số nhà, tên đường';
  if (!f.ward.trim()) errors.ward = 'Bắt buộc';
  if (!f.district.trim()) errors.district = 'Bắt buộc';
  if (!f.province.trim()) errors.province = 'Bắt buộc';
  const kycTouched = creating || !!f.idNumber;
  if (kycTouched && f.legalName.trim().length < 2) errors.legalName = 'Nhập họ tên / tên doanh nghiệp';
  if (kycTouched && !/^(\d{9}|\d{12})$/.test(f.idNumber.trim())) errors.idNumber = 'CMND/CCCD gồm 9 hoặc 12 chữ số';
  if (f.taxCode.trim() && !/^\d{10}(-\d{3})?$/.test(f.taxCode.trim())) errors.taxCode = 'Mã số thuế gồm 10 số (hoặc 10 số-3 số)';
  const bankTouched = creating || !!f.accountNumber;
  if (bankTouched && f.bankName.trim().length < 2) errors.bankName = 'Nhập tên ngân hàng';
  if (bankTouched && !/^\d{6,20}$/.test(f.accountNumber.trim())) errors.accountNumber = 'Số tài khoản 6–20 chữ số';
  if (bankTouched && f.holder.trim().length < 2) errors.holder = 'Nhập tên chủ tài khoản';
  const [showErr, setShowErr] = useState(false);
  const err = (k: keyof typeof f) => (showErr ? errors[k] : undefined);

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: f.name.trim(),
        phone: f.phone.trim(),
        description: f.description.trim(),
        logoUrl: f.logoUrl.trim() || null,
        pickupAddress: { line1: f.line1.trim(), ward: f.ward.trim(), district: f.district.trim(), province: f.province.trim() },
      };
      if (kycTouched) body.kyc = { legalName: f.legalName.trim(), taxCode: f.taxCode.trim() || null, idNumber: f.idNumber.trim() };
      if (bankTouched) body.bankAccount = { bankName: f.bankName.trim(), accountNumber: f.accountNumber.trim(), holder: f.holder.trim() };
      return creating ? api.post('/seller/shops', body) : api.put('/seller/shops/me', body);
    },
    onSuccess: () => {
      toast.success(creating ? 'Đã gửi hồ sơ mở shop' : mode === 'resubmit' ? 'Đã gửi lại hồ sơ' : 'Đã lưu hồ sơ shop');
      onDone?.();
    },
  });

  const submit = () => {
    setShowErr(true);
    if (Object.keys(errors).length) { toast.error(Object.values(errors)[0]!); return; }
    m.mutate();
  };

  const section = 'grid gap-3 sm:grid-cols-2';
  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <fieldset className={section}>
        <legend className="mb-2 text-sm font-semibold">Thông tin shop</legend>
        <Field label="Tên shop" error={err('name')}><Input value={f.name} onChange={set('name')} maxLength={80} /></Field>
        <Field label="Số điện thoại" error={err('phone')}><Input type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Logo (URL ảnh)" className="sm:col-span-2"><Input type="url" inputMode="url" value={f.logoUrl} onChange={set('logoUrl')} placeholder="https://…" /></Field>
        <Field label="Giới thiệu" className="sm:col-span-2"><Textarea value={f.description} onChange={set('description')} rows={3} maxLength={2000} /></Field>
      </fieldset>
      <fieldset className={section}>
        <legend className="mb-2 text-sm font-semibold">Địa chỉ lấy hàng</legend>
        <Field label="Tỉnh / Thành phố" error={err('province')}><Input value={f.province} onChange={set('province')} placeholder="VD: Hồ Chí Minh" /></Field>
        <Field label="Quận / Huyện" error={err('district')}><Input value={f.district} onChange={set('district')} /></Field>
        <Field label="Phường / Xã" error={err('ward')}><Input value={f.ward} onChange={set('ward')} /></Field>
        <Field label="Số nhà, tên đường" error={err('line1')}><Input value={f.line1} onChange={set('line1')} /></Field>
      </fieldset>
      <fieldset className={section}>
        <legend className="mb-2 text-sm font-semibold">Định danh người bán (KYC)</legend>
        {!creating && <p className="text-xs text-muted sm:col-span-2">Đã lưu: CCCD {initial?.kyc?.idNumber ?? '—'}. Chỉ nhập lại nếu muốn thay đổi.</p>}
        <Field label="Họ tên / tên doanh nghiệp" error={err('legalName')}><Input value={f.legalName} onChange={set('legalName')} /></Field>
        <Field label="Số CMND/CCCD" error={err('idNumber')}><Input inputMode="numeric" value={f.idNumber} onChange={set('idNumber')} maxLength={12} autoComplete="off" /></Field>
        <Field label="Mã số thuế (nếu có)" error={err('taxCode')}><Input inputMode="numeric" value={f.taxCode} onChange={set('taxCode')} maxLength={14} /></Field>
      </fieldset>
      <fieldset className={section}>
        <legend className="mb-2 text-sm font-semibold">Tài khoản nhận tiền</legend>
        {!creating && <p className="text-xs text-muted sm:col-span-2">Đã lưu: {initial?.bankAccount?.bankName ?? '—'} {initial?.bankAccount?.accountNumber ?? ''}. Chỉ nhập lại nếu muốn thay đổi.</p>}
        <Field label="Ngân hàng" error={err('bankName')}><Input value={f.bankName} onChange={set('bankName')} placeholder="VD: Vietcombank" /></Field>
        <Field label="Số tài khoản" error={err('accountNumber')}><Input inputMode="numeric" value={f.accountNumber} onChange={set('accountNumber')} maxLength={20} autoComplete="off" /></Field>
        <Field label="Chủ tài khoản" error={err('holder')}><Input value={f.holder} onChange={set('holder')} autoCapitalize="characters" /></Field>
      </fieldset>
      <Button type="submit" size="lg" className="w-full sm:w-auto" loading={m.isPending}>
        {creating ? 'Gửi hồ sơ mở shop' : mode === 'resubmit' ? 'Gửi lại hồ sơ' : 'Lưu thay đổi'}
      </Button>
    </form>
  );
}
