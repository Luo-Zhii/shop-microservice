'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api, errorMessage, uploadImage } from '@/lib/api';
import { pick } from '@/lib/format';
import { flattenCategories, useCategories } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import type { ProductSnapshot, VariantSnapshot } from '@/lib/types';
import { Button, Card, Field, Img, Input, Select, Textarea, cn } from '../ui';

interface OptionDef { name: string; values: string[] }
interface VariantDraft { id?: string; sku: string; price: string; compareAtPrice: string; weightGrams: string; active: boolean }

const keyOf = (opts: Record<string, string>, names: string[]) => names.map((n) => opts[n] ?? '').join(' / ');

function cartesian(options: OptionDef[]): Record<string, string>[] {
  const valid = options.filter((o) => o.name.trim() && o.values.length);
  return valid.reduce<Record<string, string>[]>(
    (acc, o) => acc.flatMap((a) => o.values.map((v) => ({ ...a, [o.name.trim()]: v }))),
    [{}],
  );
}

function skuBase(title: string) {
  return title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8).toUpperCase() || 'SP';
}

function fromProduct(p?: ProductSnapshot) {
  const active = (p?.variants ?? []).filter((v) => v.status !== 'INACTIVE');
  const names = [...new Set(active.flatMap((v) => Object.keys(v.options ?? {})))];
  const options: OptionDef[] = names.map((n) => ({ name: n, values: [...new Set(active.map((v) => v.options?.[n]).filter(Boolean) as string[])] }));
  const variants: Record<string, VariantDraft> = {};
  for (const v of active) {
    variants[keyOf(v.options ?? {}, names)] = {
      id: v.id, sku: v.sku, price: String(v.price), compareAtPrice: v.compareAtPrice ? String(v.compareAtPrice) : '', weightGrams: String(v.weightGrams ?? 200), active: true,
    };
  }
  return { options, variants };
}

function OptionEditor({ opt, onChange, onRemove }: { opt: OptionDef; onChange: (o: OptionDef) => void; onRemove: () => void }) {
  const [val, setVal] = useState('');
  const add = () => {
    const parts = val.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => !opt.values.includes(s));
    if (parts.length) onChange({ ...opt, values: [...opt.values, ...parts] });
    setVal('');
  };
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <Input value={opt.name} onChange={(e) => onChange({ ...opt, name: e.target.value })} placeholder="Tên phân loại (VD: Size, Màu)" aria-label="Tên phân loại" />
        <Button variant="ghost" size="icon" aria-label="Xoá phân loại" onClick={onRemove}><Trash2 className="size-4" /></Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {opt.values.map((v) => (
          <span key={v} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-surface-2 pl-3 text-sm">
            {v}
            <button type="button" aria-label={`Xoá ${v}`} onClick={() => onChange({ ...opt, values: opt.values.filter((x) => x !== v) })} className="grid size-9 place-items-center rounded-full"><X className="size-3.5" /></button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Input value={val} onChange={(e) => setVal(e.target.value)} placeholder="Thêm giá trị, cách nhau bởi dấu phẩy" aria-label="Giá trị"
          enterKeyHint="done" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button variant="outline" onClick={add} className="shrink-0">Thêm</Button>
      </div>
    </div>
  );
}

export function ProductForm({ product }: { product?: ProductSnapshot }) {
  const router = useRouter();
  const qc = useQueryClient();
  const cats = useCategories();
  const flat = useMemo(() => flattenCategories(cats.data ?? []), [cats.data]);
  const init = useMemo(() => fromProduct(product), [product]);
  const [title, setTitle] = useState(product?.title ?? '');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [attrs, setAttrs] = useState<{ k: string; v: string }[]>(Object.entries(product?.attributes ?? {}).map(([k, v]) => ({ k, v })));
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [uploading, setUploading] = useState(0);
  const [options, setOptions] = useState<OptionDef[]>(init.options);
  const [variants, setVariants] = useState<Record<string, VariantDraft>>(init.variants);
  const [bulk, setBulk] = useState({ price: '', compareAtPrice: '', weightGrams: '' });
  const fileRef = useRef<HTMLInputElement>(null);

  const names = options.map((o) => o.name.trim()).filter(Boolean);
  const combos = cartesian(options);
  const rows = combos.map((opts) => {
    const k = keyOf(opts, names);
    const vals = names.map((n) => opts[n]).join('-');
    const d = variants[k] ?? { sku: `${skuBase(title)}${vals ? `-${skuBase(vals)}` : ''}`, price: '', compareAtPrice: '', weightGrams: '200', active: true };
    return { k, opts, d };
  });
  const setRow = (k: string, patch: Partial<VariantDraft>, base: VariantDraft) => setVariants((v) => ({ ...v, [k]: { ...base, ...v[k], ...patch } }));

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].slice(0, 9 - images.length);
    setUploading(list.length);
    for (const f of list) {
      try {
        const url = await uploadImage(f);
        setImages((x) => [...x, url]);
      } catch (e) {
        toast.error(`${f.name}: ${errorMessage(e)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const ai = useMutation({
    mutationFn: () => api.post<unknown>('/ai/generate/description', {
      title, attributes: Object.fromEntries(attrs.filter((a) => a.k.trim()).map((a) => [a.k.trim(), a.v.trim()])),
    }),
    onSuccess: (r) => {
      const text = typeof r === 'string' ? r : pick<string>(r, 'description', 'text', 'content', 'result');
      if (text) { setDescription(text); toast.success('AI đã viết mô tả — hãy kiểm tra lại trước khi lưu'); } else toast.error('AI chưa trả về mô tả');
    },
  });

  const buildBody = () => {
    const errs: string[] = [];
    if (title.trim().length < 5) errs.push('Tên sản phẩm tối thiểu 5 ký tự');
    if (!categoryId) errs.push('Chọn danh mục');
    if (!rows.length) errs.push('Cần ít nhất một phân loại');
    const vs: Partial<VariantSnapshot>[] = [];
    for (const r of rows) {
      if (!r.d.active) continue;
      const price = Number(r.d.price);
      if (!Number.isInteger(price) || price < 1000) { errs.push(`Giá của "${r.k || 'mặc định'}" phải ≥ 1.000 ₫`); continue; }
      vs.push({
        ...(r.d.id ? { id: r.d.id } : {}),
        sku: r.d.sku.trim(),
        options: r.opts,
        price,
        compareAtPrice: r.d.compareAtPrice ? Number(r.d.compareAtPrice) : null,
        weightGrams: Number(r.d.weightGrams) || 200,
        status: 'ACTIVE',
      });
    }
    if (!vs.length && rows.length) errs.push('Cần ít nhất một phân loại đang bán');
    if (errs.length) { toast.error(errs[0]); return null; }
    return {
      categoryId, title: title.trim(), description, brand: brand.trim() || null,
      attributes: Object.fromEntries(attrs.filter((a) => a.k.trim()).map((a) => [a.k.trim(), a.v.trim()])),
      images, variants: vs,
    };
  };

  const save = useMutation({
    mutationFn: async (andSubmit: boolean) => {
      const body = buildBody();
      if (!body) throw new Error('invalid');
      const saved = product
        ? await api.put<ProductSnapshot>(`/catalog/seller/products/${product.id}`, body)
        : await api.post<ProductSnapshot>('/catalog/seller/products', body);
      const id = saved?.id ?? product?.id;
      if (andSubmit && id) await api.post(`/catalog/seller/products/${id}/submit`);
      return { id, andSubmit };
    },
    onSuccess: ({ andSubmit }) => {
      toast.success(andSubmit ? 'Đã lưu và gửi duyệt' : 'Đã lưu sản phẩm');
      void qc.invalidateQueries({ queryKey: ['seller-products'] });
      void qc.invalidateQueries({ queryKey: ['seller-product'] });
      router.push('/seller/products');
    },
  });

  return (
    <div className="space-y-4 pb-24 md:pb-0">
      <Card className="space-y-4 p-3 md:p-5">
        <h2 className="font-semibold">Thông tin cơ bản</h2>
        <Field label="Tên sản phẩm" hint={`${title.length}/200`}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Danh mục">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{cats.isPending ? 'Đang tải…' : cats.isError ? 'Không tải được danh mục' : 'Chọn danh mục'}</option>
              {flat.map((c) => <option key={c.id} value={c.id}>{`${'— '.repeat(c.depth)}${c.name}`}</option>)}
            </Select>
          </Field>
          <Field label="Thương hiệu"><Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Không bắt buộc" /></Field>
        </div>
      </Card>

      <Card className="space-y-3 p-3 md:p-5">
        <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Hình ảnh</h2><span className="text-xs text-muted">{images.length}/9 · ảnh đầu là ảnh bìa</span></div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {images.map((src, i) => (
            <div key={src} className="relative">
              <Img src={src} alt={`Ảnh ${i + 1}`} />
              {i === 0 && <span className="absolute bottom-1 left-1 rounded bg-primary px-1.5 text-[10px] font-semibold text-primary-fg">Bìa</span>}
              <button type="button" aria-label="Xoá ảnh" onClick={() => setImages((x) => x.filter((s) => s !== src))}
                className="absolute right-1 top-1 grid size-8 place-items-center rounded-full bg-black/60 text-white"><X className="size-4" /></button>
              {i > 0 && (
                <button type="button" onClick={() => setImages((x) => [src, ...x.filter((s) => s !== src)])}
                  className="absolute bottom-1 right-1 min-h-7 rounded bg-black/60 px-1.5 text-[10px] text-white">Đặt bìa</button>
              )}
            </div>
          ))}
          {Array.from({ length: uploading }, (_, i) => (
            <div key={`u${i}`} className="grid aspect-square place-items-center rounded-lg bg-surface-2"><Loader2 className="size-5 animate-spin text-muted" /></div>
          ))}
          {images.length + uploading < 9 && (
            <button type="button" onClick={() => fileRef.current?.click()}
              className="grid aspect-square place-items-center rounded-lg border-2 border-dashed border-border text-muted hover:border-primary hover:text-primary">
              <span className="flex flex-col items-center gap-1 text-xs"><ImagePlus className="size-6" /> Thêm ảnh</span>
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
      </Card>

      <Card className="space-y-3 p-3 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Mô tả & thuộc tính</h2>
          <Button variant="secondary" size="sm" loading={ai.isPending} disabled={title.trim().length < 5} onClick={() => ai.mutate()}><Sparkles className="size-4" /> AI viết mô tả</Button>
        </div>
        <div className="space-y-2">
          {attrs.map((a, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
              <Input value={a.k} placeholder="Thuộc tính (VD: Chất liệu)" aria-label="Tên thuộc tính" onChange={(e) => setAttrs((x) => x.map((y, j) => (j === i ? { ...y, k: e.target.value } : y)))} />
              <Input value={a.v} placeholder="Giá trị" aria-label="Giá trị thuộc tính" onChange={(e) => setAttrs((x) => x.map((y, j) => (j === i ? { ...y, v: e.target.value } : y)))} />
              <Button variant="ghost" size="icon" aria-label="Xoá thuộc tính" onClick={() => setAttrs((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setAttrs((x) => [...x, { k: '', v: '' }])}><Plus className="size-4" /> Thêm thuộc tính</Button>
        </div>
        <Field label="Mô tả sản phẩm" hint={`${description.length}/10.000`}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={8} maxLength={10000} />
        </Field>
      </Card>

      <Card className="space-y-3 p-3 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Phân loại hàng & giá</h2>
          {options.length < 3 && <Button variant="outline" size="sm" onClick={() => setOptions((o) => [...o, { name: o.length ? 'Màu' : 'Size', values: [] }])}><Plus className="size-4" /> Thêm phân loại</Button>}
        </div>
        {options.length === 0 && <p className="text-sm text-muted">Sản phẩm một loại. Thêm phân loại (Size, Màu…) nếu có nhiều biến thể.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {options.map((o, i) => (
            <OptionEditor key={i} opt={o} onChange={(n) => setOptions((x) => x.map((y, j) => (j === i ? n : y)))} onRemove={() => setOptions((x) => x.filter((_, j) => j !== i))} />
          ))}
        </div>
        {rows.length > 1 && (
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-2 sm:grid-cols-4">
            <Input inputMode="numeric" placeholder="Giá" aria-label="Giá áp dụng hàng loạt" value={bulk.price} onChange={(e) => setBulk({ ...bulk, price: e.target.value.replace(/\D/g, '') })} />
            <Input inputMode="numeric" placeholder="Giá gốc" aria-label="Giá gốc hàng loạt" value={bulk.compareAtPrice} onChange={(e) => setBulk({ ...bulk, compareAtPrice: e.target.value.replace(/\D/g, '') })} />
            <Input inputMode="numeric" placeholder="Cân nặng (g)" aria-label="Cân nặng hàng loạt" value={bulk.weightGrams} onChange={(e) => setBulk({ ...bulk, weightGrams: e.target.value.replace(/\D/g, '') })} />
            <Button variant="outline" onClick={() => setVariants((v) => {
              const n = { ...v };
              for (const r of rows) {
                n[r.k] = { ...r.d, ...n[r.k], ...(bulk.price && { price: bulk.price }), ...(bulk.compareAtPrice && { compareAtPrice: bulk.compareAtPrice }), ...(bulk.weightGrams && { weightGrams: bulk.weightGrams }) };
              }
              return n;
            })}>Áp dụng cho tất cả</Button>
          </div>
        )}
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.k} className={cn('rounded-lg border border-border p-3', !r.d.active && 'opacity-60')}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{r.k || 'Mặc định'}</span>
                {rows.length > 1 && (
                  <label className="inline-flex min-h-9 shrink-0 items-center gap-2 text-xs">
                    <input type="checkbox" className="size-5 accent-[var(--app-primary)]" checked={r.d.active} onChange={(e) => setRow(r.k, { active: e.target.checked }, r.d)} /> Đang bán
                  </label>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Field label={<span className="text-xs text-muted">Giá (₫)</span>}><Input inputMode="numeric" value={r.d.price} onChange={(e) => setRow(r.k, { price: e.target.value.replace(/\D/g, '') }, r.d)} /></Field>
                <Field label={<span className="text-xs text-muted">Giá gốc (₫)</span>}><Input inputMode="numeric" value={r.d.compareAtPrice} onChange={(e) => setRow(r.k, { compareAtPrice: e.target.value.replace(/\D/g, '') }, r.d)} /></Field>
                <Field label={<span className="text-xs text-muted">SKU</span>}><Input value={r.d.sku} autoCapitalize="characters" onChange={(e) => setRow(r.k, { sku: e.target.value }, r.d)} /></Field>
                <Field label={<span className="text-xs text-muted">Cân nặng (g)</span>}><Input inputMode="numeric" value={r.d.weightGrams} onChange={(e) => setRow(r.k, { weightGrams: e.target.value.replace(/\D/g, '') }, r.d)} /></Field>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">Số lượng tồn kho chỉnh ở mục Tồn kho sau khi lưu sản phẩm.</p>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-border bg-surface px-4 pt-3 pb-[calc(12px+var(--safe-bottom))] md:static md:justify-end md:border-0 md:bg-transparent md:p-0">
        <Button variant="outline" className="flex-1 md:flex-none" loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Lưu nháp</Button>
        <Button className="flex-1 md:flex-none" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Lưu & gửi duyệt</Button>
      </div>
    </div>
  );
}
