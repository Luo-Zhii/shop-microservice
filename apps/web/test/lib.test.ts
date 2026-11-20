// Unit test phần logic thuần của web (không DOM): chuẩn hoá dữ liệu API, định dạng tiền/số, giỏ hàng.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asArray, formatCompact, formatNumber, formatVND, pick, statusOf, totalPages, variantLabel } from '../src/lib/format';
import { cartCount, normalizeCart } from '../src/lib/hooks';

const nbsp = (s: string) => s.replace(/\s/g, ' ');

test('định dạng tiền/số kiểu Việt Nam, null an toàn', () => {
  assert.equal(nbsp(formatVND(1_030_000)), '1.030.000 ₫');
  assert.equal(formatNumber(12345.6), '12.345,6');
  assert.equal(formatCompact(2_500_000), '2,5tr');
  assert.equal(formatCompact(1500), '1,5k');
  for (const f of [formatVND, formatNumber, formatCompact]) assert.equal(typeof f(null), 'string');
});

test('dữ liệu lỏng: asArray/pick chịu được hợp đồng lệch nhẹ', () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray({ items: [1] }), [1]);
  assert.deepEqual(asArray({ shops: [2] }, 'shops'), [2]);
  assert.deepEqual(asArray({ nothing: 1 }), []);
  assert.deepEqual(asArray(null), []);
  assert.equal(pick({ a: null, b: 0 }, 'a', 'b'), 0);
  assert.equal(pick('x', 'a'), undefined);
  assert.equal(totalPages(0, 20), 1);
  assert.equal(totalPages(41, 20), 3);
  assert.equal(variantLabel({ Màu: 'Đen', Size: 'M' }), 'Màu: Đen, Size: M');
  assert.deepEqual(statusOf({ OPEN: { label: 'Mở', tone: 'warning' } }, 'LẠ'), { label: 'LẠ', tone: 'neutral' });
});

test('giỏ hàng: nhóm theo shop từ danh sách phẳng, đánh dấu đổi giá từ warnings, lọc shop rỗng', () => {
  const cart = normalizeCart({
    cartId: 'c1',
    items: [
      { skuId: 's1', shopId: 'A', shopName: 'Shop A', productTitle: 'Áo', currentPrice: 90_000, quantity: 2 },
      { skuId: 's2', shopId: 'B', name: 'Quần', price: 200_000, purchasable: false },
      { skuId: 's3', shopId: 'A', title: 'Mũ', price: 50_000, qty: 1 },
    ],
    warnings: [
      { code: 'PRICE_CHANGED', skuId: 's1', oldPrice: 100_000, message: 'Giá đổi' },
      { code: 'INVENTORY_DEGRADED', message: 'Không kiểm được tồn kho' },
    ],
  });
  assert.equal(cart.cartId, 'c1');
  assert.deepEqual(cart.shops.map((s) => [s.shopId, s.items.length]), [['A', 2], ['B', 1]]);
  const ao = cart.shops[0].items[0];
  assert.deepEqual([ao.title, ao.qty, ao.price, ao.addedPrice, ao.priceChanged], ['Áo', 2, 90_000, 100_000, true]);
  assert.equal(cart.shops[1].items[0].status, 'INACTIVE');
  assert.deepEqual(cart.notices, ['Không kiểm được tồn kho']);
  assert.equal(cartCount(cart), 3); // badge giỏ = số dòng hàng, không phải tổng số lượng
});

test('giỏ hàng: dạng đã nhóm sẵn {shops:[{items}]} giữ nguyên nhóm, shop không còn món bị bỏ', () => {
  const cart = normalizeCart({ shops: [{ shopId: 'A', name: 'A', items: [{ skuId: 'x', price: 1, qty: 3 }] }, { id: 'B', items: [] }] });
  assert.deepEqual(cart.shops.map((s) => s.shopId), ['A']);
  assert.equal(cartCount(cart), 1);
  assert.equal(cartCount(undefined), 0);
});
