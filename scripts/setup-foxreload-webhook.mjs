// API key arrives through stdin; never pass it in a command-line argument.
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url),
  recovery = new URL('../.foxreload-webhook-secret', import.meta.url);
const url = 'https://rivo-store.rivo1.workers.dev/api/webhooks/foxreload';
try {
  let secret;
  if (existsSync(recovery)) {
    secret = readFileSync(recovery, 'utf8').trim();
    console.log('Retrying storage of the existing webhook secret.');
  } else {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const key = input.trim();
    if (!key) throw Error('API key is required on stdin.');
    async function call(path, method = 'GET', body) {
      const r = await fetch('https://public-api.foxreload.com' + path, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw Error('FoxReload returned HTTP ' + r.status);
      return r.json();
    }
    const existing = await call('/api/webhooks/');
    const entries = Array.isArray(existing) ? existing : existing.items;
    if (!Array.isArray(entries)) throw Error('Unexpected webhook list response.');
    if (entries.some((x) => x.url === url))
      throw Error(
        'This URL is already registered. Use its existing signing secret, or rotate it deliberately from FoxReload.',
      );
    const created = await call('/api/webhooks/', 'POST', {
      name: 'RIVO order delivery',
      url,
      events: ['order.completed'],
    });
    if (typeof created.secret !== 'string' || !created.secret)
      throw Error('No signing secret received.');
    secret = created.secret;
    writeFileSync(recovery, secret, { mode: 0o600, flag: 'wx' });
  }
  const command = fileURLToPath(
    new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
  );
  const r = spawnSync(process.execPath, [command, 'secret', 'put', 'FOXRELOAD_WEBHOOK_SECRET'], {
    cwd: fileURLToPath(root),
    input: secret + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0)
    throw Error(
      'Cloudflare secret was not stored. The recovery file is kept locally; rerun this script after fixing Wrangler login.',
    );
  unlinkSync(recovery);
  console.log('Webhook registered and signing secret stored in Cloudflare.');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
