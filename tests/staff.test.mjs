import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { staffIdentity, canManage } from '../src/lib/staff.mjs';
import { createStoreHandler } from '../src/lib/store-api.mjs';
const owner = 'supabase:9fe15a87-5c6a-4575-839d-5bf4905aef6e';
function setup() {
  const sql = new DatabaseSync(':memory:');
  for (const f of [
    '0001_store',
    '0003_supabase_roles',
    '0004_foxreload',
    '0005_exchange_rates',
    '0006_payunit',
    '0007_product_guides',
    '0013_order_item_accounts',
    '0014_steam',
  ])
    sql.exec(readFileSync(new URL('../migrations/' + f + '.sql', import.meta.url), 'utf8'));
  for (const id of [owner, 'staff', 'buyer', 'manager'])
    sql.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, id + '@example.test', id, '2026');
  sql.exec(readFileSync(new URL('../migrations/0009_staff.sql', import.meta.url), 'utf8'));
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
      return ss.map((s) => sql.prepare(s.q).run(...s.args));
    },
  };
  const handle = createStoreHandler({
    db,
    resolveIdentity: async (r) => {
      const id = r.headers.get('who');
      return id
        ? staffIdentity(db, { id, email: id + '@example.test', name: id, role: 'customer' })
        : null;
    },
  });
  async function req(path, method = 'GET', body, who = owner) {
    const r = await handle(
      new Request('https://rivo.test' + path, {
        method,
        headers: { who, origin: 'https://rivo.test' },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: r.status, data: await r.json() };
  }
  return { sql, db, req };
}
test('owner is promoted by exact ID, can assign staff, and cannot demote itself', async () => {
  const x = setup();
  assert.equal((await staffIdentity(x.db, { id: owner })).role, 'owner');
  assert.equal(
    (
      await x.req('/api/admin/team/' + encodeURIComponent(owner), 'PUT', {
        role: 'customer',
        active: true,
        permissions: [],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await x.req('/api/admin/team/staff', 'PUT', {
        role: 'support',
        active: true,
        permissions: [],
      })
    ).status,
    200,
  );
  assert.equal((await x.req('/api/admin/team', 'GET', null, 'staff')).status, 403);
  assert.equal((await x.req('/api/admin/team', 'GET', null, 'buyer')).status, 403);
});
test('custom admin permissions and disabled staff are enforced by current database state', async () => {
  const x = setup();
  await x.req('/api/admin/team/manager', 'PUT', {
    role: 'admin',
    active: true,
    permissions: ['products'],
  });
  assert.equal((await x.req('/api/admin/orders', 'GET', null, 'manager')).status, 403);
  assert.equal((await x.req('/api/admin/settings', 'PUT', {}, 'manager')).status, 403);
  assert.equal((await x.req('/api/admin/team', 'GET', null, 'manager')).status, 403);
  const u = await staffIdentity(x.db, { id: 'manager' });
  assert.equal(canManage(u, 'products'), true);
  assert.equal(canManage(u, 'suppliers'), false);
  await x.req('/api/admin/team/manager', 'PUT', {
    role: 'admin',
    active: false,
    permissions: ['products'],
  });
  assert.equal((await staffIdentity(x.db, { id: 'manager', role: 'admin' })).role, 'customer');
});
test('support can search and add internal notes without private admin notes or financial actions', async () => {
  const x = setup();
  await x.req('/api/admin/team/staff', 'PUT', { role: 'support', active: true, permissions: [] });
  const id = crypto.randomUUID();
  x.sql
    .prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      id,
      'buyer',
      'whatsapp',
      'paid',
      'processing',
      1000,
      'USD',
      '123',
      'customer text',
      'ADMIN SECRET',
      '',
      crypto.randomUUID(),
      '2026',
      '2026',
    );
  const d = await x.req('/api/support/orders/' + id, 'GET', null, 'staff');
  assert.equal(d.status, 200);
  assert.equal(d.data.order.admin_note, undefined);
  assert.equal(d.data.order.idempotency_key, undefined);
  assert.equal((await x.req('/api/support/orders?q=' + id, 'GET', null, 'staff')).data.total, 1);
  assert.equal(
    (await x.req('/api/support/orders/' + id, 'POST', { note: 'Needs manager review' }, 'staff'))
      .status,
    200,
  );
  assert.equal(
    (await x.req('/api/support/orders/' + id, 'GET', null, 'staff')).data.notes.length,
    1,
  );
  assert.equal(
    (
      await x.req(
        '/api/admin/orders/' + id,
        'PUT',
        { status: 'completed', payment_status: 'paid' },
        'staff',
      )
    ).status,
    403,
  );
  assert.equal((await x.req('/api/support/orders', 'GET', null, 'buyer')).status, 403);
});
