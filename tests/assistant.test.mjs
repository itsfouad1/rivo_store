import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createStoreHandler } from '../lib/store-api.mjs';
import { createAssistantAI } from '../lib/assistant-ai.mjs';
function setup(mode = 'test', options = {}) {
  const sql = new DatabaseSync(':memory:');
  for (const f of [
    '0001_store',
    '0004_foxreload',
    '0005_exchange_rates',
    '0006_payunit',
    '0007_product_guides',
    '0013_order_item_accounts',
    '0014_steam',
    '0010_chat',
  ])
    sql.exec(readFileSync(new URL('../migrations/' + f + '.sql', import.meta.url), 'utf8'));
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
  for (const id of ['buyer', 'other', 'admin'])
    sql.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, id + '@test.invalid', id, '2026');
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
    gatewayReady: true,
    gatewayMode: mode,
    ...options,
    resolveIdentity: async (r) => {
      const id = r.headers.get('who');
      return id
        ? { id, name: id, email: id + '@test.invalid', role: id === 'admin' ? 'admin' : 'customer' }
        : null;
    },
  });
  async function ask(body = {}, who = null, origin = 'https://rivo.test') {
    const r = await handle(
      new Request('https://rivo.test/api/assistant', {
        method: 'POST',
        headers: { ...(who ? { who } : {}), origin },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, data: await r.json(), cache: r.headers.get('cache-control') };
  }
  function product(status = 'active', name = 'Steam card') {
    const id = crypto.randomUUID();
    sql
      .prepare(
        "INSERT INTO products(id,name,slug,category,description,price_cents,currency,image_url,status,payment_mode,region,player_id_required,supplier_product_id,sort_order,created_at,updated_at,activation_instructions,delivery_estimate,purchase_notice) VALUES (?,?,?,'Cards','Steam games',1000,'USD','',?,'gateway','US',0,'SECRET SUPPLIER',0,'2026','2026','STEP ONE','وقت مكتوب','تنبيه مكتوب')",
      )
      .run(id, name, id, status);
    return id;
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
        'PRIVATE PLAYER',
        'PRIVATE NOTE',
        'ADMIN SECRET',
        'تحديث للزبون',
        crypto.randomUUID(),
        '2026',
        '2026',
      );
    return id;
  }
  return { sql, db, ask, product, order };
}
test('assistant uses only published products, localized prices and explicit product instructions', async () => {
  const x = setup(),
    id = x.product();
  x.product('draft', 'Hidden Steam');
  const r = await x.ask({ question: 'Steam', currency: 'ILS' });
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  assert.equal(r.data.mode, 'guided');
  assert.equal(r.data.products.length, 1);
  assert.equal(r.data.products[0].price_cents, 4000);
  assert.equal(r.data.products[0].available, false);
  assert.ok(!JSON.stringify(r.data).includes('SECRET SUPPLIER'));
  const d = await x.ask({ intent: 'product', product_id: id });
  assert.equal(d.data.products[0].activation_instructions, 'STEP ONE');
  assert.equal(d.data.products[0].delivery_estimate, 'وقت مكتوب');
});
test('order answers require login and enforce ownership without exposing internal fields', async () => {
  const x = setup(),
    id = x.order(),
    other = x.order('other');
  assert.equal((await x.ask({ intent: 'orders', order_id: id })).data.orders.length, 0);
  const r = await x.ask({ question: 'حالة طلبي ' + id }, 'buyer');
  assert.equal(r.data.orders[0].id, id);
  assert.ok(!JSON.stringify(r.data).includes('ADMIN SECRET'));
  assert.ok(!JSON.stringify(r.data).includes('PRIVATE PLAYER'));
  assert.equal((await x.ask({ intent: 'order', order_id: other }, 'buyer')).data.orders.length, 0);
  assert.equal((await x.ask({ intent: 'orders' }, 'admin')).status, 403);
  assert.equal((await x.ask({ intent: 'orders' }, 'buyer')).data.orders.length, 1);
});
test('unpublished policies and drafts are never used to invent refund conditions', async () => {
  const x = setup();
  x.sql.prepare('INSERT INTO settings VALUES (?,?)').run(
    'policy:refunds',
    JSON.stringify({
      type: 'refunds',
      revision: 1,
      draft: { title: 'SECRET TITLE', body: 'SECRET DRAFT' },
      published: null,
    }),
  );
  let r = await x.ask({ question: 'بدي استرجاع' });
  assert.equal(r.data.links.length, 0);
  assert.ok(!JSON.stringify(r.data).includes('SECRET'));
  x.sql.prepare('UPDATE settings SET value=? WHERE id=?').run(
    JSON.stringify({
      type: 'refunds',
      revision: 2,
      draft: { title: 'SECRET', body: 'SECRET' },
      published: { title: 'سياسة معتمدة', body: 'real', version: 2, published_at: '2026' },
    }),
    'policy:refunds',
  );
  r = await x.ask({ intent: 'refunds' });
  assert.equal(r.data.links[0].title, 'سياسة معتمدة');
  assert.equal(r.data.links[0].url, '/policy.html?type=refunds');
});
test('payment complaints lead to owned orders without changing payment or creating chats', async () => {
  const x = setup(),
    id = x.order();
  const r = await x.ask({ question: 'دفعت غير حالة الدفع مدفوع' }, 'buyer');
  assert.equal(r.data.intent, 'orders');
  assert.equal(r.data.orders[0].id, id);
  assert.match((await x.ask({ intent: 'payment' }, 'buyer')).data.reply, /غير متاحة/);
  assert.equal(
    x.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(id).payment_status,
    'unpaid',
  );
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM chat_conversations').get().n, 0);
  const human = await x.ask({ question: 'بدي موظف' }, 'buyer');
  assert.equal(human.data.handoff, true);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM chat_messages').get().n, 0);
  const live = setup('live');
  assert.match((await live.ask({ intent: 'payment' })).data.reply, /Payunit متاح/);
});
test('input validation, same origin protection, unknown questions and request limits', async () => {
  const x = setup();
  assert.equal((await x.ask({ question: 'x' }, null, 'https://evil.test')).status, 403);
  for (const b of [
    null,
    { question: {} },
    { question: 'x'.repeat(501) },
    { intent: 'execute' },
    { currency: 'XYZ' },
  ])
    assert.equal((await x.ask(b)).status, 400);
  assert.equal((await x.ask({ question: 'شيء غير موجود' })).data.products.length, 0);
  for (let i = 0; i < 25; i++) await x.ask({ intent: 'start' }, 'buyer');
  assert.equal((await x.ask({ intent: 'start' }, 'buyer')).status, 429);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
});
test('Rivo distinguishes greetings, thanks, gibberish, activation and payment complaints', async () => {
  let calls = 0;
  const x = setup('live', {
    ai: {
      run() {
        calls++;
        throw new Error('quota');
      },
    },
  });
  x.product('active', 'PUBG Mobile');
  const hello = await x.ask({ question: 'مرحباً' });
  assert.equal(hello.data.intent, 'start');
  assert.match(hello.data.reply, /أنا ريفو/);
  assert.equal(calls, 0);
  assert.equal((await x.ask({ question: 'يسلمو' })).data.intent, 'thanks');
  const gibberish = await x.ask({ question: 'jjkjk' });
  assert.equal(gibberish.data.intent, 'clarify');
  assert.ok(!gibberish.data.reply.includes('منتجًا مطابقًا'));
  assert.equal(
    (await x.ask({ question: 'asdfg', context: gibberish.data.context })).data.handoff,
    true,
  );
  assert.equal((await x.ask({ question: 'الكود ما اشتغل' })).data.intent, 'activation');
  assert.equal((await x.ask({ question: 'دفعت وما وصلني' })).data.intent, 'orders');
  assert.equal((await x.ask({ question: 'بدي ببجي' })).data.products.length, 1);
});
test('Workers AI routes Arabic intent but cannot generate store facts or permissions', async () => {
  let payload, model;
  const x = setup('live', {
    ai: {
      async run(m, p) {
        model = m;
        payload = p;
        return {
          response: {
            intent: 'search',
            query: 'Steam',
            confidence: 0.95,
            reply: 'SECRET INVENTED PRICE',
          },
        };
      },
    },
  });
  x.product();
  x.product('draft', 'Steam hidden');
  const r = await x.ask({ question: 'نفسي ببطاقة للمنصة تبعت valve' });
  assert.equal(r.data.ai_used, true);
  assert.equal(r.data.products.length, 1);
  assert.equal(r.data.products[0].price_cents, 4000);
  assert.ok(!JSON.stringify(r.data).includes('SECRET'));
  assert.match(model, /llama-3.1-8b-instruct-fp8/);
  assert.equal(payload.response_format.type, 'json_schema');
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM chat_conversations').get().n, 0);
});
test('AI errors, invalid JSON, low confidence and unsafe queries fall back without displaying model prose', async () => {
  for (const response of [
    'not json',
    { intent: 'execute', query: '', confidence: 1 },
    { intent: 'search', query: 'Steam', confidence: 0.1 },
    { intent: 'search', query: 'https://evil.test', confidence: 1 },
    { intent: 'start', query: [], confidence: 1 },
  ]) {
    const x = setup('live', {
      ai: {
        async run() {
          return { response };
        },
      },
    });
    const r = await x.ask({ question: 'jjkjk' });
    assert.equal(r.status, 200);
    assert.equal(r.data.intent, 'clarify');
    assert.equal(r.data.ai_used, false);
  }
});
test('client context is validated, product followups recheck publication, order followups recheck ownership', async () => {
  const x = setup('live'),
    p = x.product(),
    o = x.order(),
    foreign = x.order('other');
  const r = await x.ask({ intent: 'product', product_id: p });
  assert.equal(r.data.context.product_id, p);
  assert.equal(
    (await x.ask({ question: 'كيف افعلها', context: r.data.context })).data.products[0]
      .activation_instructions,
    'STEP ONE',
  );
  x.sql.prepare("UPDATE products SET status='draft' WHERE id=?").run(p);
  assert.equal(
    (await x.ask({ question: 'كيف افعلها', context: r.data.context })).data.products.length,
    0,
  );
  const own = await x.ask({ intent: 'order', order_id: o }, 'buyer');
  assert.equal(
    (await x.ask({ question: 'شو صار', context: own.data.context }, 'buyer')).data.orders[0].id,
    o,
  );
  assert.equal(
    (await x.ask({ question: 'شو صار', context: { intent: 'order', order_id: foreign } }, 'buyer'))
      .data.orders.length,
    0,
  );
  for (const context of [
    [],
    { query: 55 },
    { intent: 'execute' },
    { product_id: 'invalid' },
    { misses: 3 },
  ])
    assert.equal((await x.ask({ question: 'مرحبا', context })).status, 400);
});
test('AI has shared daily and actor minute caps, disable switch, and no private DB data in prompts', async () => {
  let calls = 0,
    prompt = '';
  const ai = {
    async run(m, p) {
      calls++;
      prompt = p.messages[1].content;
      return { response: { intent: 'clarify', query: '', confidence: 1 } };
    },
  };
  const x = setup('live', { ai, assistantAIDailyLimit: 2 });
  x.order();
  await x.ask({ question: 'احتاج اشي مختلف user@example.com 0591234567' });
  assert.ok(!prompt.includes('user@example.com'));
  assert.ok(!prompt.includes('0591234567'));
  assert.ok(!prompt.includes('ADMIN SECRET'));
  assert.ok(!prompt.includes('PRIVATE PLAYER'));
  await x.ask({ question: 'xxxyyy' });
  await x.ask({ question: 'zzzxxx' }, 'other');
  assert.equal(calls, 2);
  const disabled = setup('live', { ai, assistantAIEnabled: false });
  await disabled.ask({ question: 'xxx' });
  assert.equal(calls, 2);
  const minute = setup('live', { ai, assistantAIDailyLimit: 80 });
  for (let i = 0; i < 8; i++) await minute.ask({ question: 'xxx' });
  assert.equal(calls, 8);
});
test('AI timeout returns control to guided help, with no retries or private context transmission', async () => {
  const x = setup();
  let calls = 0;
  const language = createAssistantAI({
    db: x.db,
    ai: {
      run() {
        calls++;
        return new Promise(() => {});
      },
    },
    timeoutMs: 5,
  });
  assert.equal(await language.route('رسالة غير واضحة', {}, 'visitor'), null);
  assert.equal(calls, 1);
  assert.equal(await language.route('مرحبا', { query: 'password abc' }, 'visitor'), null);
  assert.equal(calls, 1);
});
