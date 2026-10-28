import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createPayunit, verifyPayunitWebhook } from '../lib/payunit.mjs';
import { createStoreHandler } from '../lib/store-api.mjs';
import { createFoxreload } from '../lib/foxreload.mjs';

function setup(mode = 'live') {
  const sql = new DatabaseSync(':memory:');
  for (const f of [
    '0001_store.sql',
    '0004_foxreload.sql',
    '0005_exchange_rates.sql',
    '0006_payunit.sql',
    '0007_product_guides.sql',
    '0013_order_item_accounts.sql',
    '0014_steam.sql',
  ])
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  for (const [c, n] of [
    ['USD', 1000000],
    ['ILS', 4000000],
    ['JOD', 710000],
    ['EGP', 50000000],
    ['SAR', 3750000],
    ['AED', 3670000],
    ['TRY', 34000000],
  ])
    sql
      .prepare('INSERT OR REPLACE INTO exchange_rates VALUES (?,?,?)')
      .run(c, n, new Date().toISOString());
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
    PAYUNIT_MODE: mode,
    PAYUNIT_API_KEY: 'pay_' + mode + '_test_only_key',
    PAYUNIT_WEBHOOK_SECRET: 'whsec_test_only_123456789',
    FOXRELOAD_LIVE_ENABLED: 'true',
  };
  const identity = async (req) => {
    const id = req.headers.get('test-user');
    return id
      ? { id, email: id + '@example.test', name: id, role: id === 'admin' ? 'admin' : 'customer' }
      : null;
  };
  const invoices = new Map(),
    requests = [];
  let loseResponse = false,
    badResponse = null;
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    requests.push({ url, init });
    if (init.method === 'POST') {
      const b = JSON.parse(init.body),
        key = init.headers['Idempotency-Key'];
      let invoice = invoices.get(key);
      if (!invoice) {
        invoice = {
          id: 'inv_' + mode + '_' + (invoices.size + 1),
          amount: b.amount,
          currency: 'USD',
          environment: mode,
          external_ref: b.external_ref,
          status: 'pending',
          checkout_url: 'https://payunit.co/pay/test-' + (invoices.size + 1),
        };
        invoices.set(key, invoice);
      }
      if (loseResponse) {
        loseResponse = false;
        throw Error('lost reply');
      }
      return Response.json({ ...invoice, ...badResponse });
    }
    const id = url.split('/').at(-1),
      invoice = [...invoices.values()].find((r) => r.id === id);
    return invoice
      ? Response.json({ ...invoice, ...badResponse })
      : Response.json({}, { status: 404 });
  };
  const pay = createPayunit(env, identity, fetcher),
    store = createStoreHandler({
      db,
      foxEnabled: true,
      gatewayReady: true,
      gatewayMode: mode,
      resolveIdentity: identity,
    });
  async function request(path, method = 'GET', body, who = 'admin', headers = {}) {
    const req = new Request('https://rivo.test' + path, {
      method,
      headers: { origin: 'https://rivo.test', ...(who ? { 'test-user': who } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const res = (await pay.handle(req)) || (await store(req));
    return { status: res.status, data: await res.json() };
  }
  async function order(who = 'admin', paymentMode = 'both') {
    const p = await request('/api/admin/products', 'POST', {
      name: 'Test card',
      slug: 'p-' + crypto.randomUUID(),
      category: 'Cards',
      price_cents: 1000,
      currency: 'USD',
      status: 'active',
      payment_mode: paymentMode,
      sort_order: 0,
    });
    const payload = {
      items: [{ id: p.data.product.id, quantity: 2 }],
      display_currency: 'ILS',
      payment_method: 'gateway',
      idempotency_key: crypto.randomUUID(),
    };
    const r = await request('/api/orders', 'POST', payload, who);
    return { r, payload, pid: p.data.product.id, id: r.data.order_id };
  }
  async function signature(raw, t = String(Math.floor(Date.now() / 1000))) {
    const k = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.PAYUNIT_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const b = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(t + '.' + raw));
    return {
      'Payunit-Timestamp': t,
      'Payunit-Signature': 'v1=' + Buffer.from(b).toString('hex'),
      'Payunit-Event-Id': 'evt_' + crypto.randomUUID(),
    };
  }
  async function notice(id, event = 'invoice.paid', extra = {}) {
    const invoice = [...invoices.values()].find((i) => i.external_ref === id),
      body = JSON.stringify({
        event,
        data: { external_ref: id, invoice_id: invoice.id, ...extra },
      });
    return request('/api/webhooks/payunit', 'POST', body, null, await signature(body));
  }
  return {
    sql,
    db,
    env,
    identity,
    request,
    order,
    invoices,
    requests,
    signature,
    notice,
    lose() {
      loseResponse = true;
    },
    bad(v) {
      badResponse = v;
    },
  };
}
test('checkout snapshots USD amount and retries after an FX change without a second invoice', async () => {
  const x = setup(),
    { r, id, payload } = await x.order();
  assert.equal(r.status, 201);
  assert.equal(
    x.sql.prepare('SELECT total_cents FROM orders WHERE id=?').get(id).total_cents,
    8000,
  );
  assert.equal(
    x.sql.prepare('SELECT amount_usd_cents FROM payunit_invoices WHERE order_id=?').get(id)
      .amount_usd_cents,
    2000,
  );
  x.lose();
  assert.equal((await x.request('/api/payments/payunit', 'POST', { order_id: id })).status, 503);
  x.sql.prepare("UPDATE exchange_rates SET rate_units=8000000 WHERE currency='ILS'").run();
  const retry = await x.request('/api/payments/payunit', 'POST', { order_id: id });
  assert.equal(retry.status, 201);
  assert.equal(retry.data.amount_usd_cents, 2000);
  assert.equal(x.invoices.size, 1);
  assert.equal(x.requests[0].init.body, x.requests[1].init.body);
  assert.equal((await x.request('/api/orders', 'POST', payload)).data.order_id, id);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM payunit_invoices').get().n, 1);
});
test('provider cancellation closes unpaid orders and cannot cancel confirmed payment', async () => {
  const x = setup(),
    { id } = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: id });
  [...x.invoices.values()][0].status = 'cancelled';
  const r = await x.request('/api/payments/payunit/' + id + '/refresh', 'POST');
  assert.equal(r.data.order_status, 'cancelled');
  assert.equal(r.data.checkout_url, '');
  assert.equal((await x.request('/api/payments/payunit', 'POST', { order_id: id })).status, 409);
  const next = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: next.id });
  const invoice = [...x.invoices.values()].find((i) => i.external_ref === next.id);
  invoice.status = 'paid';
  await x.notice(next.id);
  invoice.status = 'cancelled';
  const stale = await x.request('/api/payments/payunit/' + next.id + '/refresh', 'POST');
  assert.equal(stale.data.payment_status, 'paid');
  assert.equal(stale.data.order_status, 'processing');
  assert.equal(stale.data.status, 'paid');
});
test('invoice ownership, origin and product payment mode are enforced', async () => {
  const x = setup(),
    { id } = await x.order();
  assert.equal(
    (await x.request('/api/payments/payunit', 'POST', { order_id: id }, 'other')).status,
    404,
  );
  assert.equal(
    (await x.request('/api/payments/payunit', 'POST', { order_id: id }, null)).status,
    401,
  );
  assert.equal(
    (
      await x.request('/api/payments/payunit', 'POST', { order_id: id }, 'admin', {
        origin: 'https://evil.test',
      })
    ).status,
    403,
  );
  assert.equal((await x.order('admin', 'whatsapp')).r.status, 409);
  assert.equal(x.requests.length, 0);
});
test('test checkout is admin-only, cannot become real paid or execute FoxReload live', async () => {
  const x = setup('test');
  assert.equal((await x.order('customer')).r.status, 403);
  const { id, pid } = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: id });
  [...x.invoices.values()][0].status = 'paid';
  assert.equal((await x.notice(id)).status, 200);
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
    'test_paid',
  );
  const item = x.sql.prepare('SELECT id FROM order_items WHERE order_id=?').get(id).id;
  x.sql
    .prepare(
      "INSERT INTO fox_order_lines(item_id,remote_id,cost_units,delivery_type,note_schema,sale_usd_cents) VALUES (?,'p',100,'code','{}',1000)",
    )
    .run(item);
  // Even an out-of-band edit to payment_status must not bypass the provider environment guard.
  x.sql.prepare("UPDATE orders SET payment_status='paid',status='processing' WHERE id=?").run(id);
  const fox = createFoxreload(x.env, x.identity, async () => {
    throw Error('Supplier must not be called');
  });
  const response = await fox.handle(
    new Request('https://rivo.test/api/admin/foxreload/execute', {
      method: 'POST',
      headers: { origin: 'https://rivo.test', 'test-user': 'admin' },
      body: JSON.stringify({ item_id: item, mock: false, confirm: true, note: {} }),
    }),
  );
  assert.equal(response.status, 409);
});
test('paid webhook verifies canonical amount, currency and environment before confirming payment', async () => {
  const x = setup(),
    { id } = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: id });
  [...x.invoices.values()][0].status = 'paid';
  for (const bad of [
    { amount: '0.01' },
    { currency: 'ILS' },
    { environment: 'test' },
    { external_ref: 'wrong' },
  ]) {
    x.bad(bad);
    assert.equal((await x.notice(id)).status, 409);
    assert.equal(
      x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
      'unpaid',
    );
  }
  x.bad(null);
  assert.equal((await x.notice(id)).status, 200);
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
    'paid',
  );
});
test('forged, expired and altered webhook signatures do not confirm payment', async () => {
  const x = setup(),
    { id } = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: id });
  const raw = JSON.stringify({ event: 'invoice.paid', data: { external_ref: id } });
  assert.equal((await x.request('/api/webhooks/payunit', 'POST', raw, null)).status, 400);
  const sig = await x.signature(raw);
  assert.equal(
    (await x.request('/api/webhooks/payunit', 'POST', raw + ' ', null, sig)).status,
    400,
  );
  assert.equal(
    (
      await x.request(
        '/api/webhooks/payunit',
        'POST',
        raw,
        null,
        await x.signature(raw, '1000000000'),
      )
    ).status,
    400,
  );
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
    'unpaid',
  );
});
test('duplicate notices, changed event headers and late failures cannot undo payment', async () => {
  const x = setup(),
    { id } = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: id });
  [...x.invoices.values()][0].status = 'paid';
  const result = await Promise.all([x.notice(id), x.notice(id)]);
  assert.ok(result.every((r) => r.status === 200));
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM payunit_events').get().n, 1);
  assert.equal((await x.notice(id, 'payment.failed')).status, 200);
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
    'paid',
  );
});
test('partial and full refunds reconcile canonical state and never regress to paid', async () => {
  const x = setup(),
    { id } = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: id });
  const remote = [...x.invoices.values()][0];
  remote.status = 'paid';
  await x.notice(id);
  remote.status = 'partially_refunded';
  assert.equal((await x.notice(id, 'payment.refunded', { sequence: 1 })).status, 200);
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
    'partially_refunded',
  );
  remote.status = 'refunded';
  await x.notice(id, 'payment.refunded', { sequence: 2 });
  remote.status = 'paid';
  await x.notice(id, 'invoice.paid', { sequence: 3 });
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
    'refunded',
  );
  assert.equal(
    x.sql.prepare('SELECT status FROM payunit_invoices WHERE order_id=?').get(id).status,
    'refunded',
  );
});
test('return page cannot mark paid; owner can reconcile directly with Payunit', async () => {
  const x = setup(),
    { id } = await x.order();
  await x.request('/api/payments/payunit', 'POST', { order_id: id });
  assert.equal((await x.request('/api/payments/payunit/' + id)).data.payment_status, 'unpaid');
  [...x.invoices.values()][0].status = 'paid';
  assert.equal(
    (await x.request('/api/payments/payunit/' + id + '/refresh', 'POST', undefined, 'other'))
      .status,
    404,
  );
  assert.equal(
    (await x.request('/api/payments/payunit/' + id + '/refresh', 'POST')).data.payment_status,
    'paid',
  );
  assert.equal(
    (
      await x.request('/api/admin/orders/' + id, 'PUT', {
        payment_status: 'unpaid',
        status: 'processing',
      })
    ).status,
    409,
  );
});
test('redirected or mismatched create response cannot attach a checkout link', async () => {
  const x = setup(),
    { id } = await x.order();
  x.bad({ checkout_url: 'https://evil.test' });
  assert.equal((await x.request('/api/payments/payunit', 'POST', { order_id: id })).status, 502);
  assert.equal(
    x.sql.prepare('SELECT invoice_id FROM payunit_invoices WHERE order_id=?').get(id).invoice_id,
    null,
  );
});
