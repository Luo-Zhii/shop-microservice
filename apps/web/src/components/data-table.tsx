'use client';

import type { ReactNode } from 'react';
import { cn } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Ô tiêu đề của thẻ trên điện thoại (cột định danh) */
  primary?: boolean;
  /** Huy hiệu góc phải thẻ trên điện thoại */
  badge?: boolean;
  hideOnMobile?: boolean;
  className?: string;
  align?: 'left' | 'right' | 'center';
}

/**
 * Bảng dữ liệu: ≥ md là bảng (cuộn ngang trong khung, cột đầu cố định, thead dính);
 * < md mỗi dòng thành thẻ: tiêu đề + 2–4 cặp nhãn/giá trị + nút thao tác hiện sẵn (không cần hover).
 */
export function DataTable<T>({ rows, columns, rowKey, actions, onRowClick, empty }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  actions?: (r: T) => ReactNode;
  onRowClick?: (r: T) => void;
  empty?: ReactNode;
}) {
  if (!rows.length) return <>{empty}</>;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const badge = columns.find((c) => c.badge);
  const rest = columns.filter((c) => c !== primary && c !== badge && !c.hideOnMobile);
  return (
    <>
      {/* Điện thoại: thẻ */}
      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="rounded-xl border border-border bg-surface p-3">
            <div
              className={cn('flex items-start gap-2', onRowClick && 'cursor-pointer')}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
            >
              <div className="min-w-0 flex-1 font-medium">{primary.cell(r)}</div>
              {badge && <div className="shrink-0">{badge.cell(r)}</div>}
            </div>
            {rest.length > 0 && (
              <dl className="mt-2 flex flex-col gap-1.5">
                {rest.map((c) => (
                  <div key={c.key} className="flex min-w-0 items-start justify-between gap-3 text-sm">
                    <dt className="shrink-0 text-muted">{c.header}</dt>
                    <dd className="min-w-0 break-words text-right">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3">{actions(r)}</div>}
          </li>
        ))}
      </ul>

      {/* Máy tính bảng / desktop: bảng */}
      <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface md:block">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {columns.map((c, i) => (
                <th key={c.key} scope="col"
                  className={cn('whitespace-nowrap px-3 py-2.5 font-medium', i === 0 && 'sticky left-0 z-10 bg-surface-2',
                    c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}>
                  {c.header}
                </th>
              ))}
              {actions && <th className="px-3 py-2.5 text-right font-medium">Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className={cn('border-t border-border', onRowClick && 'cursor-pointer hover:bg-surface-2/60')}
                onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {columns.map((c, i) => (
                  <td key={c.key}
                    className={cn('px-3 py-2.5 align-middle', i === 0 && 'sticky left-0 z-[1] bg-surface',
                      c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
                {actions && (
                  <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-2">{actions(r)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
