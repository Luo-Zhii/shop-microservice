'use client';

import { VoucherManager } from '@/components/voucher-manager';

export default function AdminVouchersPage() {
  return <VoucherManager title="Voucher sàn" endpoint="/promotion/admin/vouchers" scope="platform" />;
}
