import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createStoreHandler } from '../lib/store-api.mjs';
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../migrations/0001_store.sql', import.meta.url), 'utf8'));
sqlite.exec(
  `CREATE TABLE exchange_rates(currency TEXT PRIMARY KEY NOT NULL,rate_units INTEGER NOT NULL,updated_at TEXT NOT NULL);INSERT INTO exchange_rates VALUES ('USD',1000000,'2026-01-01T00:00:00.000Z'),('ILS',3700000,'2026-01-01T00:00:00.000Z'),('JOD',710000,'2026-01-01T00:00:00.000Z'),('EGP',50000000,'2026-01-01T00:00:00.000Z'),('SAR',3750000,'2026-01-01T00:00:00.000Z'),('AED',3670000,'2026-01-01T00:00:00.000Z'),('TRY',34000000,'2026-01-01T00:00:00.000Z');`,
);
function prepared(sql, args = []) {
  return {
    bind(...values) {
      return prepared(sql, values);
    },
    async first() {
      return sqlite.prepare(sql).get(...args) || null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    async run() {
      return sqlite.prepare(sql).run(...args);
    },
    sql,
    args,
  };
}
const db = {
  prepare: prepared,
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map((s) => sqlite.prepare(s.sql).run(...s.args));
      sqlite.exec('COMMIT');
      return result;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  },
};
const handle = createStoreHandler({
  db,
  resolveIdentity: async (req) => {
    const id = req.headers.get('oai-authenticated-user-id');
    return id
      ? { id, email: id + '@test.invalid', name: id, role: id === 'owner' ? 'admin' : 'customer' }
      : null;
  },
});
async function request(path, method = 'GET', body, who = 'customer', origin = 'https://rivo.test') {
  const headers = {};
  if (method !== 'GET') headers.origin = origin;
  if (who) {
    headers['oai-authenticated-user-id'] = who;
    headers['oai-authenticated-user-email'] =
      who === 'owner' ? 'owner@test.invalid' : who + '@test.invalid';
  }
  if (body) headers['content-type'] = 'application/json';
  const r = await handle(
    new Request('https://rivo.test' + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: r.status, body: await r.json() };
}
const product = {
  name: 'بطاقة اختبار',
  slug: 'test-product',
  category: 'بطاقات رقمية',
  description: 'Test',
  price_cents: 1250,
  currency: 'USD',
  image_url: '',
  status: 'active',
  payment_mode: 'whatsapp',
  region: 'US',
  player_id_required: true,
  sort_order: 0,
};
let id, orderId;
test('anonymous and customer cannot access administration', async () => {
  assert.equal((await request('/api/admin/overview', 'GET', null, null)).status, 401);
  assert.equal((await request('/api/admin/overview')).status, 403);
  assert.equal((await request('/api/admin/products', 'POST', product)).status, 403);
});
test('reject cross-origin mutation', async () => {
  assert.equal(
    (await request('/api/admin/products', 'POST', product, 'owner', 'https://evil.invalid')).status,
    403,
  );
});
test('server validates product and preserves published/draft distinction', async () => {
  let r = await request('/api/admin/products', 'POST', { ...product, price_cents: -1 }, 'owner');
  assert.equal(r.status, 400);
  r = await request('/api/admin/products', 'POST', product, 'owner');
  assert.equal(r.status, 201);
  id = r.body.product.id;
  assert.equal(
    (
      await request(
        '/api/admin/products',
        'POST',
        { ...product, slug: 'hidden', status: 'draft' },
        'owner',
      )
    ).status,
    201,
  );
  assert.equal((await request('/api/store', 'GET', null, null)).body.products.length, 1);
});
test('server blocks unsafe image and invalid supplier linkage', async () => {
  assert.equal(
    (
      await request(
        '/api/admin/products',
        'POST',
        { ...product, slug: 'bad-image', image_url: 'javascript:alert(1)' },
        'owner',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/api/admin/products',
        'POST',
        { ...product, slug: 'bad-source', supplier_id: 'missing' },
        'owner',
      )
    ).status,
    400,
  );
});
test('WhatsApp needs configured number; gateway stays unavailable', async () => {
  let b = {
    items: [{ id, quantity: 1 }],
    payment_method: 'whatsapp',
    player_id: '123',
    idempotency_key: crypto.randomUUID(),
  };
  assert.equal((await request('/api/orders', 'POST', b)).status, 409);
  assert.equal(
    (await request('/api/orders', 'POST', { ...b, payment_method: 'gateway' })).status,
    409,
  );
  assert.equal(
    (await request('/api/admin/settings', 'PUT', { whatsapp: '970599123456' }, 'owner')).status,
    200,
  );
});
test('player ID, product methods and quantity are validated', async () => {
  const b = {
    items: [{ id, quantity: 1 }],
    payment_method: 'whatsapp',
    idempotency_key: crypto.randomUUID(),
  };
  assert.equal((await request('/api/orders', 'POST', b)).status, 400);
  assert.equal(
    (await request('/api/orders', 'POST', { ...b, player_id: '123', items: [{ id, quantity: 0 }] }))
      .status,
    400,
  );
  await request(
    '/api/admin/products/' + id,
    'PUT',
    { ...product, payment_mode: 'gateway' },
    'owner',
  );
  assert.equal((await request('/api/orders', 'POST', { ...b, player_id: '123' })).status, 409);
  await request('/api/admin/products/' + id, 'PUT', product, 'owner');
});
test('order price is authoritative, repeated clicks are idempotent', async () => {
  const payload = {
    items: [{ id, quantity: 2, price_cents: 1 }],
    total_cents: 1,
    payment_method: 'whatsapp',
    player_id: '123',
    idempotency_key: crypto.randomUUID(),
  };
  const r = await request('/api/orders', 'POST', payload);
  assert.equal(r.status, 201);
  orderId = r.body.order_id;
  assert.match(r.body.whatsapp_url, /^https:\/\/wa.me\/970599123456/);
  const repeat = await request('/api/orders', 'POST', payload);
  assert.equal(repeat.body.order_id, orderId);
  const orders = (await request('/api/orders')).body.orders;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].total_cents, 2500);
  assert.equal(orders[0].payment_status, 'unpaid');
  assert.equal((await request('/api/orders', 'POST', payload, 'another')).status, 409);
});
test('customer isolation and internal notes stay private', async () => {
  assert.deepEqual((await request('/api/orders', 'GET', null, 'another')).body.orders, []);
  assert.equal(
    (
      await request('/api/admin/orders/' + orderId, 'PUT', {
        status: 'completed',
        payment_status: 'paid',
      })
    ).status,
    403,
  );
  const r = await request(
    '/api/admin/orders/' + orderId,
    'PUT',
    {
      status: 'processing',
      payment_status: 'paid',
      admin_note: 'private-only',
      customer_update: 'working on it',
    },
    'owner',
  );
  assert.equal(r.status, 200);
  const o = (await request('/api/orders')).body.orders[0];
  assert.equal(o.customer_update, 'working on it');
  assert.equal(o.admin_note, undefined);
  assert.equal(o.idempotency_key, undefined);
  assert.equal(o.payment_status, 'paid');
});
test('order detail enforces ownership and returns only customer-safe information', async () => {
  const path = '/api/orders/' + orderId;
  assert.equal((await request(path, 'GET', null, null)).status, 401);
  assert.equal((await request(path, 'GET', null, 'another')).status, 404);
  assert.equal((await request(path, 'GET', null, 'owner')).status, 404);
  const r = await request(path);
  assert.equal(r.status, 200);
  assert.equal(r.body.order.id, orderId);
  assert.equal(r.body.order.items.length, 1);
  assert.equal(r.body.order.admin_note, undefined);
  assert.equal(r.body.order.idempotency_key, undefined);
  assert.equal(r.body.order.user_id, undefined);
  assert.equal(r.body.order.customer_update, 'working on it');
  const support = new URL(r.body.support_url);
  assert.equal(support.hostname, 'wa.me');
  assert.ok(support.searchParams.get('text').includes(orderId));
  assert.ok(!support.searchParams.get('text').includes('private-only'));
  assert.equal((await request('/api/orders/' + crypto.randomUUID())).status, 404);
});
test('cannot complete unpaid order; archived products cannot be ordered', async () => {
  assert.equal(
    (
      await request(
        '/api/admin/orders/' + orderId,
        'PUT',
        { status: 'completed', payment_status: 'unpaid' },
        'owner',
      )
    ).status,
    400,
  );
  await request('/api/admin/products/' + id, 'DELETE', null, 'owner');
  assert.equal(
    (
      await request('/api/orders', 'POST', {
        items: [{ id, quantity: 1 }],
        payment_method: 'whatsapp',
        player_id: '123',
        idempotency_key: crypto.randomUUID(),
      })
    ).status,
    409,
  );
});
test('catalog import is atomic and forces drafts', async () => {
  const before = sqlite.prepare('SELECT count(*) AS count FROM products').get().count;
  const bad = await request(
    '/api/admin/import',
    'POST',
    {
      products: [
        { ...product, slug: 'same' },
        { ...product, slug: 'same' },
      ],
    },
    'owner',
  );
  assert.equal(bad.status, 400);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM products').get().count, before);
  const ok = await request(
    '/api/admin/import',
    'POST',
    { products: [{ ...product, slug: 'import-a', status: 'active' }] },
    'owner',
  );
  assert.equal(ok.status, 200);
  assert.equal(
    sqlite.prepare('SELECT status FROM products WHERE slug=?').get('import-a').status,
    'draft',
  );
});
test('admin can permanently delete unused products but order history blocks deletion', async () => {
  let r = await request(
    '/api/admin/products',
    'POST',
    { ...product, slug: 'delete-me', status: 'draft' },
    'owner',
  );
  assert.equal(r.status, 201);
  const deletableId = r.body.product.id;
  r = await request('/api/admin/products/' + deletableId + '/permanent', 'DELETE', null, 'owner');
  assert.equal(r.status, 200);
  assert.equal(sqlite.prepare('SELECT id FROM products WHERE id=?').get(deletableId), undefined);
  r = await request('/api/admin/products/' + id + '/permanent', 'DELETE', null, 'owner');
  assert.equal(r.status, 409);
  assert.ok(sqlite.prepare('SELECT id FROM products WHERE id=?').get(id));
});
test('bulk publish and delete are validated and deletion is atomic', async () => {
  const a = await request(
    '/api/admin/products',
    'POST',
    { ...product, slug: 'bulk-a', status: 'draft' },
    'owner',
  );
  const b = await request(
    '/api/admin/products',
    'POST',
    { ...product, slug: 'bulk-b', status: 'draft' },
    'owner',
  );
  const ids = [a.body.product.id, b.body.product.id];
  let r = await request('/api/admin/products/bulk', 'POST', { action: 'publish', ids }, 'owner');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM products WHERE id IN (?,?) AND status='active'")
      .get(...ids).n,
    2,
  );
  r = await request(
    '/api/admin/products/bulk',
    'POST',
    { action: 'delete', ids: [ids[0], id] },
    'owner',
  );
  assert.equal(r.status, 409);
  assert.ok(sqlite.prepare('SELECT id FROM products WHERE id=?').get(ids[0]));
  r = await request('/api/admin/products/bulk', 'POST', { action: 'delete', ids }, 'owner');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS n FROM products WHERE id IN (?,?)').get(...ids).n,
    0,
  );
  assert.equal(
    (await request('/api/admin/products/bulk', 'POST', { action: 'publish', ids: [] }, 'owner'))
      .status,
    400,
  );
});
test('store converts prices and the order preserves the selected currency snapshot', async () => {
  const created = await request(
    '/api/admin/products',
    'POST',
    {
      ...product,
      name: 'بطاقة عملات',
      slug: 'currency-card',
      price_cents: 1000,
      player_id_required: false,
    },
    'owner',
  );
  const currencyId = created.body.product.id;
  const catalog = await request('/api/store?currency=ILS', 'GET', null, null);
  const shown = catalog.body.products.find((p) => p.id === currencyId);
  assert.equal(shown.price_cents, 3700);
  assert.equal(shown.currency, 'ILS');
  assert.equal(catalog.body.market.countries.length, 7);
  const placed = await request('/api/orders', 'POST', {
    items: [{ id: currencyId, quantity: 1 }],
    display_currency: 'ILS',
    payment_method: 'whatsapp',
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(placed.status, 201);
  let saved = sqlite
    .prepare('SELECT total_cents,currency FROM orders WHERE id=?')
    .get(placed.body.order_id);
  assert.equal(saved.total_cents, 3700);
  assert.equal(saved.currency, 'ILS');
  sqlite.prepare("UPDATE exchange_rates SET rate_units=4000000 WHERE currency='ILS'").run();
  saved = sqlite
    .prepare('SELECT total_cents,currency FROM orders WHERE id=?')
    .get(placed.body.order_id);
  assert.equal(saved.total_cents, 3700);
  assert.equal(saved.currency, 'ILS');
});
