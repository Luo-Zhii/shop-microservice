import { v7 } from 'uuid';

export const newId = () => v7();

/** "Áo Thun Nam Đẹp!" → "ao-thun-nam-dep" */
export function slugify(input: string): string {
  return foldVietnamese(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Bỏ dấu tiếng Việt để tìm kiếm không dấu. */
export function foldVietnamese(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

export function parsePage(q: { page?: unknown; pageSize?: unknown }, maxSize = 100) {
  const page = Math.max(1, Number.parseInt(String(q.page ?? '1'), 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number.parseInt(String(q.pageSize ?? '20'), 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}
