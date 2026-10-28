import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStoreHandler } from '../lib/store-api.mjs';
import { createFoxreload } from '../lib/foxreload.mjs';
import { steamLogin, steamCost } from '../lib/steam.mjs';
function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  for (const id of ['buyer', 'other', 'admin', 'support'])
    sql
      .prepare('INSERT INTO users VALUES (?,?,?,?)')
      .run(id, id + '@example.test', id, new Date().toISOString());
  sql
    .prepare('INSERT INTO settings VALUES (?,?)')
    .run('store', JSON.stringify({ whatsapp: '970599123456' }));
  for (const [c, n] of [
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
      .run(c, n, new Date().toISOString());
  function p(q, args = []) {
    return {
      q,
      args,
      bind(...v) {
        return p(q, v);
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
    prepare: p,
    async batch(ss) {
      sql.exec('BEGIN');
      try {
        const r = ss.map((s) => sql.prepare(s.q).run(...s.args));
        sql.exec('COMMIT');
        return r;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const identity = async (r) => {
    const id = r.headers.get('who');
    return id
      ? {
          id,
          email: id + '@example.test',
          name: id,
          role: ['admin', 'support'].includes(id) ? id : 'customer',
        }
      : null;
  };
  const product = {
    id: 'real_test_service',
    name: 'Steam wallet Main',
    description: 'Supported test region',
    price: '0.9550',
    currency: 'usd',
    quantity: 10000,
    orderMinQuantity: 5,
    orderMaxQuantity: 500,
    deliveryType: 'direct_topup',
    requiredNoteFields: ['login'],
    noteFieldTypes: { login: 'string' },
    noteFieldOptions: {},
  };
  const counts = { check: 0, create: 0, pay: 0 },
    remote = new Map();
  let valid = true,
    unavailable = false,
    actualPrice = null;
  const fetcher = async (url, init) => {
    const u = new URL(url);
    assert.equal(init.headers['X-API-Key'], 'test-key');
    if (u.pathname === '/api/products/' + product.id) return Response.json(product);
    if (u.pathname === '/api/categories/') {
      assert.equal(u.searchParams.get('limit'), '50');
      return Response.json({
        items: [{ id: 'steam-category', name: 'Steam', parentId: null }],
        nextCursor: null,
      });
    }
    if (u.pathname === '/api/products/')
      return Response.json({ items: [product], nextCursor: null });
    if (u.pathname === '/api/steam/check-login') {
      counts.check++;
      if (unavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({
        login: u.searchParams.get('login'),
        isValid: valid,
        checkedAt: new Date().toISOString(),
      });
    }
    if (u.pathname === '/api/orders/' && init.method === 'GET')
      return Response.json({
        items: [...remote.values()].filter(
          (o) => o.idempotencyKey === u.searchParams.get('idempotencyKey'),
        ),
      });
    if (u.pathname === '/api/orders/' && init.method === 'POST') {
      counts.create++;
      const b = JSON.parse(init.body),
        i = b.items[0],
        id = crypto.randomUUID();
      const o = {
        id,
        idempotencyKey: b.idempotencyKey,
        isMock: b.isMock,
        status: 'active',
        currency: 'usd',
        price: actualPrice ?? (Number(product.price) * i.quantity).toFixed(8),
        items: [{ product: { id: i.itemId }, quantity: i.quantity, externalData: [] }],
      };
      remote.set(id, o);
      return Response.json(o);
    }
    const m = u.pathname.match(/^\/api\/orders\/([^/]+)(\/pay)?$/);
    if (m) {
      const o = remote.get(m[1]);
      if (m[2]) {
        counts.pay++;
        o.status = 'completed';
      }
      return Response.json(o);
    }
    throw Error('Unexpected remote URL');
  };
  const fox = createFoxreload(
      { DB: db, FOXRELOAD_API_KEY: 'test-key', FOXRELOAD_LIVE_ENABLED: 'true' },
      identity,
      fetcher,
    ),
    store = createStoreHandler({
      db,
      foxEnabled: true,
      resolveIdentity: identity,
      gatewayReady: true,
      gatewayMode: 'live',
    });
  async function request(path, method = 'GET', body, who = 'admin', origin = 'https://rivo.test') {
    const r = new Request('https://rivo.test' + path, {
      method,
      headers: { ...(who ? { who } : {}), origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = (await fox.handle(r)) || (await store(r));
    return { status: out.status, data: await out.json() };
  }
  const importBody = {
    remote_id: product.id,
    amount: 10,
    regions: 'Test region',
    markup_bps: 1000,
    confirm_usd_unit: true,
  };
  async function imported(amount = 10) {
    const r = await request('/api/admin/foxreload/steam/import', 'POST', { ...importBody, amount });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    sql.prepare("UPDATE products SET status='active' WHERE id=?").run(r.data.product_id);
    return r.data.product_id;
  }
  const check = (id, login = 'steam_user', who = 'buyer') =>
    request('/api/steam/check-login', 'POST', { product_id: id, login }, who);
  const order = (id, login = 'steam_user', extra = {}) =>
    request(
      '/api/orders',
      'POST',
      {
        items: [{ id, quantity: 1, player_id: login }],
        payment_method: 'whatsapp',
        display_currency: 'USD',
        idempotency_key: crypto.randomUUID(),
        ...extra,
      },
      'buyer',
    );
  const unlock = () => sql.prepare("UPDATE steam_limits SET next_at=0 WHERE id='global'").run();
  return {
    sql,
    request,
    product,
    counts,
    importBody,
    imported,
    check,
    order,
    unlock,
    remote,
    setValid(v) {
      valid = v;
    },
    setUnavailable(v) {
      unavailable = v;
    },
    setActualPrice(v) {
      actualPrice = v;
    },
  };
}
test('Steam discovery is staff scoped; denominations use server unit cost and remain drafts', async () => {
  const x = setup();
  assert.equal(
    (await x.request('/api/admin/foxreload/categories', 'GET', undefined, 'support')).status,
    403,
  );
  assert.equal((await x.request('/api/admin/foxreload/categories')).data.items[0].name, 'Steam');
  assert.equal(
    (await x.request('/api/admin/foxreload/product?id=' + x.product.id)).data.product.id,
    x.product.id,
  );
  for (const extra of [
    { confirm_usd_unit: false },
    { amount: 501 },
    { amount: 3 },
    { regions: '' },
  ])
    assert.equal(
      (await x.request('/api/admin/foxreload/steam/import', 'POST', { ...x.importBody, ...extra }))
        .status,
      400,
    );
  const a = await x.request('/api/admin/foxreload/steam/import', 'POST', x.importBody);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const p = x.sql.prepare('SELECT * FROM products WHERE id=?').get(a.data.product_id);
  assert.equal(p.status, 'draft');
  assert.equal(p.price_cents, 1051);
  assert.equal(p.player_id_required, 1);
  const b = await x.imported(100);
  assert.equal(
    x.sql.prepare('SELECT cost_units FROM fox_products WHERE product_id=?').get(b).cost_units,
    955000,
  );
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM fox_products').get().n, 2);
});
test('Steam check is authenticated, origin protected, validated, cached and limited across users', async () => {
  const x = setup(),
    id = await x.imported();
  assert.equal(
    (
      await x.request(
        '/api/steam/check-login',
        'POST',
        { product_id: id, login: 'steam_user' },
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await x.request(
        '/api/steam/check-login',
        'POST',
        { product_id: id, login: 'steam_user' },
        'buyer',
        'https://other.test',
      )
    ).status,
    403,
  );
  for (const login of ['https://steam.test/user', 'name with space', 'x\ny', 'x'.repeat(65)])
    assert.equal((await x.check(id, login)).status, 400);
  assert.equal((await x.check(id)).data.isValid, true);
  assert.equal((await x.check(id)).status, 200);
  assert.equal(x.counts.check, 1);
  assert.equal((await x.check(id, 'other_name', 'other')).status, 429);
  assert.equal(x.counts.check, 1);
  x.unlock();
  x.setValid(false);
  assert.equal((await x.check(id, 'bad_name')).data.isValid, false);
  assert.equal((await x.order(id, 'bad_name')).status, 409);
  x.unlock();
  x.setUnavailable(true);
  assert.equal((await x.check(id, 'new_name')).status, 503);
  assert.equal((await x.order(id, 'new_name')).status, 409);
  assert.equal(x.counts.create, 0);
});
test('Steam order requires fresh account verdict tied to buyer, product and name; no client price or amount override', async () => {
  const x = setup(),
    id = await x.imported();
  assert.equal((await x.order(id)).status, 409);
  assert.equal((await x.check(id)).status, 200);
  assert.equal((await x.order(id, 'changed')).status, 409);
  assert.equal((await x.check(id, 'steam_user', 'other')).status, 429);
  const o = await x.order(id, 'steam_user', { amount: 500, price_cents: 1 });
  assert.equal(o.status, 201);
  const row = x.sql.prepare('SELECT * FROM fox_order_lines').get();
  assert.equal(row.supplier_quantity, 10);
  assert.equal(row.cost_units, 95500);
  x.sql.prepare('UPDATE steam_checks SET expires_at=0').run();
  assert.equal((await x.order(id)).status, 409);
});
test('Steam mock sends amount as supplier quantity and exact saved login, with no customer fulfillment', async () => {
  const x = setup(),
    id = await x.imported(100);
  await x.check(id);
  const o = await x.order(id);
  assert.equal(o.status, 201);
  const item = x.sql.prepare('SELECT id FROM order_items').get().id;
  assert.equal(
    (
      await x.request('/api/admin/foxreload/execute', 'POST', {
        item_id: item,
        mock: true,
        note: { login: 'wrong' },
      })
    ).status,
    409,
  );
  const b = { item_id: item, mock: true, note: { login: 'steam_user' } };
  const r = await x.request('/api/admin/foxreload/execute', 'POST', b);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'completed');
  const payload = JSON.parse(x.sql.prepare('SELECT request_json FROM fox_jobs').get().request_json);
  assert.equal(payload.items[0].quantity, 100);
  assert.equal(payload.items[0].totalPrice, undefined);
  assert.equal(payload.items[0].note.login, 'steam_user');
  await x.request('/api/admin/foxreload/execute', 'POST', b);
  assert.equal(x.counts.create, 1);
  assert.equal(x.counts.pay, 1);
  assert.equal(x.sql.prepare('SELECT status FROM orders').get().status, 'contact_pending');
});
test('Steam live keeps payment, price ceiling and second login check guards; sync uses denomination cost', async () => {
  const x = setup(),
    id = await x.imported();
  await x.check(id);
  const o = await x.order(id);
  const item = x.sql.prepare('SELECT id FROM order_items').get().id,
    b = { item_id: item, mock: false, confirm: true, note: { login: 'steam_user' } };
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  assert.equal(x.counts.create, 0);
  x.sql.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(o.data.order_id);
  x.unlock();
  x.setValid(false);
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  assert.equal(x.counts.create, 0);
  x.unlock();
  x.setValid(true);
  x.product.price = '1.1000';
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  assert.equal(x.counts.pay, 0);
  await x.request('/api/admin/foxreload/sync', 'POST', { product_id: id });
  assert.equal(
    x.sql.prepare('SELECT cost_units FROM fox_products WHERE product_id=?').get(id).cost_units,
    110000,
  );
  assert.equal(
    x.sql.prepare('SELECT price_cents FROM products WHERE id=?').get(id).price_cents,
    1210,
  );
  x.product.price = '0.9550';
  const done = await x.request('/api/admin/foxreload/execute', 'POST', b);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(x.counts.pay, 1);
  assert.equal(x.sql.prepare('SELECT status FROM orders').get().status, 'completed');
});
test('Steam account parser rejects whitespace, URLs and control characters', () => {
  assert.equal(steamLogin('account_123'), 'account_123');
  for (const s of [' account', 'a b', 'a@b.com', 'a\n', null]) assert.throws(() => steamLogin(s));
});
test('supplier eight-decimal Steam prices multiply before rounding; real total is checked before pay', async () => {
  assert.equal(steamCost('0.95488125', 100), 954882);
  assert.equal(steamCost('0.95488125', 10), 95489);
  for (const s of ['-1', '1e3', 'NaN', '0.1234567890123']) assert.throws(() => steamCost(s));
  const x = setup();
  x.product.price = '0.95488125';
  const id = await x.imported(100);
  assert.equal(x.sql.prepare('SELECT cost_units FROM fox_products').get().cost_units, 954882);
  assert.equal(x.sql.prepare('SELECT price_cents FROM products').get().price_cents, 10504);
  await x.check(id);
  await x.order(id);
  const item = x.sql.prepare('SELECT id FROM order_items').get().id;
  const result = await x.request('/api/admin/foxreload/execute', 'POST', {
    item_id: item,
    mock: true,
    note: { login: 'steam_user' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(x.counts.pay, 1);
  assert.equal([...x.remote.values()][0].price, '95.48812500');
  const payload = JSON.parse(x.sql.prepare('SELECT request_json FROM fox_jobs').get().request_json);
  assert.equal(payload.items[0].totalPrice, undefined);
  assert.equal(payload.items[0].quantity, 100);
});
test('Steam supplier actual order price above ceiling blocks debit even after creation succeeds', async () => {
  const x = setup();
  x.product.price = '0.95488125';
  const id = await x.imported(100);
  await x.check(id);
  await x.order(id);
  const item = x.sql.prepare('SELECT id FROM order_items').get().id;
  x.setActualPrice('95.4883');
  const b = { item_id: item, mock: true, note: { login: 'steam_user' } };
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  assert.equal(x.counts.create, 1);
  assert.equal(x.counts.pay, 0);
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  assert.equal(x.counts.create, 1);
  assert.equal(x.counts.pay, 0);
});
test('Steam migration preserves existing supplier links and historical order snapshots', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const f of ['0001_store.sql', '0004_foxreload.sql', '0005_exchange_rates.sql'])
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  sql
    .prepare(
      "INSERT INTO products(id,name,slug,category,description,price_cents,currency,image_url,status,payment_mode,region,player_id_required,supplier_product_id,sort_order,created_at,updated_at) VALUES ('old','Old card','old','Cards','desc',500,'USD','','active','both','US',0,'remote-old',0,'2020','2020')",
    )
    .run();
  sql
    .prepare(
      "INSERT INTO fox_products VALUES ('old','remote-old',12345,50,1,10,'code','{}',1500,0,'2020')",
    )
    .run();
  const before = sql.prepare('SELECT * FROM fox_products').get();
  sql.exec(readFileSync(new URL('../migrations/0014_steam.sql', import.meta.url), 'utf8'));
  const after = sql.prepare('SELECT * FROM fox_products').get();
  for (const [key, value] of Object.entries(before)) assert.equal(after[key], value);
  assert.equal(after.service_type, 'standard');
  assert.equal(after.supplier_quantity, 1);
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
});
