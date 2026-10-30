import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createOperations } from '../src/lib/operations.mjs';
import { createStoreHandler } from '../src/lib/store-api.mjs';
import { createFoxreload } from '../src/lib/foxreload.mjs';
import { publicDiscovery } from '../src/lib/public-discovery.mjs';
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const time = new Date().toISOString();
  for (const id of ['owner', 'admin', 'support', 'buyer', 'other', 'restricted'])
    sql.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, id + '@example.test', id, time);
  for (const [id, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['support', 'support'],
  ])
    sql.prepare('INSERT INTO staff_access(user_id,role) VALUES (?,?)').run(id, role);
  for (const [c, r] of [
    ['USD', 1000000],
    ['ILS', 3700000],
    ['JOD', 710000],
    ['EGP', 50000000],
    ['SAR', 3750000],
    ['AED', 3670000],
    ['TRY', 34000000],
  ])
    sql.prepare('INSERT OR REPLACE INTO exchange_rates VALUES (?,?,?)').run(c, r, time);
  sql
    .prepare('INSERT INTO settings VALUES (?,?)')
    .run('store', JSON.stringify({ whatsapp: '970599123456' }));
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
  const identity = async (req) => {
    const id = req.headers.get('who');
    return id
      ? {
          id,
          name: id,
          email: id + '@example.test',
          role: ['owner', 'admin', 'support'].includes(id)
            ? id
            : id === 'restricted'
              ? 'admin'
              : 'customer',
          ...(id === 'restricted' ? { permissions: ['products'] } : {}),
        }
      : null;
  };
  const ops = createOperations(db, identity),
    store = createStoreHandler({
      db,
      resolveIdentity: identity,
      operationsEnabled: true,
      foxEnabled: true,
    });
  async function request(
    path,
    method = 'GET',
    body,
    who = 'owner',
    origin = 'https://rivo.test',
    handler = ops.handle,
  ) {
    const r = await handler(
      new Request('https://rivo.test' + path, {
        method,
        headers: { ...(who ? { who } : {}), origin },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: r.status, data: await r.json() };
  }
  function product(name = 'Card', extra = {}) {
    const id = crypto.randomUUID();
    sql
      .prepare(
        "INSERT INTO products(id,name,slug,category,description,price_cents,currency,image_url,status,payment_mode,region,player_id_required,supplier_product_id,sort_order,created_at,updated_at) VALUES (?,?,?,'Cards','',1000,'USD','','active','both','US',0,'',0,?,?)",
      )
      .run(id, name, id, time, time);
    for (const [k, v] of Object.entries(extra)) {
      assert.ok(
        [
          'currency',
          'price_cents',
          'status',
          'region',
          'image_url',
          'activation_instructions',
        ].includes(k),
      );
      sql.prepare('UPDATE products SET ' + k + '=? WHERE id=?').run(v, id);
    }
    return id;
  }
  function order({
    who = 'buyer',
    payment = 'paid',
    status = 'processing',
    currency = 'USD',
    total = 1100,
    created = time,
    method = 'whatsapp',
    pid,
  } = {}) {
    pid ??= product();
    const id = crypto.randomUUID(),
      item = crypto.randomUUID();
    sql
      .prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        who,
        method,
        payment,
        status,
        total,
        currency,
        '',
        'customer safe',
        'SECRET ADMIN NOTE',
        '',
        crypto.randomUUID(),
        created,
        time,
      );
    sql
      .prepare(
        'INSERT INTO order_items(id,order_id,product_id,name,region,unit_cents,quantity) VALUES (?,?,?,?,?,?,?)',
      )
      .run(item, id, pid, 'Card', 'US', total, 1);
    return { id, item, pid };
  }
  return { sql, db, ops, store, request, product, order, identity };
}
test('notifications are scoped, deduplicated and escaped as data; read actions cannot affect another buyer', async () => {
  const x = fixture(),
    o = x.order(),
    other = x.order({ who: 'other' });
  let r = await x.request('/api/notifications', 'GET', undefined, 'buyer');
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.unread, 1);
  assert.equal(r.data.items[0].order_id, o.id);
  assert.ok(!JSON.stringify(r.data).includes('SECRET'));
  const id = r.data.items[0].id;
  await x.request('/api/notifications', 'GET', undefined, 'buyer');
  assert.equal(
    x.sql.prepare('SELECT count(*) AS n FROM customer_notifications WHERE user_id=?').get('buyer')
      .n,
    1,
  );
  await x.request('/api/notifications/read', 'POST', { id }, 'other');
  assert.equal(
    x.sql.prepare('SELECT read_at FROM customer_notifications WHERE id=?').get(id).read_at,
    null,
  );
  await x.request('/api/notifications/read', 'POST', { all: true }, 'buyer');
  assert.equal((await x.request('/api/notifications', 'GET', undefined, 'buyer')).data.unread, 0);
  x.sql
    .prepare(
      "UPDATE orders SET status='completed',customer_update='<script>unsafe</script>' WHERE id=?",
    )
    .run(o.id);
  r = await x.request('/api/notifications', 'GET', undefined, 'buyer');
  assert.equal(r.data.unread, 1);
  assert.equal(r.data.items[0].title, 'اكتمل طلبك');
  assert.ok(r.data.items.every((i) => i.order_id !== other.id));
  assert.equal(
    (
      await x.request(
        '/api/notifications/read',
        'POST',
        { all: true },
        'buyer',
        'https://evil.test',
      )
    ).status,
    403,
  );
  assert.equal((await x.request('/api/notifications', 'GET', undefined, null)).status, 401);
});
test('notification reconciliation claims one version across concurrent attempts', async () => {
  const x = fixture(),
    o = x.order();
  const row = x.sql.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
  await Promise.all([x.ops.observe(row), x.ops.observe(row)]);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM customer_notifications').get().n, 1);
});
test('followups distinguish active conditions from administrative resolution; support escalates but cannot assign or resolve', async () => {
  const x = fixture(),
    o = x.order({ created: new Date(Date.now() - 3600000).toISOString() });
  x.order({ payment: 'test_paid' });
  const r = await x.request('/api/admin/operations/issues');
  assert.equal(r.data.total, 1);
  assert.ok(r.data.items[0].reasons.includes('delayed'));
  const path = '/api/support/operations/issues/' + o.id;
  assert.equal(
    (await x.request(path, 'POST', { state: 'resolved', note: 'no' }, 'support')).status,
    403,
  );
  assert.equal(
    (await x.request(path, 'POST', { state: 'escalated', note: 'Needs admin' }, 'support')).status,
    200,
  );
  assert.equal(
    (
      await x.request(
        path,
        'POST',
        { state: 'escalated', note: 'bad', assigned_to: 'owner' },
        'support',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await x.request(
        '/api/admin/operations/issues/' + o.id,
        'POST',
        { state: 'resolved', priority: 'urgent', assigned_to: 'admin', note: 'Reviewed' },
        'owner',
      )
    ).status,
    200,
  );
  const resolved = (await x.request('/api/admin/operations/issues?state=resolved')).data.items[0];
  assert.equal(resolved.assigned_to, 'admin');
  assert.equal(resolved.unresolved_condition, true);
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(o.id).payment_status,
    'paid',
  );
  assert.equal(
    (await x.request('/api/admin/operations/issues', 'GET', undefined, 'buyer')).status,
    403,
  );
  assert.equal(
    (await x.request('/api/support/operations/issues', 'GET', undefined, 'support')).status,
    200,
  );
});
test('financial reporting never turns supplier quote or missing fees into actual profit, and excludes tests/refunds', async () => {
  const x = fixture(),
    o = x.order({ status: 'completed' });
  x.order({ payment: 'refunded', status: 'completed' });
  x.order({ payment: 'test_paid', status: 'completed' });
  let r = await x.request('/api/admin/operations/report');
  assert.equal(r.data.rows.length, 1);
  assert.equal(r.data.known_margin_cents, 0);
  assert.equal(r.data.rows[0].margin_usd_cents, null);
  assert.deepEqual(r.data.rows[0].missing, ['cost', 'fee']);
  assert.equal(
    (
      await x.request('/api/admin/operations/money', 'POST', {
        order_id: o.id,
        cost_units: 80000,
        fee_cents: 50,
        note: 'Supplier receipt',
        confirm: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await x.request('/api/admin/operations/money', 'POST', {
        order_id: o.id,
        cost_units: 80000,
        fee_cents: 50,
        note: 'Supplier receipt',
        confirm: true,
      })
    ).status,
    200,
  );
  r = await x.request('/api/admin/operations/report');
  assert.equal(r.data.known_margin_cents, 250);
  assert.equal(r.data.complete_count, 1);
  assert.equal(r.data.rows[0].cost_source, 'manual');
  assert.equal(
    (await x.request('/api/admin/operations/report', 'GET', undefined, 'restricted')).status,
    403,
  );
  assert.equal(
    (await x.request('/api/support/operations/report', 'GET', undefined, 'support')).status,
    403,
  );
});
test('manual cost corrections retain their history and reject stale versions', async () => {
  const x = fixture(),
    o = x.order({ status: 'completed' }),
    path = '/api/admin/operations/money';
  assert.equal(
    (
      await x.request(path, 'POST', {
        order_id: o.id,
        cost_units: 80000,
        fee_cents: 0,
        note: 'receipt A',
        confirm: true,
        expected_version: 0,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await x.request(path, 'POST', {
        order_id: o.id,
        cost_units: 90000,
        note: 'stale update',
        confirm: true,
        expected_version: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await x.request(path, 'POST', {
        order_id: o.id,
        cost_units: 85000,
        note: 'corrected receipt',
        confirm: true,
        expected_version: 1,
      })
    ).status,
    200,
  );
  const h = await x.request(path + '/' + o.id);
  assert.equal(h.data.history.length, 2);
  assert.equal(h.data.current.version, 2);
  assert.equal(h.data.current.manual_fee_cents, 0);
  assert.equal(h.data.current.manual_cost_units, 85000);
  assert.ok(
    h.data.history.some((row) => JSON.parse(row.previous_json).manual_cost_units === 80000),
  );
  assert.equal((await x.request(path + '/' + o.id, 'GET', undefined, 'buyer')).status, 403);
});
test('a baseline for historical orders creates no fictional notification history', async () => {
  const x = fixture(),
    o = x.order();
  x.sql
    .prepare(
      'INSERT INTO order_observations(order_id,signature,checked_at) SELECT id,json_array(status,payment_status,customer_update),? FROM orders WHERE id=?',
    )
    .run(new Date().toISOString(), o.id);
  assert.equal(
    (await x.request('/api/notifications', 'GET', undefined, 'buyer')).data.items.length,
    0,
  );
  x.sql.prepare("UPDATE orders SET status='completed' WHERE id=?").run(o.id);
  assert.equal(
    (await x.request('/api/notifications', 'GET', undefined, 'buyer')).data.items.length,
    1,
  );
});
test('new orders preserve USD revenue snapshot independently of future exchange rates', async () => {
  const x = fixture(),
    pid = x.product('ILS Card', { currency: 'ILS', price_cents: 3700 });
  const created = await x.request(
    '/api/orders',
    'POST',
    {
      items: [{ id: pid, quantity: 1 }],
      payment_method: 'whatsapp',
      display_currency: 'ILS',
      idempotency_key: crypto.randomUUID(),
    },
    'buyer',
    'https://rivo.test',
    x.store,
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const snapshot = x.sql
    .prepare('SELECT revenue_usd_cents FROM ops_order_money WHERE order_id=?')
    .get(created.data.order_id);
  assert.equal(snapshot.revenue_usd_cents, 1000);
  x.sql.prepare("UPDATE exchange_rates SET rate_units=7400000 WHERE currency='ILS'").run();
  assert.equal(
    x.sql
      .prepare('SELECT revenue_usd_cents FROM ops_order_money WHERE order_id=?')
      .get(created.data.order_id).revenue_usd_cents,
    1000,
  );
});
test('bulk updates are atomic, preserve currencies and do not overwrite automatic prices with manual adjustments', async () => {
  const x = fixture(),
    a = x.product('A'),
    b = x.product('B', { currency: 'ILS' }),
    time = new Date().toISOString();
  x.sql
    .prepare(
      "INSERT INTO fox_products(product_id,remote_id,cost_units,stock,min_qty,delivery_type,markup_bps,auto_price,checked_at) VALUES (?, 'remote',50000,20,1,'code',1000,1,?)",
    )
    .run(b, time);
  assert.equal(
    (
      await x.request('/api/admin/operations/bulk-products', 'POST', {
        ids: [a, b],
        mode: 'price',
        bps: 1000,
      })
    ).status,
    409,
  );
  assert.equal(
    x.sql.prepare('SELECT price_cents FROM products WHERE id=?').get(a).price_cents,
    1000,
  );
  assert.equal(
    (
      await x.request('/api/admin/operations/bulk-products', 'POST', {
        ids: [b],
        mode: 'margin',
        bps: 2000,
      })
    ).status,
    200,
  );
  assert.equal(
    x.sql.prepare('SELECT price_cents,currency FROM products WHERE id=?').get(b).price_cents,
    2220,
  );
  assert.equal(x.sql.prepare('SELECT currency FROM products WHERE id=?').get(b).currency, 'ILS');
  assert.equal(
    (
      await x.request('/api/admin/operations/bulk-products', 'POST', {
        ids: [a, b],
        mode: 'fields',
        category: 'New',
        payment_mode: 'whatsapp',
      })
    ).status,
    200,
  );
  assert.equal(
    x.sql.prepare('SELECT count(*) AS n FROM products WHERE category=?').get('New').n,
    2,
  );
});
test('product health reports missing assets, low balance and price changes without altering published products', async () => {
  const x = fixture(),
    pid = x.product();
  x.sql
    .prepare("INSERT INTO supplier_balance_snapshots VALUES ('foxreload',1000,?)")
    .run(new Date().toISOString());
  x.sql
    .prepare(
      'INSERT INTO supplier_product_events(id,product_id,old_cost_units,new_cost_units,created_at) VALUES (?,?,?,?,?)',
    )
    .run('event', pid, 100, 200, new Date().toISOString());
  const r = await x.request('/api/admin/operations/health');
  assert.equal(r.data.balance.low, true);
  assert.ok(r.data.products[0].flags.includes('missing_image'));
  assert.equal(r.data.events.length, 1);
  assert.equal(x.sql.prepare('SELECT status FROM products WHERE id=?').get(pid).status, 'active');
  await x.request('/api/admin/operations/acknowledge', 'POST', { id: 'event' });
  assert.equal((await x.request('/api/admin/operations/health')).data.events.length, 0);
  assert.equal(
    (
      await x.request(
        '/api/admin/operations/config',
        'PUT',
        { delay_minutes: 20, low_balance_cents: 500 },
        'admin',
      )
    ).status,
    403,
  );
});
test('verified live supplier completion records cost; mock results cannot become actual revenue/cost', async () => {
  const x = fixture(),
    o = x.order(),
    remoteId = 'supplier-1',
    job = 'live-job',
    payload = { items: [{ itemId: 'remote-product', quantity: 10 }], isMock: false };
  x.sql
    .prepare(
      "INSERT INTO fox_jobs(id,item_id,is_mock,remote_id,status,request_json,created_at,updated_at) VALUES (?,?,0,?,'processing',?,?,?)",
    )
    .run(
      job,
      o.item,
      remoteId,
      JSON.stringify(payload),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const remote = {
      id: remoteId,
      isMock: false,
      currency: 'usd',
      status: 'completed',
      price: '9.5488125',
      items: [{ product: { id: 'remote-product' }, quantity: 10, externalData: [] }],
    },
    event = { id: 'evt-ops', type: 'order.completed', data: remote },
    raw = JSON.stringify(event),
    t = Math.floor(Date.now() / 1000),
    secret = 'fixture-secret';
  const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    sig = Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw)),
    ).toString('hex');
  const fox = createFoxreload(
    { DB: x.db, RIVO_OPERATIONS_ENABLED: true, FOXRELOAD_WEBHOOK_SECRET: secret },
    x.identity,
    async () => {
      throw Error('No remote purchase');
    },
  );
  const r = await fox.handle(
    new Request('https://rivo.test/api/webhooks/foxreload', {
      method: 'POST',
      headers: { 'X-Webhook-Signature': 't=' + t + ',v1=' + sig },
      body: raw,
    }),
  );
  assert.equal(r.status, 200);
  assert.equal(
    x.sql.prepare('SELECT cost_units,raw_amount FROM supplier_receipts').get().cost_units,
    95489,
  );
  assert.equal(
    x.sql.prepare('SELECT raw_amount FROM supplier_receipts').get().raw_amount,
    '9.5488125',
  );
  assert.equal(x.sql.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status, 'completed');
});
test('public sitemap exposes only published product and policy links; robots disallow account/order routes', async () => {
  const x = fixture(),
    active = x.product(),
    draft = x.product('Hidden', { status: 'draft' });
  x.sql
    .prepare('INSERT INTO settings VALUES (?,?)')
    .run('policy:privacy', JSON.stringify({ published: { body: 'Approved' } }));
  const r = await publicDiscovery(new Request('https://rivo.test/sitemap.xml'), x.db),
    xml = await r.text();
  assert.ok(xml.includes(active));
  assert.ok(!xml.includes(draft));
  assert.ok(xml.includes('policy.html?type=privacy'));
  assert.ok(!xml.includes('buyer'));
  const robots = await publicDiscovery(new Request('https://rivo.test/robots.txt'), x.db);
  assert.ok((await robots.text()).includes('Disallow: /api/'));
});
test('mock results and malformed accounting totals never create actual costs or block confirmed live delivery', async () => {
  for (const mock of [true, false]) {
    const x = fixture(),
      o = x.order(),
      job = 'job-' + mock,
      remoteId = 'remote-' + mock,
      now = new Date().toISOString();
    x.sql
      .prepare(
        "INSERT INTO fox_jobs(id,item_id,is_mock,remote_id,status,request_json,created_at,updated_at) VALUES (?,?,?,?,'processing',?,?,?)",
      )
      .run(
        job,
        o.item,
        mock ? 1 : 0,
        remoteId,
        JSON.stringify({ items: [{ itemId: 'remote', quantity: 1 }] }),
        now,
        now,
      );
    const event = {
        id: 'event-' + mock,
        type: 'order.completed',
        data: {
          id: remoteId,
          isMock: mock,
          status: 'completed',
          currency: 'usd',
          price: mock ? '5.00' : 'unavailable',
          items: [{ product: { id: 'remote' }, quantity: 1, externalData: [] }],
        },
      },
      raw = JSON.stringify(event),
      t = Math.floor(Date.now() / 1000),
      secret = 'test-secret';
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
      sig = Buffer.from(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw)),
      ).toString('hex');
    const fox = createFoxreload(
      { DB: x.db, RIVO_OPERATIONS_ENABLED: true, FOXRELOAD_WEBHOOK_SECRET: secret },
      x.identity,
      async () => {
        throw Error('No real purchase');
      },
    );
    const result = await fox.handle(
      new Request('https://rivo.test/api/webhooks/foxreload', {
        method: 'POST',
        headers: { 'X-Webhook-Signature': 't=' + t + ',v1=' + sig },
        body: raw,
      }),
    );
    assert.equal(result.status, 200);
    assert.equal(x.sql.prepare('SELECT count(*) AS n FROM supplier_receipts').get().n, 0);
    assert.equal(
      x.sql.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status,
      mock ? 'processing' : 'completed',
    );
  }
});
