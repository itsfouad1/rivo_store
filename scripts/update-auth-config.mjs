// Run from your existing rivo-cloudflare folder: node scripts/update-auth-config.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
const file = 'wrangler.json';
if (!existsSync(file))
  throw new Error('Run this command inside your existing project folder containing wrangler.json');
const original = readFileSync(file, 'utf8');
let config;
try {
  config = JSON.parse(original);
} catch {
  throw new Error('wrangler.json must be valid JSON. No file was changed.');
}
if (
  !config.d1_databases?.some(
    (d) => d.binding === 'DB' && d.database_id && !d.database_id.includes('REPLACE_'),
  )
)
  throw new Error(
    'Your real D1 database_id is missing. Set it before running. No file was changed.',
  );
const vars = {
  SUPABASE_URL: 'https://atgxzobzrnjazrgimqqy.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_JQf6jNZOY79JBNcswt2MUg_frTiEQ3-',
};
config.vars = { ...config.vars, ...vars };
config.assets ??= { directory: './public', binding: 'ASSETS' };
if (config.assets.run_worker_first !== true) {
  const routes = Array.isArray(config.assets.run_worker_first)
    ? config.assets.run_worker_first
    : [];
  config.assets.run_worker_first = [
    ...new Set([
      ...routes,
      '/api/*',
      '/media/*',
      '/login',
      '/register',
      '/recover',
      '/admin',
      '/account',
      '/confirm',
    ]),
  ];
}
const backup = 'wrangler.json.backup-' + Date.now();
copyFileSync(file, backup);
writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(
  'Auth settings updated. Existing database/account/R2 settings preserved. Backup: ' + backup,
);
