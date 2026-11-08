#!/usr/bin/env node
// Chạy TUẦN TỰ mọi bộ test (tránh tràn RAM) và sinh docs/thesis/test-report.md từ kết quả thật.
//   node tools/test-report/run.mjs [--only node,go,python] [--skip-go]
// Cần: hạ tầng dev (pnpm infra:up), .venv cho Python, docker cho Go.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only='))?.split('=')[1] ?? 'node,go,python').split(',');
const suites = [];

function run(cmd, argv, cwd, env = {}) {
  const t = Date.now();
  const r = spawnSync(cmd, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, code: r.status ?? 1, ms: Date.now() - t };
}

// ---- Node (node:test, reporter TAP) ----
function parseTap(out) {
  const cases = [];
  const stack = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\s*)(ok|not ok) \d+ - (.+?)(\s+#\s*(SKIP|TODO).*)?$/);
    if (!m) continue;
    const depth = m[1].length / 4;
    stack.length = depth;
    stack[depth] = m[3];
    // chỉ lấy nút lá: subtest có nhãn suite sẽ được ghép tên cha
    cases.push({ name: stack.filter(Boolean).join(' › '), ok: m[2] === 'ok', skip: Boolean(m[5]), depth });
  }
  // bỏ các dòng tổng hợp của file (depth 0 trùng tên file) nếu có con
  return cases.filter((c, i) => !(cases[i + 1] && cases[i + 1].depth > c.depth));
}

if (only.includes('node')) {
  const dirs = ['packages/platform', ...readdirSync(join(ROOT, 'services')).map((d) => `services/${d}`)];
  for (const dir of dirs) {
    const testDir = join(ROOT, dir, 'test');
    if (!existsSync(join(ROOT, dir, 'package.json')) || !existsSync(testDir)) continue;
    const files = readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
    if (!files.length) continue;
    process.stdout.write(`▶ ${dir} … `);
    const r = run(join(ROOT, 'node_modules/.bin/tsx'), ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], join(ROOT, dir));
    const cases = parseTap(r.out);
    suites.push({ name: dir, lang: 'Node/TS', cases, ms: r.ms, code: r.code });
    console.log(`${cases.filter((c) => c.ok).length}/${cases.length} (${(r.ms / 1000).toFixed(1)}s)`);
  }
}

// ---- Go (go test -json trong container golang) ----
if (only.includes('go') && !args.includes('--skip-go') && existsSync(join(ROOT, 'services/inventory/go.mod'))) {
  process.stdout.write('▶ services/inventory (Go) … ');
  const r = run('docker', [
    'run', '--rm', '--network', 'host', '-v', `${join(ROOT, 'services/inventory')}:/src`, '-v', 'shopnow-gomod:/go/pkg/mod',
    '-v', 'shopnow-gocache:/root/.cache/go-build', '-w', '/src', '-e', 'TEST_DATABASE_URL=postgres://shopnow:shopnow@localhost:55432/postgres?sslmode=disable',
    'golang:1.23-alpine', 'go', 'test', '-json', '-count=1', './...',
  ], ROOT);
  const cases = [];
  for (const line of r.out.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.Test && (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip')) {
        cases.push({ name: `${e.Package.split('/').pop()} › ${e.Test}`, ok: e.Action !== 'fail', skip: e.Action === 'skip' });
      }
    } catch {}
  }
  suites.push({ name: 'services/inventory', lang: 'Go', cases, ms: r.ms, code: r.code });
  console.log(`${cases.filter((c) => c.ok).length}/${cases.length}`);
}

// ---- Python (pytest --junitxml) ----
const py = join(ROOT, '.venv/bin/python');
if (only.includes('python') && existsSync(py)) {
  for (const dir of ['services/ai-service', 'aiops']) {
    if (!existsSync(join(ROOT, dir))) continue;
    process.stdout.write(`▶ ${dir} (Python) … `);
    const xml = join(ROOT, '.dev', `junit-${dir.replace('/', '-')}.xml`);
    mkdirSync(join(ROOT, '.dev'), { recursive: true });
    const r = run(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${xml}`], join(ROOT, dir));
    const cases = [];
    if (existsSync(xml)) {
      const s = readFileSync(xml, 'utf8');
      for (const m of s.matchAll(/<testcase classname="([^"]*)" name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const body = m[4] ?? '';
        cases.push({ name: `${m[1].split('.').pop()} › ${m[2]}`, ok: !/<(failure|error)/.test(body), skip: /<skipped/.test(body) });
      }
    }
    suites.push({ name: dir, lang: 'Python', cases, ms: r.ms, code: r.code });
    console.log(`${cases.filter((c) => c.ok).length}/${cases.length}`);
  }
}

// ---- Báo cáo ----
const total = suites.reduce((n, s) => n + s.cases.length, 0);
const passed = suites.reduce((n, s) => n + s.cases.filter((c) => c.ok).length, 0);
const esc = (s) => s.replace(/\|/g, '\\|');
let md = `# Báo cáo kiểm thử tự động\n\nSinh tự động bởi \`tools/test-report/run.mjs\` lúc ${new Date().toISOString()} trên máy dev.\n\n`;
md += `**Tổng: ${passed}/${total} test đạt** (${suites.length} bộ test, chạy tuần tự).\n\n`;
md += '| Bộ test | Ngôn ngữ | Đạt | Tổng | Thời gian | Kết quả |\n|---|---|---|---|---|---|\n';
for (const s of suites) {
  const p = s.cases.filter((c) => c.ok).length;
  md += `| ${s.name} | ${s.lang} | ${p} | ${s.cases.length} | ${(s.ms / 1000).toFixed(1)}s | ${s.code === 0 && p === s.cases.length ? '✅' : '❌'} |\n`;
}
for (const s of suites) {
  md += `\n## ${s.name}\n\n| # | Test | Kết quả |\n|---|---|---|\n`;
  s.cases.forEach((c, i) => (md += `| ${i + 1} | ${esc(c.name)} | ${c.skip ? '⏭ bỏ qua' : c.ok ? '✅' : '❌'} |\n`));
}
writeFileSync(join(ROOT, 'docs/thesis/test-report.md'), md);
console.log(`\n${passed}/${total} đạt → docs/thesis/test-report.md`);
process.exit(passed === total ? 0 : 1);
