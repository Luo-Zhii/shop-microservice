'use client';

import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { asArray } from '@/lib/format';
import { cn } from '../ui';

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function SearchBox({ className }: { className?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLFormElement>(null);
  const dq = useDebounced(q.trim());

  useEffect(() => { setQ(params.get('q') ?? ''); }, [params]);

  const sug = useQuery({
    queryKey: ['suggest', dq],
    enabled: open && dq.length >= 1,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const r = await api.get<unknown>('/search/suggest', { q: dq }, { signal });
      return asArray<string | { text?: string; title?: string }>(r, 'suggestions')
        .map((s) => (typeof s === 'string' ? s : s.text ?? s.title ?? ''))
        .filter(Boolean)
        .slice(0, 8);
    },
  });
  const list = sug.data ?? [];

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const go = (term: string) => {
    setOpen(false);
    const t = term.trim();
    router.push(t ? `/search?q=${encodeURIComponent(t)}` : '/search');
  };

  return (
    <form
      ref={boxRef}
      role="search"
      className={cn('relative min-w-0', className)}
      onSubmit={(e) => { e.preventDefault(); go(active >= 0 && list[active] ? list[active] : q); }}
    >
      <div className="flex h-11 items-center rounded-lg border border-border bg-surface pl-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 md:h-10">
        <Search className="size-4 shrink-0 text-muted" />
        <input
          type="search"
          inputMode="search"
          enterKeyHint="search"
          aria-label="Tìm sản phẩm"
          placeholder="Tìm sản phẩm, thương hiệu…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
            if (e.key === 'Escape') setOpen(false);
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none [&::-webkit-search-cancel-button]:hidden"
          autoComplete="off"
        />
        {q && (
          <button type="button" aria-label="Xoá" onClick={() => { setQ(''); setOpen(false); }} className="grid size-10 shrink-0 place-items-center text-muted">
            <X className="size-4" />
          </button>
        )}
        <button type="submit" className="hidden h-full shrink-0 rounded-r-lg bg-primary px-4 text-sm font-medium text-primary-fg sm:block">Tìm</button>
      </div>
      {open && dq && list.length > 0 && (
        <ul role="listbox" className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg">
          {list.map((s, i) => (
            <li key={s} role="option" aria-selected={i === active}>
              <button type="button" onClick={() => go(s)}
                className={cn('flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm', i === active ? 'bg-surface-2' : 'hover:bg-surface-2')}>
                <Search className="size-3.5 shrink-0 text-muted" /><span className="truncate">{s}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
