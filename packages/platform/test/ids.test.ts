import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, foldVietnamese, parsePage, newId } from '../src/ids';

test('slugify bỏ dấu tiếng Việt', () => {
  assert.equal(slugify('Áo Thun Nam Đẹp!'), 'ao-thun-nam-dep');
  assert.equal(foldVietnamese('Điện thoại'), 'Dien thoai');
});
test('parsePage giới hạn pageSize', () => {
  assert.deepEqual(parsePage({ page: '2', pageSize: '500' }), { page: 2, pageSize: 100, offset: 100, limit: 100 });
});
test('newId là uuid v7', () => {
  assert.match(newId(), /^[0-9a-f-]{36}$/);
});
