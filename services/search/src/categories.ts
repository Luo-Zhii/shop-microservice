import { serviceClient } from '@shopnow/platform';

interface CategoryNode {
  id: string;
  name: string;
  children?: CategoryNode[];
}

export interface CategoryPort {
  /** Chuỗi tổ tiên gốc → lá (gồm chính nó), null nếu không biết danh mục. */
  chain(categoryId: string): Promise<{ ids: string[]; names: string[] } | null>;
}

/** Đọc cây danh mục từ catalog GET /categories, cache 5 phút; gặp danh mục lạ thì tải lại (tối đa 1 lần / 30s). */
export function catalogCategories(baseUrl: string, ttlMs = 5 * 60_000): CategoryPort {
  const http = serviceClient({ name: 'catalog', baseUrl, timeoutMs: 1_500 });
  let index = new Map<string, { ids: string[]; names: string[] }>();
  let loadedAt = 0;
  async function load() {
    const r = await http.get<{ items: CategoryNode[] }>('/categories');
    const next = new Map<string, { ids: string[]; names: string[] }>();
    const walk = (nodes: CategoryNode[], ids: string[], names: string[]) => {
      for (const n of nodes) {
        const c = { ids: [...ids, n.id], names: [...names, n.name] };
        next.set(n.id, c);
        walk(n.children ?? [], c.ids, c.names);
      }
    };
    walk(r.items ?? [], [], []);
    index = next;
    loadedAt = Date.now();
  }
  return {
    async chain(categoryId) {
      const age = Date.now() - loadedAt;
      if (age > ttlMs || (!index.has(categoryId) && age > 30_000)) await load();
      return index.get(categoryId) ?? null;
    },
  };
}
