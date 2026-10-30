import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Check literal local references without running application code or using the network.
const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = resolve(root, 'public');
const failures = [];
let checked = 0;
async function walk(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(folder, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return nested.flat();
}
async function reference(source, specifier, browser = false) {
  if (!specifier || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(specifier)) return;
  if (!browser && !specifier.startsWith('.') && !specifier.startsWith('/')) return;
  const clean = specifier.split(/[?#]/)[0];
  if (!clean) return;
  const target =
    browser && clean.startsWith('/')
      ? resolve(publicRoot, '.' + clean)
      : resolve(dirname(source), clean);
  if (browser && !(target === publicRoot || target.startsWith(publicRoot + sep))) {
    failures.push(`${relative(root, source)}: outside public: ${specifier}`);
    return;
  }
  checked++;
  try {
    await access(target);
  } catch {
    failures.push(`${relative(root, source)}: missing ${specifier}`);
  }
}
const config = JSON.parse(await readFile(resolve(root, 'wrangler.json'), 'utf8'));
await reference(resolve(root, 'wrangler.json'), './' + config.main);
if (config.assets?.directory !== './public') failures.push('Unexpected assets directory');
for (const folder of ['src', 'public', 'tests', 'scripts']) {
  for (const path of await walk(resolve(root, folder))) {
    const ext = extname(path);
    if (!['.mjs', '.js', '.html', '.css'].includes(ext)) continue;
    const text = await readFile(path, 'utf8');
    if (ext === '.mjs' || ext === '.js') {
      const imports = /\bfrom\s+['"]([^'"\n]+)['"]|\bimport(?:\s*\(\s*|\s+)['"]([^'"\n]+)['"]/g;
      for (const match of text.matchAll(imports)) {
        await reference(path, match[1] || match[2], path.startsWith(publicRoot + sep));
      }
      // Test fixtures read source files through import.meta.url.
      for (const match of (path.startsWith(resolve(root, 'tests') + sep) ? text : '').matchAll(
        /new URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
      )) {
        await reference(path, match[1]);
      }
    }
    if (ext === '.html') {
      for (const match of text.matchAll(
        /<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g,
      )) {
        await reference(path, match[1], true);
      }
    }
    if (ext === '.css') {
      for (const match of text.matchAll(/url\(\s*['"]?([^\s)'"\n]+)['"]?\s*\)/g)) {
        await reference(path, match[1], true);
      }
    }
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Project references OK (${checked} local paths checked). No remote services contacted.`,
  );
}
