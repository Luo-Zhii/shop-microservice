'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, PageTitle, QueryView, cn } from '@/components/ui';
import { useCategories } from '@/lib/hooks';

export default function CategoriesPage() {
  const q = useCategories();
  const [active, setActive] = useState<string | null>(null);
  return (
    <div>
      <PageTitle>Danh mục sản phẩm</PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.length} empty={<EmptyState title="Chưa có danh mục" />}>
        {(cats) => {
          const cur = cats.find((c) => c.id === active) ?? cats[0];
          return (
            <div className="grid grid-cols-[96px_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-surface sm:grid-cols-[180px_minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)]">
              <ul className="border-r border-border bg-surface-2/50">
                {cats.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setActive(c.id)}
                      className={cn('flex min-h-14 w-full items-center px-2 text-left text-xs sm:px-3 sm:text-sm',
                        cur?.id === c.id ? 'border-l-2 border-primary bg-surface font-semibold text-primary' : 'text-muted')}>
                      <span className="line-clamp-2 break-words">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {cur && (
                <div className="min-w-0 p-3 md:p-4">
                  <Link href={`/search?categoryId=${cur.id}`} className="mb-3 flex min-h-11 items-center justify-between gap-2 rounded-lg bg-primary-soft px-3 text-sm font-medium text-primary">
                    <span className="truncate">Tất cả {cur.name}</span><ChevronRight className="size-4 shrink-0" />
                  </Link>
                  {cur.children?.length ? (
                    <div className="space-y-4">
                      {cur.children.map((c) => (
                        <div key={c.id}>
                          <Link href={`/search?categoryId=${c.id}`} className="mb-2 block text-sm font-semibold hover:text-primary">{c.name}</Link>
                          {!!c.children?.length && (
                            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                              {c.children.map((g) => (
                                <li key={g.id}>
                                  <Link href={`/search?categoryId=${g.id}`} className="flex min-h-11 items-center rounded-lg border border-border px-2 text-xs hover:border-primary sm:text-sm">
                                    <span className="line-clamp-2">{g.name}</span>
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-sm text-muted">Danh mục này chưa có nhóm con.</p>}
                </div>
              )}
            </div>
          );
        }}
      </QueryView>
    </div>
  );
}
