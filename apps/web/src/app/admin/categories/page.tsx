'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FolderTree, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, ConfirmSheet, EmptyState, Field, Input, PageTitle, QueryView, Select, Sheet, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { flattenCategories, useCategories } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import type { Category } from '@/lib/types';

interface Draft { id?: string; name: string; parentId: string; icon: string; sort: string }

function Node({ c, depth, onEdit, onAdd, onDelete }: { c: Category; depth: number; onEdit: (c: Category) => void; onAdd: (parent: Category) => void; onDelete: (c: Category) => void }) {
  const [open, setOpen] = useState(depth === 0);
  const has = !!c.children?.length;
  return (
    <li>
      <div className="flex min-h-12 items-center gap-1 border-b border-border py-1 pr-1" style={{ paddingLeft: `${depth * 16 + 4}px` }}>
        <button type="button" aria-label={open ? 'Thu gọn' : 'Mở rộng'} disabled={!has} onClick={() => setOpen((o) => !o)} className="grid size-10 shrink-0 place-items-center rounded-lg disabled:opacity-0">
          <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm">{c.icon && !/^https?:/.test(c.icon) ? `${c.icon} ` : ''}{c.name}{has && <span className="ml-1 text-xs text-muted">({c.children!.length})</span>}</span>
        <Button variant="ghost" size="icon" aria-label={`Thêm danh mục con cho ${c.name}`} onClick={() => onAdd(c)}><Plus className="size-4" /></Button>
        <Button variant="ghost" size="icon" aria-label={`Sửa ${c.name}`} onClick={() => onEdit(c)}><Pencil className="size-4" /></Button>
        <Button variant="ghost" size="icon" aria-label={`Xoá ${c.name}`} disabled={has} onClick={() => onDelete(c)}><Trash2 className="size-4 text-danger" /></Button>
      </div>
      {open && has && (
        <ul>{c.children!.map((k) => <Node key={k.id} c={k} depth={depth + 1} onEdit={onEdit} onAdd={onAdd} onDelete={onDelete} />)}</ul>
      )}
    </li>
  );
}

export default function AdminCategoriesPage() {
  const qc = useQueryClient();
  const q = useCategories();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const flat = flattenCategories(q.data ?? []);
  const done = (m: string) => { toast.success(m); setDraft(null); setDeleting(null); void qc.invalidateQueries({ queryKey: ['categories'] }); };
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = { name: d.name.trim(), parentId: d.parentId || null, icon: d.icon.trim() || null, sort: Number(d.sort) || 0 };
      return d.id ? api.put(`/catalog/admin/categories/${d.id}`, body) : api.post('/catalog/admin/categories', body);
    },
    onSuccess: () => done('Đã lưu danh mục'),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/catalog/admin/categories/${id}`), onSuccess: () => done('Đã xoá danh mục') });

  return (
    <div>
      <PageTitle actions={<Button onClick={() => setDraft({ name: '', parentId: '', icon: '', sort: '0' })}><Plus className="size-4" /> Danh mục gốc</Button>}>Danh mục</PageTitle>
      <QueryView q={q} isEmpty={(d) => !d.length} empty={<EmptyState icon={<FolderTree className="size-6" />} title="Chưa có danh mục" />}>
        {(tree) => (
          <Card className="overflow-hidden">
            <ul>
              {tree.map((c) => (
                <Node key={c.id} c={c} depth={0}
                  onEdit={(x) => setDraft({ id: x.id, name: x.name, parentId: x.parentId ?? '', icon: x.icon ?? '', sort: String(x.sort ?? 0) })}
                  onAdd={(p) => setDraft({ name: '', parentId: p.id, icon: '', sort: '0' })}
                  onDelete={setDeleting} />
              ))}
            </ul>
          </Card>
        )}
      </QueryView>
      <Sheet open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Sửa danh mục' : 'Thêm danh mục'} footer={(
        <><Button variant="outline" onClick={() => setDraft(null)}>Huỷ</Button><Button disabled={(draft?.name.trim().length ?? 0) < 2} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>Lưu</Button></>
      )}>
        {draft && (
          <div className="grid gap-3">
            <Field label="Tên danh mục"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /></Field>
            <Field label="Danh mục cha">
              <Select value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}>
                <option value="">— Không (danh mục gốc) —</option>
                {flat.filter((c) => c.id !== draft.id).map((c) => <option key={c.id} value={c.id}>{`${'— '.repeat(c.depth)}${c.name}`}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Biểu tượng" hint="Emoji hoặc URL ảnh"><Input value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} /></Field>
              <Field label="Thứ tự"><Input inputMode="numeric" value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value.replace(/[^\d-]/g, '') })} /></Field>
            </div>
          </div>
        )}
      </Sheet>
      <ConfirmSheet open={!!deleting} onClose={() => setDeleting(null)} title="Xoá danh mục" danger confirmText="Xoá"
        message={`Xoá danh mục “${deleting?.name ?? ''}”? Không xoá được nếu danh mục đang có sản phẩm.`} loading={del.isPending} onConfirm={() => deleting && del.mutate(deleting.id)} />
    </div>
  );
}
