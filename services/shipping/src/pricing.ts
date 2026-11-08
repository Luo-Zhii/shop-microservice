import { badRequest } from '@shopnow/platform';
import { resolveProvince, type Region } from './provinces';

export type Zone = 'SAME_PROVINCE' | 'SAME_REGION' | 'INTER_REGION';
export type Carrier = 'GHN' | 'GHTK' | 'SPX';

export const BASE_FEE: Record<Zone, number> = { SAME_PROVINCE: 20_000, SAME_REGION: 30_000, INTER_REGION: 40_000 };
const BASE_ETA: Record<Zone, number> = { SAME_PROVINCE: 1, SAME_REGION: 2, INTER_REGION: 4 };
const STEP_GRAMS = 500;
const STEP_FEE = 5_000;
const FREE_GRAMS = 1_000;

/** Hệ số giả lập từng hãng theo vùng — mỗi hãng mạnh một vùng nên "rẻ nhất" thay đổi theo tuyến. */
export const CARRIERS: Record<Carrier, { name: string; factor: Record<Zone, number>; etaDelta: Record<Zone, number> }> = {
  GHN: { name: 'Giao Hàng Nhanh', factor: { SAME_PROVINCE: 1.0, SAME_REGION: 1.0, INTER_REGION: 0.95 }, etaDelta: { SAME_PROVINCE: 0, SAME_REGION: 0, INTER_REGION: 0 } },
  GHTK: { name: 'Giao Hàng Tiết Kiệm', factor: { SAME_PROVINCE: 0.9, SAME_REGION: 1.05, INTER_REGION: 1.05 }, etaDelta: { SAME_PROVINCE: 1, SAME_REGION: 1, INTER_REGION: 1 } },
  SPX: { name: 'SPX Express', factor: { SAME_PROVINCE: 1.1, SAME_REGION: 0.9, INTER_REGION: 1.0 }, etaDelta: { SAME_PROVINCE: 0, SAME_REGION: 1, INTER_REGION: 1 } },
};

export interface QuoteOption {
  carrier: Carrier;
  carrierName: string;
  fee: number;
  etaDays: number;
}
export interface Quote extends QuoteOption {
  zone: Zone;
  fromProvince: string;
  toProvince: string;
  options: QuoteOption[];
}

export function zoneOf(from: { name: string; region: Region }, to: { name: string; region: Region }): Zone {
  if (from.name === to.name) return 'SAME_PROVINCE';
  return from.region === to.region ? 'SAME_REGION' : 'INTER_REGION';
}

/** Phí chuẩn: theo vùng + 5.000đ mỗi 500g (làm tròn lên) vượt 1kg. */
export function standardFee(zone: Zone, weightGrams: number): number {
  const extraSteps = Math.ceil(Math.max(0, weightGrams - FREE_GRAMS) / STEP_GRAMS);
  return BASE_FEE[zone] + extraSteps * STEP_FEE;
}

const roundThousand = (n: number) => Math.round(n / 1_000) * 1_000;

export function quote(fromProvince: string, toProvince: string, weightGrams: number): Quote {
  const from = resolveProvince(fromProvince);
  const to = resolveProvince(toProvince);
  if (!from) throw badRequest(`Không nhận diện được tỉnh/thành gửi: "${fromProvince}"`);
  if (!to) throw badRequest(`Không nhận diện được tỉnh/thành nhận: "${toProvince}"`);
  const zone = zoneOf(from, to);
  const base = standardFee(zone, weightGrams);
  const options = (Object.entries(CARRIERS) as [Carrier, (typeof CARRIERS)[Carrier]][])
    .map(([carrier, c]) => ({ carrier, carrierName: c.name, fee: roundThousand(base * c.factor[zone]), etaDays: BASE_ETA[zone] + c.etaDelta[zone] }))
    .sort((a, b) => a.fee - b.fee || a.etaDays - b.etaDays);
  return { ...options[0], zone, fromProvince: from.name, toProvince: to.name, options };
}
