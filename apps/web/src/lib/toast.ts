// Bus toast tối giản (không phụ thuộc React) để lớp API cũng gọi được.
export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem { id: number; kind: ToastKind; message: string }

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

export function subscribeToasts(l: Listener) {
  listeners.add(l);
  l(items);
  return () => { listeners.delete(l); };
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function toast(message: string, kind: ToastKind = 'info', ms = 4000) {
  // Gộp toast trùng nội dung đang hiển thị (vd. nhiều request cùng lỗi mạng)
  if (items.some((t) => t.message === message && t.kind === kind)) return;
  const id = ++seq;
  items = [...items.slice(-3), { id, kind, message }];
  emit();
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), ms);
}

toast.success = (m: string) => toast(m, 'success');
toast.error = (m: string) => toast(m, 'error', 6000);
