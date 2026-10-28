import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createStoreHandler } from '../lib/store-api.mjs';
import { staffIdentity } from '../lib/staff.mjs';
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
    '0009_staff',
    '0010_chat',
    '0011_chat_reads',
    '0012_support_tools',
  ])
    sql.exec(readFileSync(new URL('../migrations/' + f + '.sql', import.meta.url), 'utf8'));
  for (const id of ['buyer', 'other', 'support', 'second', 'admin', 'owner']) {
    sql.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, id + '@test.invalid', id, '2026');
    if (['support', 'second', 'admin', 'owner'].includes(id))
      sql
        .prepare('INSERT INTO staff_access(user_id,role) VALUES (?,?)')
        .run(id, id === 'second' ? 'support' : id);
  }
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
    },
    handle = createStoreHandler({
      db,
      resolveIdentity: async (r) => {
        const id = r.headers.get('who');
        return id
          ? staffIdentity(db, { id, email: id + '@test.invalid', name: id, role: 'customer' })
          : null;
      },
    });
  async function req(path, method = 'GET', body, who = 'buyer', origin = 'https://rivo.test') {
    const r = await handle(
      new Request('https://rivo.test/api/chat' + path, {
        method,
        headers: { ...(who ? { who } : {}), origin },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: r.status, data: await r.json(), cache: r.headers.get('cache-control') };
  }
  const create = (who = 'buyer', extra = {}) =>
    req('', 'POST', { message: 'أحتاج مساعدة', client_id: crypto.randomUUID(), ...extra }, who);
  async function action(id, action, who = 'support', extra = {}) {
    const c = sql.prepare('SELECT * FROM chat_conversations WHERE id=?').get(id);
    return req('/' + id + '/action', 'POST', { action, revision: c.revision, ...extra }, who);
  }
  function order(who = 'buyer') {
    const id = crypto.randomUUID();
    sql
      .prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        who,
        'whatsapp',
        'unpaid',
        'contact_pending',
        1000,
        'USD',
        '',
        '',
        'ADMIN SECRET',
        '',
        crypto.randomUUID(),
        '2026',
        '2026',
      );
    return id;
  }
  return { sql, req, create, action, order };
}
test('customer chat authentication, origin, order ownership and private transcripts', async () => {
  const x = setup();
  assert.equal((await x.req('', 'GET', undefined, null)).status, 401);
  assert.equal(
    (
      await x.req(
        '',
        'POST',
        { message: 'x', client_id: crypto.randomUUID() },
        'buyer',
        'https://evil.test',
      )
    ).status,
    403,
  );
  assert.equal((await x.create('buyer', { order_id: x.order('other') })).status, 404);
  const r = await x.create('buyer', { order_id: x.order() });
  assert.equal(r.status, 201);
  const id = r.data.id;
  assert.equal((await x.req('/' + id, 'GET', undefined, 'other')).status, 404);
  assert.equal((await x.req('/queue')).status, 403);
  assert.equal((await x.req('/' + id)).cache, 'no-store');
  assert.ok(!JSON.stringify((await x.req('/' + id)).data).includes('ADMIN SECRET'));
  assert.equal(
    (
      await x.req('/' + id + '/messages', 'POST', {
        message: 'secret',
        internal: true,
        client_id: crypto.randomUUID(),
      })
    ).status,
    403,
  );
});
test('atomic claim prevents two staff members taking the same conversation', async () => {
  const x = setup(),
    id = (await x.create()).data.id;
  const r = await Promise.all(
    ['support', 'second'].map((who) =>
      x.req('/' + id + '/action', 'POST', { action: 'claim', revision: 0 }, who),
    ),
  );
  assert.deepEqual(r.map((r) => r.status).sort(), [200, 409]);
  const c = x.sql.prepare('SELECT * FROM chat_conversations').get();
  const other = c.assignee === 'support' ? 'second' : 'support';
  assert.equal((await x.req('/' + id, 'GET', undefined, other)).status, 404);
  assert.equal(
    (
      await x.req(
        '/' + id + '/messages',
        'POST',
        { message: 'not allowed', client_id: crypto.randomUUID() },
        other,
      )
    ).status,
    404,
  );
});
test('internal notes never appear in customer transcript and escalation hands control to management', async () => {
  const x = setup(),
    id = (await x.create()).data.id;
  await x.action(id, 'claim');
  await x.req(
    '/' + id + '/messages',
    'POST',
    { message: 'INTERNAL TEXT', internal: true, client_id: crypto.randomUUID() },
    'support',
  );
  await x.req(
    '/' + id + '/messages',
    'POST',
    { message: 'مرحبا بك', client_id: crypto.randomUUID() },
    'support',
  );
  let d = (await x.req('/' + id)).data;
  assert.equal(d.messages.length, 2);
  assert.ok(!JSON.stringify(d).includes('INTERNAL TEXT'));
  assert.equal(
    (await x.action(id, 'escalate', 'support', { reason: 'MANAGER REASON' })).status,
    200,
  );
  assert.equal((await x.req('/' + id, 'GET', undefined, 'support')).status, 404);
  assert.equal((await x.req('/queue', 'GET', undefined, 'support')).data.total, 0);
  d = (await x.req('/' + id)).data;
  assert.equal(d.conversation.status, 'escalated');
  assert.ok(!JSON.stringify(d).includes('MANAGER REASON'));
  assert.equal((await x.req('/queue?mode=escalated', 'GET', undefined, 'admin')).data.total, 1);
  assert.equal((await x.action(id, 'claim', 'admin')).status, 200);
  assert.ok(
    (await x.req('/' + id, 'GET', undefined, 'admin')).data.messages.some(
      (m) => m.visibility === 'internal',
    ),
  );
});
test('message retries and initial creation are idempotent even after the original chat closes', async () => {
  const x = setup(),
    b = { message: 'first', client_id: crypto.randomUUID() };
  const a = await x.req('', 'POST', b),
    repeat = await x.req('', 'POST', b);
  assert.equal(a.data.id, repeat.data.id);
  const id = a.data.id;
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM chat_messages').get().n, 1);
  assert.equal((await x.req('/' + id + '/close', 'POST', {})).status, 200);
  assert.equal((await x.req('', 'POST', b)).data.id, id);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM chat_conversations').get().n, 1);
  assert.equal(
    (
      await x.req('/' + id + '/messages', 'POST', {
        message: 'late',
        client_id: crypto.randomUUID(),
      })
    ).status,
    409,
  );
  const next = await x.create();
  assert.notEqual(next.data.id, id);
  assert.equal((await x.req('', 'POST', { ...b, message: 'changed' })).status, 409);
});
test('waiting for customer, manager release, notes and role revocation preserve access rules', async () => {
  const x = setup(),
    id = (await x.create()).data.id;
  await x.action(id, 'claim');
  await x.action(id, 'wait');
  assert.equal((await x.req('/' + id)).data.conversation.status, 'waiting_customer');
  await x.req('/' + id + '/messages', 'POST', { message: 'ردي', client_id: crypto.randomUUID() });
  assert.equal((await x.req('/' + id)).data.conversation.status, 'assigned');
  await x.action(id, 'release', 'owner');
  assert.equal((await x.req('/' + id, 'GET', undefined, 'support')).status, 404);
  await x.action(id, 'claim');
  x.sql.prepare("UPDATE staff_access SET active=0 WHERE user_id='support'").run();
  assert.equal((await x.req('/queue', 'GET', undefined, 'support')).status, 403);
  assert.equal((await x.req('/' + id, 'GET', undefined, 'support')).status, 404);
  assert.equal((await x.action(id, 'close', 'owner')).status, 200);
});
test('validation, throttling, message pagination and hidden notes', async () => {
  const x = setup(),
    id = (await x.create()).data.id;
  assert.equal((await x.req('/' + id + '?before=no')).status, 400);
  assert.equal((await x.req('/queue?page=0', 'GET', undefined, 'admin')).status, 400);
  assert.equal(
    (
      await x.req('/' + id + '/messages', 'POST', {
        message: 'x'.repeat(4001),
        client_id: crypto.randomUUID(),
      })
    ).status,
    400,
  );
  for (let i = 0; i < 29; i++)
    assert.equal(
      (
        await x.req('/' + id + '/messages', 'POST', {
          message: 'hello ' + i,
          client_id: crypto.randomUUID(),
        })
      ).status,
      201,
    );
  assert.equal(
    (
      await x.req('/' + id + '/messages', 'POST', {
        message: 'limit',
        client_id: crypto.randomUUID(),
      })
    ).status,
    429,
  );
  const insert = x.sql.prepare(
    "INSERT INTO chat_messages(conversation_id,sender_id,sender_kind,visibility,body,client_id,created_at) VALUES (?,'admin','staff',?,?,?,'2026')",
  );
  for (let i = 0; i < 120; i++)
    insert.run(id, i % 2 ? 'internal' : 'public', 'note ' + i, crypto.randomUUID());
  const latest = (await x.req('/' + id, 'GET', undefined, 'admin')).data;
  assert.equal(latest.messages.length, 100);
  assert.equal(latest.has_more, true);
  const older = (
    await x.req('/' + id + '?before=' + latest.messages[0].seq, 'GET', undefined, 'admin')
  ).data;
  assert.equal(older.messages.length, 50);
  assert.equal(older.has_more, false);
  assert.ok((await x.req('/' + id)).data.messages.every((m) => m.visibility === 'public'));
});
test('read counters are private per user, exclude internal notes for buyers, and GET never acknowledges', async () => {
  const x = setup(),
    id = (await x.create()).data.id;
  assert.equal((await x.req('/summary', 'GET', undefined, 'support')).data.unread_messages, 1);
  assert.equal((await x.req('/summary', 'GET', undefined, 'other')).data.unread_messages, 0);
  await x.action(id, 'claim');
  assert.equal((await x.req('/summary', 'GET', undefined, 'second')).data.unread_messages, 0);
  const staffView = (await x.req('/' + id, 'GET', undefined, 'support')).data;
  assert.equal((await x.req('/summary', 'GET', undefined, 'support')).data.unread_messages, 1);
  assert.equal(
    (
      await x.req(
        '/' + id + '/read',
        'POST',
        { last_seq: staffView.messages.at(-1).seq },
        'support',
      )
    ).status,
    200,
  );
  assert.equal((await x.req('/summary', 'GET', undefined, 'support')).data.unread_messages, 0);
  await x.req(
    '/' + id + '/messages',
    'POST',
    { message: 'private note', internal: true, client_id: crypto.randomUUID() },
    'support',
  );
  assert.equal((await x.req('/summary')).data.unread_messages, 0);
  const internal = x.sql
    .prepare("SELECT seq FROM chat_messages WHERE visibility='internal'")
    .get().seq;
  assert.equal((await x.req('/' + id + '/read', 'POST', { last_seq: internal })).status, 400);
  await x.req(
    '/' + id + '/messages',
    'POST',
    { message: 'reply one', client_id: crypto.randomUUID() },
    'support',
  );
  const shown = (await x.req('/' + id)).data.messages.at(-1).seq;
  await x.req(
    '/' + id + '/messages',
    'POST',
    { message: 'reply two', client_id: crypto.randomUUID() },
    'support',
  );
  assert.equal((await x.req('/summary')).data.unread_messages, 2);
  await x.req('/' + id + '/read', 'POST', { last_seq: shown });
  assert.equal((await x.req('/summary')).data.unread_messages, 1);
  assert.equal((await x.req('/' + id + '/read', 'POST', { last_seq: 1 }, 'other')).status, 404);
  assert.equal((await x.req('/' + id + '/read', 'POST', { last_seq: 999999 })).status, 400);
  const newer = (await x.req('/' + id)).data.messages.at(-1).seq;
  await x.req('/' + id + '/read', 'POST', { last_seq: newer });
  await x.req('/' + id + '/read', 'POST', { last_seq: shown });
  assert.equal((await x.req('/summary')).data.unread_messages, 0);
  assert.equal((await x.req('/summary', 'GET', undefined, 'owner')).data.unread_messages, 4);
  await x.action(id, 'close');
  assert.equal((await x.req('/summary')).data.unread_messages, 0);
});
test('new reader receives handoff context, stale readers cannot acknowledge after escalation', async () => {
  const x = setup(),
    id = (await x.create()).data.id;
  await x.action(id, 'claim');
  const old = (await x.req('/' + id, 'GET', undefined, 'support')).data.messages[0].seq;
  await x.action(id, 'escalate', 'support', { reason: 'internal reason' });
  assert.equal((await x.req('/' + id + '/read', 'POST', { last_seq: old }, 'support')).status, 404);
  assert.equal((await x.req('/summary', 'GET', undefined, 'support')).data.unread_messages, 0);
  assert.equal((await x.req('/summary', 'GET', undefined, 'owner')).data.unread_messages, 2);
  const owner = (await x.req('/' + id, 'GET', undefined, 'owner')).data;
  await x.req('/' + id + '/read', 'POST', { last_seq: owner.messages.at(-1).seq }, 'owner');
  assert.equal((await x.req('/summary', 'GET', undefined, 'owner')).data.unread_messages, 0);
  await x.action(id, 'claim', 'owner');
  await x.req(
    '/' + id + '/messages',
    'POST',
    { message: 'management answer', client_id: crypto.randomUUID() },
    'owner',
  );
  await x.action(id, 'close', 'owner');
  assert.equal((await x.req('/summary')).data.unread_messages, 1);
  assert.equal((await x.req('')).data.conversations[0].unread_count, 1);
});
test('queue search and filters span customer data, literal identifiers and permitted assignments', async () => {
  const x = setup(),
    order = x.order(),
    id = (await x.create('buyer', { order_id: order, subject: 'مشكلة تفعيل' })).data.id;
  x.sql
    .prepare("UPDATE users SET name='أحمد الدعم',email='AHMAD@example.test' WHERE id='buyer'")
    .run();
  for (const q of [
    'احمد',
    'ahmad@EXAMPLE.TEST',
    '#' + order.slice(0, 8),
    '#' + id.slice(0, 8),
    'احمد تفعيل',
    'https://rivo.test/order.html?order=' + order,
  ]) {
    const r = await x.req('/queue?mode=all&q=' + encodeURIComponent(q), 'GET', undefined, 'admin');
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 1);
    assert.equal(r.data.conversations[0].id, id);
  }
  assert.equal(
    (await x.req('/queue?q=' + encodeURIComponent("%' OR 1=1 --"), 'GET', undefined, 'admin')).data
      .total,
    0,
  );
  await x.action(id, 'assign', 'owner', { assignee: 'second' });
  assert.equal((await x.req('/queue?q=' + id, 'GET', undefined, 'support')).data.total, 0);
  assert.equal((await x.req('/queue?assignee=second', 'GET', undefined, 'support')).status, 403);
  assert.equal((await x.req('/queue?assignee=second', 'GET', undefined, 'admin')).data.total, 1);
  assert.equal(
    (await x.req('/queue?assignee=unassigned', 'GET', undefined, 'admin')).data.total,
    0,
  );
  for (const bad of ['priority=bad', 'mode=bad', 'q=' + 'x'.repeat(201)])
    assert.equal((await x.req('/queue?' + bad, 'GET', undefined, 'admin')).status, 400);
});
test('manager assignment is revision-guarded, rejects disabled accounts and preserves transcript/read privacy', async () => {
  const x = setup(),
    id = (await x.create()).data.id;
  assert.equal((await x.action(id, 'assign', 'support', { assignee: 'second' })).status, 403);
  assert.equal((await x.action(id, 'assign', 'owner', { assignee: 'buyer' })).status, 400);
  assert.equal((await x.req('/staff', 'GET', undefined, 'buyer')).status, 403);
  assert.equal((await x.req('/staff', 'GET', undefined, 'support')).status, 403);
  const roster = await x.req('/staff', 'GET', undefined, 'owner');
  assert.ok(roster.data.staff.some((u) => u.id === 'second'));
  assert.ok(!roster.data.staff.some((u) => u.id === 'buyer'));
  x.sql.prepare("UPDATE staff_access SET active=0 WHERE user_id='second'").run();
  assert.equal((await x.action(id, 'assign', 'owner', { assignee: 'second' })).status, 400);
  x.sql.prepare("UPDATE staff_access SET active=1 WHERE user_id='second'").run();
  await x.action(id, 'claim');
  await x.req(
    '/' + id + '/messages',
    'POST',
    { message: 'private retained', internal: true, client_id: crypto.randomUUID() },
    'support',
  );
  const state = x.sql.prepare('SELECT revision FROM chat_conversations WHERE id=?').get(id);
  assert.equal(
    (
      await x.req(
        '/' + id + '/action',
        'POST',
        { action: 'assign', assignee: 'second', revision: state.revision },
        'owner',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await x.req(
        '/' + id + '/action',
        'POST',
        { action: 'assign', assignee: 'support', revision: state.revision },
        'owner',
      )
    ).status,
    409,
  );
  assert.equal((await x.req('/' + id, 'GET', undefined, 'support')).status, 404);
  assert.ok(
    (await x.req('/' + id, 'GET', undefined, 'second')).data.messages.some(
      (m) => m.body === 'private retained',
    ),
  );
  assert.ok(!(await x.req('/' + id)).data.messages.some((m) => m.body === 'private retained'));
  await x.action(id, 'close', 'owner');
  assert.equal((await x.action(id, 'assign', 'owner', { assignee: 'support' })).status, 409);
  const log = x.sql.prepare("SELECT target FROM audit WHERE action='chat_assign'").get();
  assert.equal(JSON.parse(log.target).assignee, 'second');
});
test('priority changes require staff access, sort urgent first and never change order payment', async () => {
  const x = setup(),
    order = x.order(),
    a = (await x.create('buyer', { order_id: order })).data.id,
    b = (await x.create('other')).data.id;
  assert.equal((await x.action(a, 'priority', 'buyer', { priority: 'urgent' })).status, 403);
  assert.equal((await x.action(a, 'priority', 'support', { priority: 'urgent' })).status, 409);
  await x.action(a, 'claim');
  assert.equal((await x.action(a, 'priority', 'support', { priority: 'urgent' })).status, 200);
  assert.equal((await x.action(a, 'priority', 'second', { priority: 'normal' })).status, 409);
  assert.equal((await x.action(a, 'priority', 'owner', { priority: 'bad' })).status, 400);
  assert.equal((await x.req('/queue', 'GET', undefined, 'owner')).data.conversations[0].id, a);
  assert.equal(
    (await x.req('/queue?priority=normal', 'GET', undefined, 'owner')).data.conversations[0].id,
    b,
  );
  assert.equal((await x.req('/queue?priority=urgent', 'GET', undefined, 'owner')).data.total, 1);
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(order).payment_status,
    'unpaid',
  );
  assert.equal((await x.req('/' + a)).data.conversation.priority, undefined);
});
test('canned replies are staff-only, manager editable with revision checks, never automatically sent', async () => {
  const x = setup();
  assert.equal((await x.req('/templates')).status, 403);
  const list = await x.req('/templates', 'GET', undefined, 'support');
  assert.equal(list.data.templates.length, 3);
  assert.equal(list.data.can_manage, false);
  assert.equal(
    (await x.req('/templates', 'POST', { title: 'x', body: 'x' }, 'support')).status,
    403,
  );
  assert.equal(
    (await x.req('/templates', 'POST', { title: 'x', body: 'x'.repeat(3001) }, 'owner')).status,
    400,
  );
  const made = await x.req(
    '/templates',
    'POST',
    { title: 'رد جديد', body: '<script>plain text</script>' },
    'owner',
  );
  assert.equal(made.status, 201);
  const id = made.data.id;
  const edit = { title: 'رد معدل', body: 'نص عادي', active: false, revision: 1 };
  assert.equal((await x.req('/templates/' + id, 'PUT', edit, 'owner')).status, 200);
  assert.equal((await x.req('/templates/' + id, 'PUT', edit, 'owner')).status, 409);
  assert.ok(
    !(await x.req('/templates', 'GET', undefined, 'support')).data.templates.some(
      (t) => t.id === id,
    ),
  );
  assert.ok(
    (await x.req('/templates', 'GET', undefined, 'owner')).data.templates.some(
      (t) => t.id === id && !t.active,
    ),
  );
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM chat_messages').get().n, 0);
  assert.equal(
    (await x.req('/templates/' + id, 'PUT', { ...edit, active: true, revision: 2 }, 'admin'))
      .status,
    200,
  );
  assert.ok(
    (await x.req('/templates', 'GET', undefined, 'support')).data.templates.some(
      (t) => t.id === id,
    ),
  );
});
