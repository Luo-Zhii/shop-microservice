import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { flagsSnapshot, flagValue, isEnabled } from '../src/flags';
import { registry } from '../src/metrics';

const file = join(mkdtempSync(join(tmpdir(), 'flags-')), 'flags.json');
const write = (flags: unknown, t: number) => {
  writeFileSync(file, typeof flags === 'string' ? flags : JSON.stringify({ flags }));
  utimesSync(file, t / 1000, t / 1000);
};
const flag = (on: boolean, state = 'ENABLED') => ({ state, variants: { on: true, off: false }, defaultVariant: on ? 'on' : 'off' });

test('chưa có file → giá trị mặc định do code truyền (fail-safe)', () => {
  process.env.FLAGS_FILE = join(tmpdir(), 'khong-co-file-nay.json');
  assert.equal(isEnabled('recommendations', true, 1_000), true);
  assert.equal(isEnabled('recommendations', false, 1_000), false);
});

test('đọc flagd JSON, tắt tại chỗ không cần restart, file hỏng giữ bản tốt gần nhất', async () => {
  process.env.FLAGS_FILE = file;
  write({ recommendations: flag(true), 'search-suggest': flag(true), limit: { state: 'ENABLED', variants: { low: 5, high: 50 }, defaultVariant: 'high' } }, 10_000);
  assert.equal(isEnabled('recommendations', true, 10_000), true);
  assert.equal(flagValue('limit', 1, 10_000), 50);
  // kill switch: GitOps đổi defaultVariant → off; trong cửa sổ 5s vẫn dùng bản cũ, sau đó đọc bản mới
  write({ recommendations: flag(false), 'search-suggest': flag(true) }, 20_000);
  assert.equal(isEnabled('recommendations', true, 12_000), true);
  assert.equal(isEnabled('recommendations', true, 20_000), false);
  assert.equal(isEnabled('search-suggest', true, 20_000), true);
  // flag DISABLED hoặc không có → mặc định; sai kiểu variant → mặc định
  write({ recommendations: flag(false, 'DISABLED'), weird: { state: 'ENABLED', variants: { on: 'yes' }, defaultVariant: 'on' } }, 30_000);
  assert.equal(isEnabled('recommendations', true, 30_000), true);
  assert.equal(isEnabled('weird', false, 30_000), false);
  assert.equal(isEnabled('missing', true, 30_000), true);
  // file hỏng (kubelet đang đổi symlink) → giữ bản tốt gần nhất
  write('{"flags": {', 40_000);
  assert.equal(isEnabled('recommendations', true, 40_000), true);
  assert.deepEqual(flagsSnapshot(40_000).recommendations, { enabled: null, variant: 'off', state: 'DISABLED' });
  const text = await registry.metrics();
  assert.match(text, /feature_flag_evaluations_total\{flag="recommendations",variant="off",reason="STATIC"\} 1/);
  assert.match(text, /feature_flag_evaluations_total\{flag="recommendations",variant="fallback",reason="DISABLED"\}/);
});
