// Bundle một service Node thành dist/main.js (CJS). Gói workspace @shopnow/* được nhúng vào bundle,
// mọi dependency npm khác để external (OpenTelemetry cần require-hook vào pg/kafkajs/ioredis...).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@shopnow/'));
const platformPkg = JSON.parse(readFileSync(new URL('../packages/platform/package.json', import.meta.url), 'utf8'));
external.push(...Object.keys(platformPkg.dependencies ?? {}).filter((d) => !d.startsWith("@shopnow/")));

await build({
  entryPoints: [join(cwd, 'src/main.ts')],
  outfile: join(cwd, 'dist/main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: [...new Set(external)],
  logLevel: 'info',
});
