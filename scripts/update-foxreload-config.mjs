import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const path = new URL('../wrangler.json', import.meta.url),
  config = JSON.parse(readFileSync(path, 'utf8'));
copyFileSync(path, new URL('../wrangler.json.backup-foxreload-' + Date.now(), import.meta.url));
config.triggers ??= {};
config.triggers.crons = [...new Set([...(config.triggers.crons || []), '*/15 * * * *'])];
config.vars ??= {};
config.vars.FOXRELOAD_LIVE_ENABLED ??= 'false';
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
console.log(
  'FoxReload configuration added. Existing DB, R2 and authentication settings preserved.',
);
