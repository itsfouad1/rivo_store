import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createFoxreload } from '../lib/foxreload.mjs';
function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const calls = [];
  let status = 200;
  function p(q, args = []) {
    return {
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
  const db = { prepare: p };
  const fox = createFoxreload(
    { DB: db, FOXRELOAD_API_KEY: 'fixture-key' },
    async (req) => {
      const role = req.headers.get('role');
      return role ? { id: role, role } : null;
    },
    async (url, init) => {
      const u = new URL(url);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers['X-API-Key'], 'fixture-key');
      calls.push(u);
      if (status !== 200)
        return Response.json({ detail: 'never expose supplier response' }, { status });
      if (u.pathname === '/api/categories/')
        return Response.json({
          items: [
            {
              id: 'steam-category',
              slug: 'steam-balance-top-up',
              name: 'Steam',
              parentId: u.searchParams.get('parentId'),
            },
          ],
          nextCursor: u.searchParams.has('cursor') ? null : 'category-next',
        });
      if (u.pathname === '/api/products/')
        return Response.json({
          items: [{ id: 'product_page', name: 'Card' }],
          nextCursor: u.searchParams.has('cursor') ? null : 'product-next',
        });
      throw Error('Unexpected request ' + u.pathname);
    },
  );
  async function request(query, role = 'admin') {
    const r = await fox.handle(
      new Request('https://rivo.test/api/admin/foxreload/' + query, {
        headers: role ? { role } : {},
      }),
    );
    return { status: r.status, data: await r.json() };
  }
  return {
    request,
    calls,
    setStatus(s) {
      status = s;
    },
  };
}
test('categories use paginated list instead of rejected tree endpoint, preserving parent and name filters', async () => {
  const x = fixture();
  const a = await x.request('categories?limit=20&parentId=games&name=Steam');
  assert.equal(a.status, 200);
  assert.equal(a.data.nextCursor, 'category-next');
  const u = x.calls[0];
  assert.equal(u.pathname, '/api/categories/');
  assert.equal(u.searchParams.get('parentId'), 'games');
  assert.equal(u.searchParams.get('name'), 'Steam');
  assert.equal(u.searchParams.get('limit'), '20');
  assert.equal(u.searchParams.has('depth'), false);
  const b = await x.request('categories?limit=20&parentId=games&name=Steam&cursor=category-next');
  assert.equal(b.data.nextCursor, null);
  assert.equal(x.calls[1].searchParams.get('cursor'), 'category-next');
});
test('catalog forwards page size, descendant cursor, category and stock filter without creating orders', async () => {
  const x = fixture();
  const first = await x.request('catalog?categoryId=steam&limit=100&withStockOnly=true');
  assert.equal(first.status, 200);
  assert.equal(first.data.nextCursor, 'product-next');
  const u = x.calls[0];
  assert.equal(u.searchParams.get('limit'), '100');
  assert.equal(u.searchParams.get('includeDescendants'), 'true');
  assert.equal(u.searchParams.get('withStockOnly'), 'true');
  const next = await x.request(
    'catalog?categoryId=steam&limit=100&withStockOnly=true&cursor=product-next',
  );
  assert.equal(next.data.nextCursor, null);
  assert.equal(x.calls[1].searchParams.get('cursor'), 'product-next');
  assert.equal(x.calls[1].searchParams.get('categoryId'), 'steam');
});
test('category and catalog filters are bounded; supplier browsing remains permission scoped', async () => {
  const x = fixture();
  for (const q of [
    'categories?limit=500',
    'catalog?limit=0',
    'categories?cursor=' + 'a'.repeat(513),
    'catalog?cursor=' + 'a'.repeat(513),
    'categories?name=' + 'a'.repeat(129),
  ])
    assert.equal((await x.request(q)).status, 400);
  assert.equal((await x.request('categories', null)).status, 401);
  assert.equal((await x.request('categories', 'support')).status, 403);
  assert.equal((await x.request('catalog', 'customer')).status, 403);
  assert.equal(x.calls.length, 0);
});
test('HTTP 422 is described as rejected parameters, without exposing provider detail or blaming balance', async () => {
  const x = fixture();
  x.setStatus(422);
  const r = await x.request('categories');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /معلمات/);
  assert.ok(!r.data.error.includes('never expose'));
  assert.ok(!r.data.error.includes('fixture-key'));
});
test('numbered cursor navigation preserves known back pages and prunes a changed forward branch', () => {
  const code = readFileSync(new URL('../public/foxreload.js', import.meta.url), 'utf8');
  const { make, remember } = runInNewContext(code + '\n({make:foxNewPager,remember:foxRemember})');
  const pager = make();
  remember(pager, 1, 'next-A');
  remember(pager, 2, 'next-B');
  remember(pager, 3, null);
  assert.equal(pager.cursors[1], '');
  assert.equal(pager.cursors[2], 'next-A');
  assert.equal(pager.cursors[3], 'next-B');
  assert.equal(pager.next, null);
  remember(pager, 1, 'next-A');
  assert.equal(pager.cursors[3], 'next-B');
  remember(pager, 2, 'revised-next');
  assert.equal(pager.cursors[3], 'revised-next');
  assert.equal(pager.cursors[4], undefined);
  remember(pager, 2, null);
  assert.equal(pager.cursors[3], undefined);
});
