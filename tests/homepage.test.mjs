import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHomepage, validateHome, internalLink, homeImage } from '../lib/homepage.mjs';
import { homeDefaults, selectHomeGroups } from '../public/home-content.js';
test('home manual selection preserves order, deduplicates merged groups and never fills absent choices', () => {
  const a = { id: 'a', available: false, variants: [{ id: 'p1' }, { id: 'p2' }] },
    b = { id: 'b', available: true, variants: [{ id: 'p3' }] },
    c = { id: 'c', available: true, variants: [{ id: 'p4' }] };
  const f = { enabled: true, mode: 'manual', limit: 8, product_ids: ['p1', 'p3', 'p2', 'hidden'] };
  assert.deepEqual(selectHomeGroups([a, b, c], f), [a, b]);
  assert.deepEqual(selectHomeGroups([a, b, c], { ...f, limit: 1 }), [a]);
  assert.deepEqual(selectHomeGroups([a, b, c], { ...f, enabled: false }), []);
  assert.deepEqual(selectHomeGroups([a, b, c], { ...f, product_ids: [] }), []);
  assert.deepEqual(selectHomeGroups([a, b, c], { ...f, mode: 'auto', limit: 2 }), [b, c]);
});
test('homepage rejects unsafe links/images, oversized content and duplicated selections', () => {
  for (const v of [
    'javascript:alert(1)',
    '//evil.test',
    '/\\evil.test',
    '/foo\nbar',
    'https://evil.test',
  ])
    assert.throws(() => internalLink(v));
  assert.equal(internalLink('/product.html?id=abc'), '/product.html?id=abc');
  assert.equal(homeImage('/media/photo.png'), '/media/photo.png');
  for (const v of [
    'data:image/svg+xml,x',
    'http://bad.test/a',
    'https://user:pass@bad.test/a',
    '/assets/../private',
  ])
    assert.throws(() => homeImage(v));
  const home = homeDefaults();
  home.hero.description = 'سطر أول\nسطر ثاني';
  assert.equal(validateHome(home).hero.description, home.hero.description);
  assert.throws(() =>
    validateHome({ ...home, featured: { ...home.featured, product_ids: ['a', 'a'] } }),
  );
  assert.throws(() => validateHome({ ...home, featured: { ...home.featured, limit: 13 } }));
});
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(
    "CREATE TABLE settings(id TEXT PRIMARY KEY,value TEXT);CREATE TABLE products(id TEXT,status TEXT);INSERT INTO products VALUES('a','active'),('b','draft')",
  );
  function p(q, args = []) {
    return {
      bind(...v) {
        return p(q, v);
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
  const handle = createHomepage({ prepare: p }, async (req) => {
    const role = req.headers.get('who');
    return role
      ? {
          role: role === 'settings' ? 'admin' : role,
          permissions: role === 'settings' ? ['settings'] : ['products'],
        }
      : null;
  });
  const request = async (
    method = 'GET',
    body,
    who = 'owner',
    origin = 'https://rivo.test',
    path = '/api/admin/homepage',
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
  return { sql, request };
}
test('homepage settings permission and origin are enforced; existing base settings remain untouched', async () => {
  const x = fixture();
  x.sql.prepare('INSERT INTO settings VALUES (?,?)').run('store', '{"heroTitle":"Existing"}');
  assert.equal((await x.request('GET', undefined, 'support')).status, 403);
  assert.equal((await x.request('GET', undefined, 'admin')).status, 403);
  assert.equal((await x.request('GET', undefined, 'settings')).status, 200);
  assert.equal((await x.request('PUT', homeDefaults(), 'owner', 'https://evil.test')).status, 403);
  assert.equal((await x.request('PUT', homeDefaults(), 'settings')).status, 200);
  assert.equal(
    JSON.parse(x.sql.prepare("SELECT value FROM settings WHERE id='store'").get().value).heroTitle,
    'Existing',
  );
});
test('public homepage hides disabled banners and unpublished featured references', async () => {
  const x = fixture(),
    home = homeDefaults();
  home.featured.mode = 'manual';
  home.featured.product_ids = ['b', 'a'];
  home.banners = [
    {
      id: 'sale',
      enabled: true,
      theme: 'purple',
      title: 'عرض',
      text: 'تفاصيل',
      button: 'تصفح',
      link: '/products.html',
      image: '',
    },
    {
      id: 'draft',
      enabled: false,
      theme: 'cyan',
      title: 'Secret draft',
      text: '',
      button: 'تصفح',
      link: '/products.html',
      image: '',
    },
  ];
  assert.equal((await x.request('PUT', home)).status, 200);
  const r = await x.request('GET', undefined, null, 'https://rivo.test', '/api/homepage');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.featured.product_ids, ['a']);
  assert.equal(r.data.banners.length, 1);
  assert.ok(!JSON.stringify(r.data).includes('Secret draft'));
  assert.equal((await x.request()).data.banners.length, 2);
});
test('concurrent homepage updates and stale saves cannot overwrite newer content', async () => {
  const x = fixture(),
    home = homeDefaults();
  const r = await Promise.all([
    x.request('PUT', home),
    x.request('PUT', { ...home, hero: { ...home.hero, title: 'Other' } }),
  ]);
  assert.deepEqual(r.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await x.request('PUT', home)).status, 409);
  assert.equal((await x.request()).data.version, 1);
});
test('new unknown featured IDs and malformed banner data are rejected without mutation', async () => {
  const x = fixture(),
    h = homeDefaults();
  assert.equal(
    (await x.request('PUT', { ...h, featured: { ...h.featured, product_ids: ['unknown'] } }))
      .status,
    400,
  );
  assert.equal((await x.request('PUT', { ...h, banners: [{ id: 'x' }] })).status, 400);
  assert.equal((await x.request()).data.version, 0);
});
test('unpublished reference keeps its group featured through another active denomination without exposing drafts', async () => {
  const x = fixture(),
    h = homeDefaults();
  x.sql
    .prepare('INSERT INTO settings VALUES (?,?)')
    .run(
      'catalog:groups',
      JSON.stringify({
        version: 1,
        groups: [{ id: 'game', title: 'Game', kind: 'topup', product_ids: ['a', 'b'] }],
      }),
    );
  h.featured.mode = 'manual';
  h.featured.product_ids = ['b'];
  assert.equal((await x.request('PUT', h)).status, 200);
  const pub = await x.request('GET', undefined, null, 'https://rivo.test', '/api/homepage');
  assert.deepEqual(pub.data.featured.product_ids, ['a']);
  assert.equal(pub.data.resolved, undefined);
  const admin = await x.request();
  assert.deepEqual(admin.data.featured.product_ids, ['b']);
  assert.deepEqual(admin.data.resolved, [{ reference: 'b', product_id: 'a' }]);
  x.sql.prepare("UPDATE products SET status='draft' WHERE id='a'").run();
  assert.deepEqual(
    (await x.request('GET', undefined, null, 'https://rivo.test', '/api/homepage')).data.featured
      .product_ids,
    [],
  );
});
