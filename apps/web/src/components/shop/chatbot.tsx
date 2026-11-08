'use client';

import { Bot, Loader2, MessageCircle, Send, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { asArray, formatVND, pick, productHref } from '@/lib/format';
import type { ProductLike } from '@/lib/types';
import { cn } from '../ui';

interface Msg { role: 'user' | 'assistant'; content: string; products?: ProductLike[] }

const HIDE_ON = ['/checkout', '/cart'];

export function Chatbot() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'assistant', content: 'Xin chào! Mình là trợ lý ShopNow. Bạn cần tìm sản phẩm hay hỏi về đơn hàng, đổi trả, vận chuyển?' },
  ]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs, open]);

  if (HIDE_ON.some((p) => pathname.startsWith(p))) return null;

  const send = async (content: string) => {
    const m = content.trim();
    if (!m || busy) return;
    const history = msgs.slice(1).map(({ role, content: c }) => ({ role, content: c }));
    setMsgs((x) => [...x, { role: 'user', content: m }]);
    setText('');
    setBusy(true);
    try {
      const r = await api.post<unknown>('/ai/chat', { message: m, history }, { silent: true });
      const reply = pick<string>(r, 'reply', 'answer', 'message', 'content') ?? 'Xin lỗi, mình chưa có câu trả lời.';
      setMsgs((x) => [...x, { role: 'assistant', content: reply, products: asArray<ProductLike>(r, 'products', 'suggestions').slice(0, 4) }]);
    } catch (e) {
      setMsgs((x) => [...x, { role: 'assistant', content: `Trợ lý đang bận (${errorMessage(e)}). Bạn thử lại sau nhé.` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Mở trợ lý chăm sóc khách hàng"
        onClick={() => setOpen(true)}
        className={cn(
          'fixed right-4 z-40 grid size-14 place-items-center rounded-full bg-primary text-primary-fg shadow-lg transition active:scale-95',
          // Trang sản phẩm có thanh "Thêm giỏ / Mua ngay" dính đáy trên điện thoại → nâng nút lên
          pathname.startsWith('/product/') ? 'bottom-[calc(var(--bottom-nav-h)+var(--safe-bottom)+76px)]' : 'bottom-[calc(var(--bottom-nav-h)+var(--safe-bottom)+12px)]',
          'md:bottom-6',
          open && 'hidden',
        )}
      >
        <MessageCircle className="size-6" />
      </button>
      {open && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-surface md:inset-auto md:bottom-6 md:right-6 md:h-[560px] md:max-h-[calc(100dvh-3rem)] md:w-[380px] md:rounded-2xl md:border md:border-border md:shadow-2xl"
          role="dialog" aria-label="Trợ lý ShopNow">
          <div className="flex items-center gap-2 border-b border-border px-3 pt-[calc(var(--safe-top)+8px)] pb-2 md:pt-2">
            <span className="grid size-9 place-items-center rounded-full bg-primary-soft text-primary"><Bot className="size-5" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Trợ lý ShopNow</p>
              <p className="text-xs text-muted">Trả lời tự động bằng AI</p>
            </div>
            <button type="button" aria-label="Đóng" onClick={() => setOpen(false)} className="grid size-11 place-items-center rounded-lg hover:bg-surface-2"><X className="size-5" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
            {msgs.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm', m.role === 'user' ? 'rounded-br-sm bg-primary text-primary-fg' : 'rounded-bl-sm bg-surface-2')}>
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  {m.products?.map((p) => (
                    <Link key={p.id} href={productHref(p)} onClick={() => setOpen(false)}
                      className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-surface px-2 py-1.5 text-fg">
                      <span className="line-clamp-1 min-w-0">{p.title}</span>
                      <span className="shrink-0 text-xs font-semibold text-primary">{formatVND(p.minPrice ?? p.price)}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            {busy && <div className="flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Đang soạn trả lời…</div>}
            {msgs.length === 1 && (
              <div className="flex flex-wrap gap-2">
                {['Chính sách đổi trả?', 'Phí vận chuyển bao nhiêu?', 'Gợi ý áo thun nam'].map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="min-h-9 rounded-full border border-border px-3 text-xs hover:bg-surface-2">{s}</button>
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(text); }}
            className="flex items-center gap-2 border-t border-border px-3 pt-2 pb-[calc(var(--safe-bottom)+8px)] md:pb-2">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Nhập câu hỏi…" enterKeyHint="send" aria-label="Câu hỏi"
              className="h-11 min-w-0 flex-1 rounded-full border border-border bg-surface-2 px-4 outline-none focus:border-primary" />
            <button type="submit" aria-label="Gửi" disabled={busy || !text.trim()} className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-fg disabled:opacity-50">
              <Send className="size-5" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
