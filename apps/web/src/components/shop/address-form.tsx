'use client';

import { useState, type ChangeEvent } from 'react';
import type { Address } from '@/lib/types';
import { Checkbox, Field, Input } from '../ui';

export const EMPTY_ADDRESS: Address = { fullName: '', phone: '', line1: '', ward: '', district: '', province: '', isDefault: false };

export function validateAddress(a: Address): Partial<Record<keyof Address, string>> {
  const e: Partial<Record<keyof Address, string>> = {};
  if (a.fullName.trim().length < 2) e.fullName = 'Nhập họ tên người nhận';
  if (!/^(0|\+84)\d{9,10}$/.test(a.phone.replace(/\s/g, ''))) e.phone = 'Số điện thoại không hợp lệ';
  if (a.line1.trim().length < 3) e.line1 = 'Nhập số nhà, tên đường';
  if (!a.ward.trim()) e.ward = 'Nhập phường/xã';
  if (!a.district.trim()) e.district = 'Nhập quận/huyện';
  if (!a.province.trim()) e.province = 'Nhập tỉnh/thành phố';
  return e;
}

export function formatAddress(a: Partial<Address> | undefined | null) {
  if (!a) return '';
  return [a.line1, a.ward, a.district, a.province].filter(Boolean).join(', ');
}

export function AddressForm({ value, onChange, showDefault = true, errors }: {
  value: Address; onChange: (a: Address) => void; showDefault?: boolean; errors?: Partial<Record<keyof Address, string>>;
}) {
  const set = (k: keyof Address) => (e: ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Họ tên người nhận" error={errors?.fullName}>
        <Input value={value.fullName} onChange={set('fullName')} autoComplete="name" />
      </Field>
      <Field label="Số điện thoại" error={errors?.phone}>
        <Input value={value.phone} onChange={set('phone')} type="tel" inputMode="tel" autoComplete="tel" />
      </Field>
      <Field label="Tỉnh / Thành phố" error={errors?.province}>
        <Input value={value.province} onChange={set('province')} autoComplete="address-level1" placeholder="VD: Hà Nội" />
      </Field>
      <Field label="Quận / Huyện" error={errors?.district}>
        <Input value={value.district} onChange={set('district')} autoComplete="address-level2" />
      </Field>
      <Field label="Phường / Xã" error={errors?.ward}>
        <Input value={value.ward} onChange={set('ward')} autoComplete="address-level3" />
      </Field>
      <Field label="Địa chỉ cụ thể" error={errors?.line1}>
        <Input value={value.line1} onChange={set('line1')} autoComplete="street-address" placeholder="Số nhà, tên đường" />
      </Field>
      {showDefault && (
        <Checkbox className="sm:col-span-2" checked={!!value.isDefault} onChange={(v) => onChange({ ...value, isDefault: v })} label="Đặt làm địa chỉ mặc định" />
      )}
    </div>
  );
}

export function useAddressDraft(initial?: Address) {
  return useState<Address>(initial ?? EMPTY_ADDRESS);
}
