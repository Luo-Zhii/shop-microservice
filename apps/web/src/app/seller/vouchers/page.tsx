'use client';

import { VoucherManager } from '@/components/voucher-manager';

export default function SellerVouchersPage() {
  return <VoucherManager title="Voucher của shop" endpoint="/promotion/seller/vouchers" scope="shop" />;
}
