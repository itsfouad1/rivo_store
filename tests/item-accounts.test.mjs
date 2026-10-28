import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createStoreHandler } from '../lib/store-api.mjs';
import { createFoxreload } from '../lib/foxreload.mjs';
function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  for (const id of ['buyer', 'other', 'admin', 'support'])
    sql
      .prepare('INSERT INTO users VALUES (?,?,?,?)')
      .run(id, id + '@example.test', id, new Date().toISOString());
  sql
    .prepare('INSERT INTO settings VALUES (?,?)')
    .run('store', JSON.stringify({ whatsapp: '970599123456' }));
  for (const [currency, rate] of [
    ['USD', 1000000],
    ['ILS', 3700000],
    ['JOD', 710000],
    ['EGP', 50000000],
    ['SAR', 3750000],
    ['AED', 3670000],
    ['TRY', 34000000],
  ])
    sql
      .prepare('INSERT OR REPLACE INTO exchange_rates VALUES (?,?,?)')
      .run(currency, rate, new Date().toISOString());
  function prepare(q, args = []) {
    return {
      q,
      args,
      bind(...v) {
        return prepare(q, v);
      },
      async first() {
        return sql.prepare(q).get(...args) || null;
      },
      async all() {
        return { results: sql.prepare(q).all(...args) };
      },
      async run() {
        return sql.prepare(q).run(...args);
      },
    };
  }
  const db = {
    prepare,
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const result = statements.map((s) => sql.prepare(s.q).run(...s.args));
        sql.exec('COMMIT');
        return result;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const identity = async (req) => {
    const id = req.headers.get('who');
    return id
      ? {
          id,
          email: id + '@example.test',
          name: id,
          role: ['admin', 'support'].includes(id) ? id : 'customer',
        }
      : null;
  };
  const handler = createStoreHandler({
    db,
    resolveIdentity: identity,
    gatewayReady: true,
    gatewayMode: 'live',
  });
  const fox = createFoxreload(
    { DB: db, FOXRELOAD_API_KEY: 'test-only', FOXRELOAD_LIVE_ENABLED: 'false' },
    identity,
    async () => {
      throw Error('No remote execution in this test');
    },
  );
  async function request(path, method = 'GET', body, who = 'buyer', h = handler) {
    const r = await h(
      new Request('https://rivo.test' + path, {
        method,
        headers: { who, origin: 'https://rivo.test' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: r.status, data: await r.json() };
  }
  function product(name, required = true) {
    const id = crypto.randomUUID();
    sql
      .prepare(
        "INSERT INTO products(id,name,slug,category,description,price_cents,currency,image_url,status,payment_mode,region,player_id_required,supplier_product_id,sort_order,created_at,updated_at) VALUES (?,?,?,'Games','',1000,'USD','','active','both','',?,'',0,'2026','2026')",
      )
      .run(id, name, id, required ? 1 : 0);
    return id;
  }
  const create = (items, extra = {}) =>
    request('/api/orders', 'POST', {
      items,
      payment_method: 'whatsapp',
      display_currency: 'USD',
      idempotency_key: crypto.randomUUID(),
      ...extra,
    });
  return { sql, db, product, request, create, fox };
}
test('two products retain separate account IDs, cards stay empty, and private order access stays scoped', async () => {
  const x = setup(),
    a = x.product('Game A'),
    b = x.product('Game B'),
    c = x.product('Card', false);
  const r = await x.create([
    { id: a, quantity: 2, player_id: 'account-A' },
    { id: b, quantity: 1, player_id: 'account-B' },
    { id: c, quantity: 1, player_id: '' },
  ]);
  assert.equal(r.status, 201);
  const id = r.data.order_id;
  assert.equal(x.sql.prepare('SELECT player_id FROM orders WHERE id=?').get(id).player_id, '');
  for (const who of ['buyer', 'admin', 'support']) {
    const path =
      who === 'buyer'
        ? '/api/orders/'
        : who === 'admin'
          ? '/api/admin/orders/'
          : '/api/support/orders/';
    const result = await x.request(path + id, 'GET', undefined, who);
    assert.equal(result.status, 200);
    const items = result.data.order.items;
    assert.equal(items.find((i) => i.product_id === a).player_id, 'account-A');
    assert.equal(items.find((i) => i.product_id === b).player_id, 'account-B');
    assert.equal(items.find((i) => i.product_id === c).player_id, '');
    assert.ok(items.every((i) => i.input_source === 'item'));
  }
  assert.equal((await x.request('/api/orders/' + id, 'GET', undefined, 'other')).status, 404);
  const search = await x.request('/api/admin/orders?q=account-B', 'GET', undefined, 'admin');
  assert.equal(search.data.orders[0].id, id);
  const wa = decodeURIComponent(r.data.whatsapp_url);
  assert.ok(wa.includes('account-A') && wa.includes('account-B'));
});
test('required, malformed and irrelevant per-item inputs fail before saving an order or invoice', async () => {
  const x = setup(),
    a = x.product('Game'),
    card = x.product('Card', false);
  for (const items of [
    [{ id: a, quantity: 1, player_id: '' }],
    [{ id: a, quantity: 1, player_id: 123 }],
    [{ id: a, quantity: 1, player_id: 'x'.repeat(151) }],
    [{ id: a, quantity: 1, player_id: 'a\nb' }],
    [{ id: card, quantity: 1, player_id: 'unneeded' }],
    [null],
  ])
    assert.equal((await x.create(items)).status, 400);
  assert.equal(
    (
      await x.create([{ id: a, quantity: 1, player_id: '' }], {
        player_id: 'global-must-not-replace-explicit-empty',
      })
    ).status,
    400,
  );
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM order_item_accounts').get().n, 0);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM payunit_invoices').get().n, 0);
});
test('legacy clients stay compatible, historical shared data is labelled, retries never replace account snapshots', async () => {
  const x = setup(),
    p = x.product('Game'),
    token = crypto.randomUUID();
  const r = await x.create([{ id: p, quantity: 1 }], {
    player_id: 'old-shared',
    idempotency_key: token,
  });
  assert.equal(r.status, 201);
  const id = r.data.order_id;
  const retry = await x.create([{ id: p, quantity: 1, player_id: 'different' }], {
    idempotency_key: token,
  });
  assert.equal(retry.data.order_id, id);
  let detail = await x.request('/api/orders/' + id);
  assert.equal(detail.data.order.items[0].player_id, 'old-shared');
  // No account rows existed for orders placed before this migration.
  x.sql.prepare('DELETE FROM order_item_accounts').run();
  detail = await x.request('/api/orders/' + id);
  assert.equal(detail.data.order.items[0].input_source, 'legacy');
  assert.equal(detail.data.order.items[0].player_id, 'old-shared');
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
});
test('FoxReload per-line data matches the right item and never grants execution privileges', async () => {
  const x = setup(),
    a = x.product('Game A'),
    b = x.product('Game B');
  const r = await x.create([
    { id: a, quantity: 1, player_id: 'A-123' },
    { id: b, quantity: 1, player_id: 'B-456' },
  ]);
  const items = (await x.request('/api/orders/' + r.data.order_id)).data.order.items;
  for (const item of items)
    x.sql
      .prepare(
        "INSERT INTO fox_order_lines(item_id,remote_id,cost_units,delivery_type,note_schema,sale_usd_cents) VALUES (?,?,100,'direct_topup',?,1000)",
      )
      .run(
        item.id,
        'remote-' + item.product_id,
        JSON.stringify({ required: ['login'], types: { login: 'string' }, options: {} }),
      );
  const path = '/api/admin/foxreload/orders/' + r.data.order_id;
  const result = await x.request(path, 'GET', undefined, 'admin', x.fox.handle);
  assert.equal(result.status, 200);
  const byItem = new Map(result.data.items.map((i) => [i.item_id, i.player_id]));
  assert.equal(byItem.get(items.find((i) => i.product_id === a).id), 'A-123');
  assert.equal(byItem.get(items.find((i) => i.product_id === b).id), 'B-456');
  assert.equal((await x.request(path, 'GET', undefined, 'support', x.fox.handle)).status, 403);
  assert.equal((await x.request(path, 'GET', undefined, 'buyer', x.fox.handle)).status, 403);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM fox_jobs').get().n, 0);
});
test('supplier suggestion fills only an unambiguous identifier field and leaves legacy/multi-field input for review', () => {
  const code = readFileSync(new URL('../public/foxreload.js', import.meta.url), 'utf8');
  const suggest = runInNewContext(code + '\nfoxSavedNote');
  const item = { input_source: 'item', player_id: 'alpha_42' };
  const schema = { required: ['login'], types: { login: 'string' }, options: {} };
  assert.equal(suggest(item, schema).login, 'alpha_42');
  assert.equal(suggest({ ...item, input_source: 'legacy' }, schema).login, '');
  assert.equal(suggest(item, { ...schema, required: ['login', 'server'] }).login, '');
  assert.equal(suggest(item, { ...schema, required: ['email'] }).email, '');
  assert.equal(
    suggest(
      { input_source: 'item', player_id: '00123' },
      { ...schema, required: ['player_id'], types: { player_id: 'integer' } },
    ).player_id,
    '',
  );
  assert.equal(
    suggest(
      { input_source: 'item', player_id: '123' },
      { ...schema, required: ['player_id'], types: { player_id: 'integer' } },
    ).player_id,
    123,
  );
});
