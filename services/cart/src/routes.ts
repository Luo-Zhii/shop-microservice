import { AppError, badRequest, conflict, newId, notFound, requireUser, z, type Auth, type FastifyInstance, type FastifyRequest, type Logger } from '@shopnow/platform';
import type { CatalogPort, InventoryPort } from './clients';
import { MAX_LINES, MAX_QTY, type CartRef, type CartStore } from './store';
import { buildCartView } from './view';

export interface CartDeps {
  store: CartStore;
  auth: Auth;
  catalog: CatalogPort;
  inventory: InventoryPort;
  log: Logger;
}

const CART_ID = /^[A-Za-z0-9_-]{8,64}$/;
const qty = z.number().int().min(1, 'Số lượng tối thiểu là 1').max(MAX_QTY, `Số lượng tối đa là ${MAX_QTY}`);
const addInput = z.object({ skuId: z.string().uuid('skuId không hợp lệ'), qty: qty.default(1) });
const setInput = z.object({ qty });
const mergeInput = z.object({ guestCartId: z.string().regex(CART_ID, 'guestCartId không hợp lệ') });

function guestIdFrom(req: FastifyRequest): string | undefined {
  const h = req.headers['x-cart-id'];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return undefined;
  if (!CART_ID.test(v)) throw badRequest('Header x-cart-id không hợp lệ');
  return v;
}

/** Đăng nhập → giỏ theo userId; khách → theo x-cart-id (tạo mới khi cần). */
function cartRef(req: FastifyRequest, create: boolean): CartRef | null {
  if (req.user) return { kind: 'user', id: req.user.id };
  const g = guestIdFrom(req);
  if (g) return { kind: 'guest', id: g };
  return create ? { kind: 'guest', id: newId() } : null;
}

export function registerRoutes(app: FastifyInstance, deps: CartDeps) {
  const { store, auth, catalog, inventory } = deps;
  const opt = { preHandler: auth.optionalAuth };
  const view = (ref: CartRef | null) => buildCartView(deps, ref);

  app.addHook('onSend', async (req, reply) => {
    const id = (req as FastifyRequest & { cartId?: string }).cartId;
    if (id) reply.header('x-cart-id', id);
  });
  const remember = (req: FastifyRequest, ref: CartRef | null) => {
    if (ref?.kind === 'guest') (req as FastifyRequest & { cartId?: string }).cartId = ref.id;
  };

  app.get('/cart', opt, async (req) => {
    const ref = cartRef(req, false);
    remember(req, ref);
    return view(ref);
  });

  app.post('/cart/items', opt, async (req) => {
    const b = addInput.parse(req.body);
    const ref = cartRef(req, true)!;
    const [sku] = await catalog.getSkus([b.skuId]);
    if (!sku) throw notFound('Sản phẩm không tồn tại');
    if (!sku.purchasable) throw conflict('Sản phẩm hiện ngừng bán');
    const current = (await store.list(ref)).find((l) => l.skuId === b.skuId)?.qty ?? 0;
    const want = Math.min(MAX_QTY, current + b.qty);
    const stock = await inventory.getStock([b.skuId]).catch(() => null); // inventory chết → vẫn cho thêm
    const available = stock?.get(b.skuId);
    if (available !== undefined && available < want) {
      throw new AppError('INSUFFICIENT_STOCK', available <= 0 ? 'Sản phẩm đã hết hàng' : `Chỉ còn ${available} sản phẩm`, { skuId: b.skuId, available });
    }
    const n = await store.add(ref, b.skuId, b.qty, sku.price);
    if (n === -1) throw badRequest(`Giỏ hàng tối đa ${MAX_LINES} sản phẩm khác nhau`);
    remember(req, ref);
    return view(ref);
  });

  app.put<{ Params: { skuId: string } }>('/cart/items/:skuId', opt, async (req) => {
    const b = setInput.parse(req.body);
    const ref = cartRef(req, false);
    if (!ref) throw notFound('Sản phẩm không có trong giỏ');
    const n = await store.set(ref, req.params.skuId, b.qty);
    if (n === -2) throw notFound('Sản phẩm không có trong giỏ');
    remember(req, ref);
    return view(ref);
  });

  app.delete<{ Params: { skuId: string } }>('/cart/items/:skuId', opt, async (req) => {
    const ref = cartRef(req, false);
    if (ref) await store.remove(ref, [req.params.skuId]);
    remember(req, ref);
    return view(ref);
  });

  app.post('/cart/merge', { preHandler: auth.authenticate }, async (req) => {
    const user = requireUser(req);
    const b = mergeInput.parse(req.body);
    const r = await store.merge(b.guestCartId, user.id);
    const cart = await view({ kind: 'user', id: user.id });
    return { ...cart, merged: r.merged, skipped: r.skipped };
  });
}
