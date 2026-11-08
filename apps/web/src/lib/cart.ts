import type { CartItem } from './types';

/** sessionStorage: danh sách skuId được chọn để thanh toán */
export const SELECT_KEY = 'shopnow.checkout';

export function readSelection(): string[] | null {
  try {
    const v = sessionStorage.getItem(SELECT_KEY);
    return v ? (JSON.parse(v) as string[]) : null;
  } catch {
    return null;
  }
}

export function writeSelection(ids: string[]) {
  try { sessionStorage.setItem(SELECT_KEY, JSON.stringify(ids)); } catch { /* bỏ qua */ }
}

export function itemProblem(it: CartItem): 'out' | 'short' | 'inactive' | null {
  if (it.available != null && it.available <= 0) return 'out';
  if (it.available != null && it.available < it.qty) return 'short';
  if (it.status && it.status !== 'ACTIVE' && it.status !== 'APPROVED') return 'inactive';
  return null;
}
