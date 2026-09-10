// Syntax checks use Prettier's TypeScript parser. This is NOT a full typecheck/build.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { format } from 'prettier';
const root = path.resolve(import.meta.dirname, '..');
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      ['node_modules', '.git', '.next', 'var', 'artifacts'].includes(e.name)
        ? []
        : e.isDirectory()
          ? files(path.join(dir, e.name))
          : [path.join(dir, e.name)],
    );
}
const all = files(root);
const errors = [];
let checked = 0;
for (const file of all) {
  if (!/\.(ts|tsx|mjs)$/.test(file) || file.endsWith('.d.ts')) continue;
  const text = fs.readFileSync(file, 'utf8');
  try {
    await format(text, { filepath: file, parser: file.endsWith('.mjs') ? 'babel' : 'typescript' });
  } catch (e) {
    errors.push((e instanceof Error ? e.message : String(e)) + ': ' + path.relative(root, file));
  }
  checked++;
  for (const m of text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
    const spec = m[2];
    let base;
    if (spec.startsWith('.')) base = path.resolve(path.dirname(file), spec);
    else if (spec.startsWith('@/')) base = path.join(root, 'apps/web/src', spec.slice(2));
    else continue;
    if (
      ![base, base + '.ts', base + '.tsx', base + '.mjs', path.join(base, 'index.ts')].some((p) =>
        fs.existsSync(p),
      )
    )
      errors.push('Unresolved local import ' + spec + ': ' + path.relative(root, file));
  }
}
const original = fs.readFileSync(path.join(root, 'reference/intradocs-mockup_1.html'));
if (
  crypto.createHash('sha256').update(original).digest('hex') !==
  'f4aacfbc90a30a5e7b83370704de887b7804571d99b65614bee5104bf5745621'
)
  errors.push('Original mentor reference was modified.');
for (const p of [
  'help-center',
  'search',
  'katalog',
  'dokumen/[id]/[slug]',
  'unggah',
  'admin/approval',
  'admin/kategori-label',
  'admin/pengguna',
  'ai-assistant',
  'admin/dashboard',
])
  if (!fs.existsSync(path.join(root, 'apps/web/src/app/(portal)', p, 'page.tsx')))
    errors.push('Missing route ' + p);
const icons = fs.readFileSync(path.join(root, 'apps/web/public/icons.svg'), 'utf8');
for (const file of all.filter((f) => f.endsWith('.tsx'))) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/<Icon\s+name="([^"]+)"/g))
    if (!icons.includes(`id="ic-${m[1]}"`)) errors.push('Missing mentor icon ' + m[1]);
}
console.log(
  JSON.stringify(
    {
      scope:
        'TypeScript syntax (Prettier parser) + local imports + route/icon/reference integrity; NOT semantic typecheck or application build',
      filesChecked: checked,
      errors,
    },
    null,
    2,
  ),
);
if (errors.length) process.exitCode = 1;
