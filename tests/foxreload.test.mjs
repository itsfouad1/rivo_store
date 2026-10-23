import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createFoxreload, units, sellingPrice, verifyWebhook } from '../lib/foxreload.mjs';
import { createStoreHandler } from '../lib/store-api.mjs';
function setup({ live = true, paymentTimeout = false, createTimeout = false } = {}) {
  const sql = new DatabaseSync(':memory:');
  for (const f of ['0001_store.sql', '0004_foxreload.sql', '0005_exchange_rates.sql'])
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  sql
    .prepare('UPDATE exchange_rates SET updated_at=? WHERE currency=?')
    .run(new Date().toISOString(), 'USD');
  for (const [currency, rate] of [
    ['ILS', 3700000],
    ['JOD', 710000],
    ['EGP', 50000000],
    ['SAR', 3750000],
    ['AED', 3670000],
    ['TRY', 34000000],
  ])
    sql
      .prepare('INSERT INTO exchange_rates(currency,rate_units,updated_at) VALUES (?,?,?)')
      .run(currency, rate, new Date().toISOString());
  function prepare(q, args = []) {
    return {
      q,
      args,
      bind(...p) {
        return prepare(q, p);
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
  const env = {
    DB: db,
    FOXRELOAD_API_KEY: 'test-only',
    FOXRELOAD_LIVE_ENABLED: String(live),
    FOXRELOAD_WEBHOOK_SECRET: 'test-webhook-secret',
  };
  const identity = async (req) => {
    const id = req.headers.get('test-user');
    return id
      ? { id, email: id + '@test.invalid', name: id, role: id === 'admin' ? 'admin' : 'customer' }
      : null;
  };
  const product = {
    id: 'product_test',
    name: 'Test card',
    price: '2.1234',
    currency: 'usd',
    quantity: 100,
    orderMinQuantity: 1,
    orderMaxQuantity: 99,
    deliveryType: 'code',
    requiredNoteFields: [],
    noteFieldTypes: {},
    noteFieldOptions: {},
  };
  const orders = new Map(),
    counts = { create: 0, pay: 0, requests: 0 };
  let redirect = false;
  const fetcher = async (url, init) => {
    counts.requests++;
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['X-API-Key'], 'test-only');
    assert.equal(init.headers['X-Currency'], 'usd');
    if (redirect)
      return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid' } });
    const u = new URL(url),
      method = init.method;
    if (u.pathname === '/api/products/product_test') return Response.json(product);
    if (u.pathname === '/api/products/')
      return Response.json({ items: [product], nextCursor: null });
    if (u.pathname === '/api/access/me/balances/')
      return Response.json([{ currency: 'usd', available: '100', reserved: '0', pending: '0' }]);
    if (u.pathname === '/api/orders/' && method === 'GET')
      return Response.json({
        items: [...orders.values()].filter(
          (o) => o.idempotencyKey === u.searchParams.get('idempotencyKey'),
        ),
      });
    if (u.pathname === '/api/orders/' && method === 'POST') {
      counts.create++;
      const b = JSON.parse(init.body),
        i = b.items[0],
        id = crypto.randomUUID();
      const o = {
        id,
        idempotencyKey: b.idempotencyKey,
        isMock: b.isMock,
        status: 'active',
        price: i.totalPrice,
        currency: 'usd',
        items: [{ product: { id: i.itemId }, quantity: i.quantity, externalData: [] }],
      };
      orders.set(id, o);
      if (createTimeout) {
        createTimeout = false;
        throw Error('lost response');
      }
      return Response.json(o);
    }
    const m = u.pathname.match(/^\/api\/orders\/([^/]+)(\/pay)?$/);
    if (m) {
      const o = orders.get(m[1]);
      assert.ok(o);
      if (m[2]) {
        counts.pay++;
        o.status = 'completed';
        o.items[0].externalData = [o.isMock ? 'MOCK-CODE' : 'REAL-CODE'];
        if (paymentTimeout) {
          paymentTimeout = false;
          throw Error('lost payment response');
        }
        return Response.json({ id: '' });
      }
      return Response.json(o);
    }
    throw Error('Unexpected ' + url);
  };
  const fox = createFoxreload(env, identity, fetcher),
    store = createStoreHandler({ db, foxEnabled: true, resolveIdentity: identity });
  async function request(path, method = 'GET', data, who = 'admin', extra = {}) {
    const req = new Request('https://rivo.test' + path, {
      method,
      headers: { origin: 'https://rivo.test', ...(who ? { 'test-user': who } : {}), ...extra },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const r = (await fox.handle(req)) || (await store(req));
    return { status: r.status, data: await r.json() };
  }
  async function cart() {
    let r = await request('/api/admin/foxreload/import', 'POST', {
      remote_id: product.id,
      markup_bps: 1000,
    });
    assert.equal(r.status, 201);
    const pid = r.data.product_id;
    sql.prepare("UPDATE products SET status='active' WHERE id=?").run(pid);
    await request('/api/admin/settings', 'PUT', { whatsapp: '970599123456' });
    r = await request(
      '/api/orders',
      'POST',
      {
        items: [{ id: pid, quantity: 2 }],
        payment_method: 'whatsapp',
        idempotency_key: crypto.randomUUID(),
      },
      'customer',
    );
    assert.equal(r.status, 201);
    const oid = r.data.order_id,
      item = sql.prepare('SELECT id FROM order_items WHERE order_id=?').get(oid).id;
    return { pid, oid, item };
  }
  return {
    sql,
    db,
    env,
    request,
    cart,
    product,
    orders,
    counts,
    fox,
    setRedirect() {
      redirect = true;
    },
  };
}
test('precise cost arithmetic and percentage rounding', () => {
  assert.equal(units('2.1234'), 21234);
  assert.equal(sellingPrice(21234, 1000), 234);
  for (const n of ['-1', 'NaN', '1e3', '2.12345']) assert.throws(() => units(n));
});
test('admin authorization, same-origin protection and redirects do not leak credentials', async () => {
  const x = setup();
  assert.equal(
    (await x.request('/api/admin/foxreload/balance', 'GET', undefined, null)).status,
    401,
  );
  assert.equal(
    (await x.request('/api/admin/foxreload/balance', 'GET', undefined, 'customer')).status,
    403,
  );
  assert.equal(
    (
      await x.request('/api/admin/foxreload/import', 'POST', {}, 'admin', {
        origin: 'https://evil.invalid',
      })
    ).status,
    403,
  );
  assert.equal(x.counts.requests, 0);
  x.setRedirect();
  assert.equal((await x.request('/api/admin/foxreload/balance')).status, 502);
  assert.equal(x.counts.requests, 1);
});
test('import forces drafts, prices are server-derived, duplicate import is blocked', async () => {
  const x = setup();
  const r = await x.request('/api/admin/foxreload/import', 'POST', {
    remote_id: 'product_test',
    markup_bps: 1000,
    price_cents: 1,
    status: 'active',
  });
  assert.equal(r.status, 201);
  const p = x.sql.prepare('SELECT * FROM products').get();
  assert.equal(p.status, 'draft');
  assert.equal(p.price_cents, 234);
  assert.equal(p.currency, 'USD');
  assert.equal(
    (await x.request('/api/admin/foxreload/import', 'POST', { remote_id: 'product_test' })).status,
    409,
  );
});
test('stock sync preserves editorial fields and manual pricing, unavailable products block checkout', async () => {
  const x = setup();
  const { pid } = await x.cart();
  x.sql.prepare("UPDATE products SET name='اسم عربي',price_cents=777 WHERE id=?").run(pid);
  x.product.price = '3.0000';
  await x.request('/api/admin/foxreload/products/' + pid, 'PUT', {
    markup_bps: 2000,
    auto_price: false,
  });
  let p = x.sql.prepare('SELECT * FROM products WHERE id=?').get(pid);
  assert.equal(p.name, 'اسم عربي');
  assert.equal(p.price_cents, 777);
  x.product.quantity = 0;
  await x.request('/api/admin/foxreload/sync', 'POST', { product_id: pid });
  const catalog = await x.request('/api/store');
  assert.equal(catalog.data.products[0].available, false);
  const r = await x.request(
    '/api/orders',
    'POST',
    {
      items: [{ id: pid, quantity: 1 }],
      payment_method: 'whatsapp',
      idempotency_key: crypto.randomUUID(),
    },
    'customer',
  );
  assert.equal(r.status, 409);
});
test('mock completion never fulfills customer order or exposes mock codes', async () => {
  const x = setup(),
    { item, oid } = await x.cart();
  const r = await x.request('/api/admin/foxreload/execute', 'POST', {
    item_id: item,
    mock: true,
    note: {},
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'completed');
  assert.equal(
    x.sql.prepare('SELECT status FROM orders WHERE id=?').get(oid).status,
    'contact_pending',
  );
  assert.deepEqual(
    (await x.request('/api/orders/' + oid + '/delivery', 'GET', undefined, 'customer')).data.items,
    [],
  );
});
test('live purchase requires enablement, payment, confirmation and cost ceiling', async () => {
  const x = setup({ live: false }),
    { item, oid } = await x.cart();
  const b = { item_id: item, mock: false, confirm: true, note: {} };
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  x.env.FOXRELOAD_LIVE_ENABLED = 'true';
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  x.sql.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(oid);
  assert.equal(
    (await x.request('/api/admin/foxreload/execute', 'POST', { ...b, confirm: false })).status,
    400,
  );
  x.product.price = '2.5000';
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 409);
  assert.equal(x.counts.pay, 0);
  assert.equal(x.counts.create, 0);
});
test('paid live order delivers only to its owner and completes once', async () => {
  const x = setup(),
    { item, oid } = await x.cart();
  x.sql.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(oid);
  const b = { item_id: item, mock: false, confirm: true, note: {} };
  const r = await x.request('/api/admin/foxreload/execute', 'POST', b);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'completed');
  assert.equal(x.counts.pay, 1);
  assert.equal(x.sql.prepare('SELECT status FROM orders WHERE id=?').get(oid).status, 'completed');
  assert.equal(
    (await x.request('/api/orders/' + oid + '/delivery', 'GET', undefined, 'other')).status,
    404,
  );
  const d = await x.request('/api/orders/' + oid + '/delivery', 'GET', undefined, 'customer');
  assert.deepEqual(d.data.items[0].codes, ['REAL-CODE']);
  await x.request('/api/admin/foxreload/execute', 'POST', b);
  assert.equal(x.counts.pay, 1);
});
test('lost create response is recovered by idempotency key without another purchase', async () => {
  const x = setup({ createTimeout: true }),
    { item } = await x.cart();
  const b = { item_id: item, mock: true, note: {} };
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 503);
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 200);
  assert.equal(x.counts.create, 1);
  assert.equal(x.counts.pay, 1);
});
test('lost payment response is never paid twice, even across concurrent retries', async () => {
  const x = setup({ paymentTimeout: true }),
    { item } = await x.cart();
  const b = { item_id: item, mock: true, note: {} };
  assert.equal((await x.request('/api/admin/foxreload/execute', 'POST', b)).status, 503);
  await Promise.all([
    x.request('/api/admin/foxreload/execute', 'POST', b),
    x.request('/api/admin/foxreload/execute', 'POST', b),
  ]);
  assert.equal(x.counts.create, 1);
  assert.equal(x.counts.pay, 1);
});
async function sign(secret, raw, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw));
  return 't=' + t + ',v1=' + Buffer.from(sig).toString('hex');
}
test('webhook verifies raw bytes, rejects expired/tampered signatures and deduplicates events', async () => {
  const x = setup(),
    { item } = await x.cart();
  await x.request('/api/admin/foxreload/execute', 'POST', { item_id: item, mock: true, note: {} });
  const event = {
      id: crypto.randomUUID(),
      type: 'order.completed',
      data: [...x.orders.values()][0],
    },
    raw = JSON.stringify(event),
    sig = await sign(x.env.FOXRELOAD_WEBHOOK_SECRET, raw);
  assert.equal(await verifyWebhook(x.env.FOXRELOAD_WEBHOOK_SECRET, raw, sig), true);
  assert.equal(await verifyWebhook(x.env.FOXRELOAD_WEBHOOK_SECRET, raw + ' ', sig), false);
  assert.equal(
    await verifyWebhook(
      x.env.FOXRELOAD_WEBHOOK_SECRET,
      raw,
      await sign(x.env.FOXRELOAD_WEBHOOK_SECRET, raw, 1),
    ),
    false,
  );
  assert.equal((await x.request('/api/webhooks/foxreload', 'POST', event, null)).status, 401);
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await x.request('/api/webhooks/foxreload', 'POST', event, null, {
          'X-Webhook-Signature': sig,
        })
      ).status,
      200,
    );
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM fox_events').get().n, 1);
});
test('linked product snapshot survives catalog changes and invalid topup notes never order', async () => {
  const x = setup();
  x.product.deliveryType = 'direct_topup';
  x.product.requiredNoteFields = ['login'];
  x.product.noteFieldTypes = { login: 'string' };
  // Create cart directly with the required player id handled by the existing checkout.
  const r = await x.request('/api/admin/foxreload/import', 'POST', { remote_id: 'product_test' }),
    pid = r.data.product_id;
  x.sql.prepare("UPDATE products SET status='active' WHERE id=?").run(pid);
  await x.request('/api/admin/settings', 'PUT', { whatsapp: '970599123456' });
  const o = await x.request(
    '/api/orders',
    'POST',
    {
      items: [{ id: pid, quantity: 1 }],
      player_id: 'player',
      payment_method: 'whatsapp',
      idempotency_key: crypto.randomUUID(),
    },
    'customer',
  );
  const item = x.sql.prepare('SELECT id FROM order_items WHERE order_id=?').get(o.data.order_id).id;
  assert.equal(
    (
      await x.request('/api/admin/foxreload/execute', 'POST', {
        item_id: item,
        mock: true,
        note: {},
      })
    ).status,
    400,
  );
  assert.equal(x.counts.create, 0);
  assert.equal(
    x.sql.prepare('SELECT remote_id FROM fox_order_lines WHERE item_id=?').get(item).remote_id,
    'product_test',
  );
});
test('deleting an unused imported product also removes its supplier link', async () => {
  const x = setup();
  const r = await x.request('/api/admin/foxreload/import', 'POST', { remote_id: 'product_test' });
  assert.equal(r.status, 201);
  const id = r.data.product_id;
  const gone = await x.request('/api/admin/products/' + id + '/permanent', 'DELETE');
  assert.equal(gone.status, 200);
  assert.equal(
    x.sql.prepare('SELECT product_id FROM fox_products WHERE product_id=?').get(id),
    undefined,
  );
  assert.equal(x.sql.prepare('SELECT id FROM products WHERE id=?').get(id), undefined);
});
test('FoxReload auto pricing follows a linked product local currency', async () => {
  const x = setup();
  const imported = await x.request('/api/admin/foxreload/import', 'POST', {
    remote_id: 'product_test',
    markup_bps: 1000,
  });
  const id = imported.data.product_id;
  const p = x.sql.prepare('SELECT * FROM products WHERE id=?').get(id);
  const changed = await x.request('/api/admin/products/' + id, 'PUT', { ...p, currency: 'ILS' });
  assert.equal(changed.status, 200);
  assert.equal(
    x.sql.prepare('SELECT price_cents FROM products WHERE id=?').get(id).price_cents,
    866,
  );
  x.product.price = '3.0000';
  await x.request('/api/admin/foxreload/sync', 'POST', { product_id: id });
  assert.equal(
    x.sql.prepare('SELECT price_cents FROM products WHERE id=?').get(id).price_cents,
    1221,
  );
});
