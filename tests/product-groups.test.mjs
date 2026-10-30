import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { groupProducts, groupUrl, resolveGroup } from '../public/js/product-groups.js';
import { filterProducts } from '../public/js/catalog.js';
import { createCollections } from '../src/lib/collections.mjs';
const payment = { whatsapp: '970599000000' };
const product = (id, name, extra = {}) => ({
  id,
  name,
  category: 'FoxReload',
  region: 'US',
  currency: 'USD',
  price_cents: 1000,
  payment_mode: 'whatsapp',
  player_id_required: 1,
  ...extra,
});
test('groups denominations by brand and service type, never by broad supplier category', () => {
  const ps = [
    product('p1', 'PUBG Mobile 60 UC'),
    product('p2', 'PUBG Mobile 600 UC'),
    product('p3', 'Steam 10 USD', { account_type: 'steam' }),
    product('p4', 'Steam Gift Card', { player_id_required: 0 }),
    product('p5', 'Mystery A'),
    product('p6', 'Mystery B'),
  ];
  const gs = groupProducts(ps, [], payment);
  assert.equal(gs.length, 5);
  assert.equal(gs.find((g) => g.id === 'pubg-mobile:topup').variants.length, 2);
  assert.ok(gs.some((g) => g.id === 'steam:topup'));
  assert.ok(gs.some((g) => g.id === 'steam:cards'));
  assert.deepEqual(
    ps.map((p) => p.id),
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
  );
});
test('group starting prices respect matched variants and do not advertise unavailable cheapest stock', () => {
  const ps = [
    product('a', 'PUBG Mobile 10 UC', { price_cents: 10, available: false }),
    product('b', 'PUBG Mobile 60 UC', { price_cents: 600, region: 'EU' }),
    product('c', 'PUBG Mobile 30 UC', { price_cents: 300 }),
  ];
  assert.equal(groupProducts(ps, [], payment)[0].price_cents, 300);
  const filtered = filterProducts(ps, { region: 'EU' }, payment);
  assert.equal(groupProducts(filtered, [], payment)[0].price_cents, 600);
});
test('manual grouping overrides inference; direct product links resolve the exact variant group', () => {
  const ps = [product('a', 'Unknown pack A'), product('b', 'Unknown pack B')];
  const gs = groupProducts(
    ps,
    [{ id: 'my-game', title: 'لعبتي', kind: 'topup', product_ids: ['a', 'b'] }],
    payment,
  );
  assert.equal(gs.length, 1);
  assert.equal(gs[0].title, 'لعبتي');
  assert.equal(gs[0].variants[1].id, 'b');
  assert.equal(resolveGroup(gs, new URLSearchParams('id=b')).id, 'custom:my-game');
  assert.equal(resolveGroup(gs, new URLSearchParams('id=deleted')), undefined);
  assert.equal(groupUrl(gs[0]), '/product.html?group=custom%3Amy-game');
});
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(
    "CREATE TABLE settings(id TEXT PRIMARY KEY,value TEXT);CREATE TABLE products(id TEXT PRIMARY KEY,status TEXT);INSERT INTO products VALUES ('a','active'),('b','draft'),('c','active')",
  );
  function statement(q, args = []) {
    return {
      bind(...v) {
        return statement(q, v);
      },
      async first() {
        return sql.prepare(q).get(...args);
      },
      async all() {
        return { results: sql.prepare(q).all(...args) };
      },
      async run() {
        return sql.prepare(q).run(...args);
      },
    };
  }
  const handle = createCollections({ prepare: statement }, async (req) => {
    const who = req.headers.get('who');
    return who
      ? {
          id: who,
          role: who === 'owner' ? 'owner' : who === 'support' ? 'support' : 'admin',
          permissions: who === 'admin' ? ['products'] : [],
        }
      : null;
  });
  const request = async (
    path = '/api/admin/collections',
    method = 'GET',
    body,
    who = 'owner',
    origin = 'https://rivo.test',
  ) => {
    const r = await handle(
      new Request('https://rivo.test' + path, {
        method,
        headers: { ...(who ? { who } : {}), origin },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: r.status, data: await r.json() };
  };
  const group = { id: 'game', title: 'Game', kind: 'topup', product_ids: ['a', 'b'] };
  return { sql, request, group };
}
test('collections are permission and origin protected; public mapping excludes drafts and empty groups', async () => {
  const x = fixture();
  assert.equal((await x.request(undefined, 'GET', undefined, 'support')).status, 403);
  assert.equal((await x.request(undefined, 'GET', undefined, 'restricted')).status, 403);
  assert.equal((await x.request(undefined, 'GET', undefined, 'admin')).status, 200);
  assert.equal(
    (
      await x.request(
        undefined,
        'PUT',
        { version: 0, groups: [x.group] },
        'owner',
        'https://evil.test',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await x.request(
        undefined,
        'PUT',
        {
          version: 0,
          groups: [
            x.group,
            { id: 'draft', title: 'Private draft', kind: 'cards', product_ids: ['c'] },
          ],
        },
        'admin',
      )
    ).status,
    200,
  );
  x.sql.prepare("UPDATE products SET status='draft' WHERE id='c'").run();
  const r = await x.request('/api/collections', 'GET', undefined, null);
  assert.deepEqual(r.data.groups, [{ ...x.group, product_ids: ['a'] }]);
  assert.ok(!JSON.stringify(r.data).includes('Private draft'));
});
test('collections reject duplicate membership, missing products and stale saves without losing stored config', async () => {
  const x = fixture();
  assert.equal(
    (
      await x.request(undefined, 'PUT', {
        version: 0,
        groups: [x.group, { ...x.group, id: 'other' }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await x.request(undefined, 'PUT', {
        version: 0,
        groups: [{ ...x.group, product_ids: ['missing'] }],
      })
    ).status,
    409,
  );
  assert.equal((await x.request(undefined, 'PUT', { version: 0, groups: [x.group] })).status, 200);
  assert.equal((await x.request(undefined, 'PUT', { version: 0, groups: [] })).status, 409);
  assert.equal((await x.request()).data.groups.length, 1);
  assert.equal((await x.request(undefined, 'PUT', { version: 1, groups: [] })).status, 200);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM products').get().n, 3);
});
test('concurrent collection saves have one winner, not silent overwrites', async () => {
  const x = fixture();
  const r = await Promise.all([
    x.request(undefined, 'PUT', { version: 0, groups: [x.group] }),
    x.request(undefined, 'PUT', { version: 0, groups: [] }),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  assert.equal((await x.request()).data.version, 1);
});
