// In ra JSON danh sách image cần build theo các file thay đổi (so với BASE_SHA). Chỉ build service bị ảnh hưởng.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('./services.json', import.meta.url), 'utf8'));
const base = process.env.BASE_SHA;
const all = process.env.FORCE_ALL === 'true' || !base || /^0+$/.test(base);
const files = all ? [] : execSync(`git diff --name-only ${base} HEAD`, { encoding: 'utf8' }).split('\n').filter(Boolean);

const toRe = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$');
const hit = (globs) => files.some((f) => globs.some((g) => toRe(g).test(f)));
const sharedHit = hit(cfg.shared);

const out = Object.entries(cfg.images)
  .filter(([name, img]) => all || hit(img.paths) || (sharedHit && (cfg.node.includes(name) || name === 'web')))
  .map(([name, img]) => ({ name, ...img }));
process.stdout.write(JSON.stringify(out));
