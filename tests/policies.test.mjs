import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createStoreHandler } from '../src/lib/store-api.mjs';
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_store.sql', import.meta.url), 'utf8'));
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
    async batch(ss) {
      return ss.map((s) => sql.prepare(s.q).run(...s.args));
    },
  };
  const handle = createStoreHandler({
    db,
    resolveIdentity: async (req) => {
      const id = req.headers.get('who');
      return id
        ? { id, name: id, email: id + '@example.test', role: id === 'admin' ? 'admin' : 'customer' }
        : null;
    },
  });
  async function request(path, method = 'GET', body, who = 'admin', origin = 'https://rivo.test') {
    const r = await handle(
      new Request('https://rivo.test' + path, {
        method,
        headers: {
          ...(who ? { who } : {}),
          ...(method === 'GET' ? {} : { origin, 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: r.status, cache: r.headers.get('cache-control'), data: await r.json() };
  }
  const update = (type, body) => request('/api/admin/policies/' + type, 'PUT', body);
  return { sql, request, update };
}
test('policies start unpublished; drafts and management endpoints are private', async () => {
  const x = fixture();
  const list = await x.request('/api/policies', 'GET', undefined, null);
  assert.deepEqual(list.data.pages, []);
  assert.equal(list.cache, 'no-store');
  for (const type of ['privacy', 'terms', 'refunds'])
    assert.equal((await x.request('/api/policies/' + type, 'GET', undefined, null)).status, 404);
  assert.equal((await x.request('/api/admin/policies', 'GET', undefined, null)).status, 401);
  assert.equal((await x.request('/api/admin/policies', 'GET', undefined, 'buyer')).status, 403);
  const payload = { action: 'save', revision: 0, title: 'مسودة', body: 'PRIVATE DRAFT' };
  assert.equal(
    (await x.request('/api/admin/policies/privacy', 'PUT', payload, 'buyer')).status,
    403,
  );
  assert.equal(
    (await x.request('/api/admin/policies/privacy', 'PUT', payload, 'admin', 'https://evil.test'))
      .status,
    403,
  );
  assert.equal((await x.update('privacy', payload)).status, 200);
  assert.equal((await x.request('/api/policies', 'GET', undefined, null)).data.pages.length, 0);
  assert.equal((await x.request('/api/policies/privacy', 'GET', undefined, null)).status, 404);
  assert.equal((await x.request('/api/admin/policies')).data.pages[0].draft.body, 'PRIVATE DRAFT');
});
test('publish uses saved draft, later saves preserve the public snapshot, unpublish hides without deleting draft', async () => {
  const x = fixture();
  let r = await x.update('terms', {
    action: 'save',
    revision: 0,
    title: 'شروط المتجر',
    body: 'النص الأول',
  });
  assert.equal(r.data.page.revision, 1);
  r = await x.update('terms', {
    action: 'publish',
    revision: 1,
    title: 'forged',
    body: 'not saved',
  });
  assert.equal(r.data.page.published.body, 'النص الأول');
  let p = await x.request('/api/policies/terms', 'GET', undefined, null);
  assert.equal(p.data.page.version, 2);
  assert.equal(p.data.page.title, 'شروط المتجر');
  assert.equal(p.data.page.draft, undefined);
  await x.update('terms', {
    action: 'save',
    revision: 2,
    title: 'عنوان جديد',
    body: 'مسودة جديدة',
  });
  p = await x.request('/api/policies/terms', 'GET', undefined, null);
  assert.equal(p.data.page.body, 'النص الأول');
  const metadata = (await x.request('/api/policies', 'GET', undefined, null)).data.pages[0];
  assert.equal(metadata.title, 'شروط المتجر');
  assert.equal(metadata.body, undefined);
  assert.equal(metadata.draft, undefined);
  await x.update('terms', { action: 'publish', revision: 3 });
  p = await x.request('/api/policies/terms', 'GET', undefined, null);
  assert.equal(p.data.page.body, 'مسودة جديدة');
  assert.equal(p.data.page.version, 4);
  await x.update('terms', { action: 'unpublish', revision: 4 });
  assert.equal((await x.request('/api/policies/terms', 'GET', undefined, null)).status, 404);
  const saved = (await x.request('/api/admin/policies')).data.pages.find((p) => p.type === 'terms');
  assert.equal(saved.draft.body, 'مسودة جديدة');
  assert.equal(saved.published, null);
});
test('policy validation rejects invalid actions, fields, slugs and empty publication', async () => {
  const x = fixture();
  assert.equal((await x.update('privacy', { action: 'publish', revision: 0 })).status, 400);
  for (const body of [
    { action: 'bad', revision: 0 },
    { action: 'save', revision: 0, title: 'x'.repeat(121), body: '' },
    { action: 'save', revision: 0, title: 'x', body: 'x'.repeat(20001) },
    { action: 'save', revision: 0, title: 'x', body: { html: 'bad' } },
    { action: 'save', title: 'x', body: 'x' },
  ])
    assert.ok([400, 409].includes((await x.update('privacy', body)).status));
  assert.equal(
    (await x.update('other', { action: 'save', revision: 0, title: 'x', body: 'x' })).status,
    404,
  );
  assert.equal(
    (await x.update('constructor', { action: 'save', revision: 0, title: 'x', body: 'x' })).status,
    404,
  );
  assert.equal((await x.request('/api/policies/constructor', 'GET', undefined, null)).status, 404);
});
test('concurrent edits reject stale revisions and audit only successful mutations', async () => {
  const x = fixture();
  const body = { action: 'save', revision: 0, title: 'x', body: 'first' };
  const r = await Promise.all([
    x.update('refunds', body),
    x.update('refunds', { ...body, body: 'second' }),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  assert.equal(
    x.sql.prepare("SELECT count(*) AS n FROM audit WHERE action='policy_save'").get().n,
    1,
  );
  assert.equal((await x.update('refunds', { ...body, body: 'stale' })).status, 409);
  const stored = (await x.request('/api/admin/policies')).data.pages.find(
    (p) => p.type === 'refunds',
  );
  assert.equal(stored.revision, 1);
  assert.ok(['first', 'second'].includes(stored.draft.body));
});
test('policy storage does not alter store settings and audit never contains page content', async () => {
  const x = fixture();
  x.sql
    .prepare('INSERT INTO settings VALUES (?,?)')
    .run('store', JSON.stringify({ storeName: 'RIVO existing', whatsapp: '970599123456' }));
  await x.update('privacy', {
    action: 'save',
    revision: 0,
    title: 'عنوان',
    body: '<script>PRIVATE CONTENT</script>',
  });
  await x.update('privacy', { action: 'publish', revision: 1 });
  assert.equal(
    JSON.parse(x.sql.prepare("SELECT value FROM settings WHERE id='store'").get().value).storeName,
    'RIVO existing',
  );
  const p = await x.request('/api/policies/privacy', 'GET', undefined, null);
  assert.equal(p.data.page.body, '<script>PRIVATE CONTENT</script>');
  assert.ok(
    !JSON.stringify(x.sql.prepare('SELECT * FROM audit').all()).includes('PRIVATE CONTENT'),
  );
});
