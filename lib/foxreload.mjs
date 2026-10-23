import { ensureRates, rateMap, convertCents } from './exchange.mjs';
// FoxReload adapter. Keys never leave the Worker; money uses integer ten-thousandths.
const BASE = 'https://public-api.foxreload.com';
const stamp = () => new Date().toISOString();
const response = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
export class FoxError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const check = (ok, message, status = 400) => {
  if (!ok) throw new FoxError(status, message);
};
export function units(value) {
  const s = String(value);
  check(/^\d+(\.\d{1,4})?$/.test(s), 'سعر المورد غير صالح');
  const [a, b = ''] = s.split('.');
  const v = Number(a) * 10000 + Number(b.padEnd(4, '0'));
  check(Number.isSafeInteger(v) && v >= 0 && v <= 1e12, 'سعر المورد خارج الحد');
  return v;
}
const decimal = (n) => `${Math.floor(n / 10000)}.${String(n % 10000).padStart(4, '0')}`;
export const sellingPrice = (cost, bps) =>
  Number((BigInt(cost) * BigInt(10000 + bps) + 999999n) / 1000000n);
async function body(req) {
  const s = await req.text();
  check(s.length <= 50000, 'حجم الطلب كبير', 413);
  try {
    return JSON.parse(s);
  } catch {
    throw new FoxError(400, 'بيانات JSON غير صالحة');
  }
}
export async function verifyWebhook(secret, raw, header, now = Date.now()) {
  if (!secret || !header) return false;
  const m = /^t=(\d+),v1=([a-fA-F0-9]{64})$/.exec(header);
  if (!m || Math.abs(now / 1000 - Number(m[1])) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(m[2].match(/../g), (x) => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(m[1] + '.' + raw));
}
export function createFoxreload(env, resolveIdentity = async () => null, fetcher = fetch) {
  const db = env.DB;
  let nextCallAt = 0;
  const first = (sql, ...p) =>
    db
      .prepare(sql)
      .bind(...p)
      .first();
  const all = async (sql, ...p) =>
    (
      await db
        .prepare(sql)
        .bind(...p)
        .all()
    ).results;
  const run = (sql, ...p) =>
    db
      .prepare(sql)
      .bind(...p)
      .run();
  async function call(path, { method = 'GET', body: payload } = {}) {
    check(env.FOXRELOAD_API_KEY, 'أضف FOXRELOAD_API_KEY إلى أسرار Cloudflare أولًا', 503);
    const wait = Math.max(0, nextCallAt - Date.now());
    nextCallAt = Math.max(nextCallAt, Date.now()) + 250;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    let r;
    try {
      r = await fetcher(BASE + path, {
        method,
        headers: {
          'X-API-Key': env.FOXRELOAD_API_KEY,
          'X-Language': 'en',
          'X-Currency': 'usd',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new FoxError(503, 'تعذّر الاتصال بالمورد؛ حدّث حالة العملية قبل إعادة المحاولة');
    }
    check(r.status < 300 || r.status >= 400, 'المورد أعاد توجيه الاتصال؛ تم إيقاف الطلب', 502);
    if (r.status === 429) {
      const e = new FoxError(
        429,
        'بلغ المورد حد الطلبات؛ انتظر ' + (r.headers.get('retry-after') || '60') + ' ثانية',
      );
      e.rateLimited = true;
      throw e;
    }
    if (!r.ok)
      throw new FoxError(
        r.status === 401 || r.status === 403 ? 503 : 409,
        'رفض المورد العملية (HTTP ' + r.status + '). تحقّق من المفتاح والرصيد وبيانات المنتج.',
      );
    try {
      return await r.json();
    } catch {
      throw new FoxError(502, 'رد المورد غير صالح');
    }
  }
  function product(p) {
    check(
      p && typeof p.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.id),
      'معرّف المنتج غير صالح',
    );
    check(p.currency === 'usd' && p.price !== null, 'سعر الدولار غير متاح للمنتج');
    check(
      ['code', 'direct_topup'].includes(p.deliveryType),
      'هذه النسخة تدعم الأكواد والشحن المباشر فقط',
    );
    check(Number.isSafeInteger(p.quantity) && p.quantity >= 0, 'مخزون المورد غير صالح');
    const min = p.orderMinQuantity ?? 1,
      max = p.orderMaxQuantity ?? null;
    check(
      Number.isSafeInteger(min) &&
        min >= 1 &&
        (max === null || (Number.isSafeInteger(max) && max >= min)),
      'حدود الكمية غير صالحة',
    );
    return {
      id: p.id,
      name: String(p.name || p.id),
      description: String(p.description || ''),
      cost_units: units(p.price),
      stock: p.quantity,
      min_qty: min,
      max_qty: max,
      delivery_type: p.deliveryType,
      note_schema: JSON.stringify({
        required: p.requiredNoteFields || [],
        options: p.noteFieldOptions || {},
        types: p.noteFieldTypes || {},
      }),
    };
  }
  async function getProduct(id) {
    check(typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id), 'معرّف المورد غير صالح');
    return product(await call('/api/products/' + encodeURIComponent(id)));
  }
  async function syncOne(link) {
    let p;
    try {
      p = await getProduct(link.remote_id);
    } catch (e) {
      // Fail closed for checkout when a product cannot be refreshed.
      await run(
        'UPDATE fox_products SET stock=0,checked_at=? WHERE product_id=?',
        stamp(),
        link.product_id,
      );
      throw e;
    }
    const statements = [
      db
        .prepare(
          'UPDATE fox_products SET cost_units=?,stock=?,min_qty=?,max_qty=?,delivery_type=?,note_schema=?,checked_at=? WHERE product_id=?',
        )
        .bind(
          p.cost_units,
          p.stock,
          p.min_qty,
          p.max_qty,
          p.delivery_type,
          p.note_schema,
          stamp(),
          link.product_id,
        ),
    ];
    const usdPrice = sellingPrice(p.cost_units, link.markup_bps);
    check(!link.auto_price || usdPrice <= 100000000, 'سعر البيع خارج الحد');
    if (link.auto_price) {
      await ensureRates(db);
      const local = await first('SELECT currency FROM products WHERE id=?', link.product_id),
        rates = await rateMap(db);
      const localPrice = convertCents(usdPrice, 'USD', local.currency, rates);
      statements.push(
        db
          .prepare('UPDATE products SET price_cents=?,updated_at=? WHERE id=?')
          .bind(localPrice, stamp(), link.product_id),
      );
    }
    await db.batch(statements);
    return p;
  }
  async function applyResult(job, remote) {
    check(
      remote.id === job.remote_id && Boolean(remote.isMock) === Boolean(job.is_mock),
      'هوية رد المورد غير مطابقة',
      502,
    );
    check(remote.currency === 'usd', 'عملة الطلب غير مطابقة', 502);
    const expected = JSON.parse(job.request_json).items[0];
    check(
      Array.isArray(remote.items) &&
        remote.items.length > 0 &&
        remote.items.every((i) => i.product?.id === expected.itemId) &&
        remote.items.reduce((n, i) => n + i.quantity, 0) === expected.quantity,
      'عناصر رد المورد غير مطابقة',
      502,
    );
    const status = remote.status;
    const latest = await first('SELECT status FROM fox_jobs WHERE id=?', job.id);
    if (
      latest?.status === 'refunded' ||
      (latest?.status === 'completed' && !['completed', 'refunded'].includes(status))
    )
      return { status: latest.status };
    check(
      [
        'active',
        'cancelled',
        'paid',
        'processing',
        'action_required',
        'failed',
        'completed',
        'refunded',
      ].includes(status),
      'حالة المورد غير معروفة',
      502,
    );
    const codes =
      status === 'completed'
        ? remote.items.flatMap((i) => (Array.isArray(i.externalData) ? i.externalData : []))
        : [];
    check(
      codes.every((x) => typeof x === 'string') && JSON.stringify(codes).length <= 100000,
      'بيانات التسليم غير صالحة',
      502,
    );
    const error = ['failed', 'refunded', 'cancelled', 'action_required'].includes(status)
      ? 'تحتاج العملية مراجعة لدى المورد. أي استرداد عند المورد لا يعيد المال للزبون تلقائيًا.'
      : '';
    await run(
      'UPDATE fox_jobs SET status=?,result_json=?,error=?,updated_at=? WHERE id=?',
      status,
      JSON.stringify(codes),
      error,
      stamp(),
      job.id,
    );
    if (!job.is_mock) {
      const item = await first('SELECT order_id FROM order_items WHERE id=?', job.item_id);
      const rows = await all(
        'SELECT i.id,j.status FROM order_items i LEFT JOIN fox_jobs j ON j.item_id=i.id AND j.is_mock=0 WHERE i.order_id=?',
        item.order_id,
      );
      if (rows.length && rows.every((x) => x.status === 'completed'))
        await run(
          "UPDATE orders SET status='completed',customer_update='تم تنفيذ الطلب. تفاصيل التسليم متاحة أدناه.',updated_at=? WHERE id=? AND payment_status='paid' AND status<>'cancelled'",
          stamp(),
          item.order_id,
        );
    }
    return { status, codes, error };
  }
  async function refreshJob(job) {
    if (!job.remote_id) return job;
    await applyResult(job, await call('/api/orders/' + encodeURIComponent(job.remote_id)));
    return first('SELECT * FROM fox_jobs WHERE id=?', job.id);
  }
  async function execute(job) {
    const time = Date.now();
    const claimUntil = time + 120000;
    const claimed = await db
      .prepare('UPDATE fox_jobs SET lock_until=? WHERE id=? AND lock_until<? RETURNING id')
      .bind(claimUntil, job.id, time)
      .first();
    check(claimed, 'العملية قيد التنفيذ؛ انتظر ثم حدّث حالتها', 409);
    try {
      job = await first('SELECT * FROM fox_jobs WHERE id=?', job.id);
      if (!job.remote_id) {
        // Lookup before retrying: an earlier POST may have succeeded despite a timeout.
        const lookup = await call('/api/orders/?idempotencyKey=' + encodeURIComponent(job.id));
        check(Array.isArray(lookup.items), 'رد البحث عن الطلب غير صالح', 502);
        let remote = lookup.items.find((x) => x.idempotencyKey === job.id);
        if (!remote)
          remote = await call('/api/orders/', {
            method: 'POST',
            body: JSON.parse(job.request_json),
          });
        check(
          typeof remote.id === 'string' &&
            remote.idempotencyKey === job.id &&
            Boolean(remote.isMock) === Boolean(job.is_mock),
          'رد إنشاء الطلب غير مطابق',
          502,
        );
        await run(
          'UPDATE fox_jobs SET remote_id=?,status=?,updated_at=? WHERE id=?',
          remote.id,
          remote.status,
          stamp(),
          job.id,
        );
        job.remote_id = remote.id;
      }
      job = await refreshJob(job);
      if (job.status !== 'active' || job.pay_started) return job;
      const remote = await call('/api/orders/' + encodeURIComponent(job.remote_id));
      const expected = JSON.parse(job.request_json).items[0];
      check(
        units(remote.price) === units(expected.totalPrice),
        'تغيرت تكلفة الطلب؛ لم يتم خصم الرصيد',
        409,
      );
      // Set before network I/O. An ambiguous /pay is NEVER automatically replayed.
      await run('UPDATE fox_jobs SET pay_started=1,updated_at=? WHERE id=?', stamp(), job.id);
      try {
        await call('/api/orders/' + encodeURIComponent(job.remote_id) + '/pay', {
          method: 'POST',
          body: {},
        });
      } catch (e) {
        if (e.rateLimited) await run('UPDATE fox_jobs SET pay_started=0 WHERE id=?', job.id);
        throw e;
      }
      return await refreshJob(await first('SELECT * FROM fox_jobs WHERE id=?', job.id));
    } catch (e) {
      await run(
        'UPDATE fox_jobs SET error=?,updated_at=? WHERE id=?',
        e instanceof FoxError ? e.message : 'تعذّر تنفيذ العملية',
        stamp(),
        job.id,
      );
      throw e;
    } finally {
      await run('UPDATE fox_jobs SET lock_until=0 WHERE id=? AND lock_until=?', job.id, claimUntil);
    }
  }
  function validateNote(note, schema) {
    check(note && typeof note === 'object' && !Array.isArray(note), 'بيانات الشحن غير صالحة');
    const allowed = new Set([
      ...schema.required,
      ...Object.keys(schema.types),
      ...Object.keys(schema.options),
    ]);
    check(Object.keys(note).length <= 10, 'حقول شحن كثيرة');
    for (const k of schema.required)
      check(
        note[k] !== undefined && note[k] !== null && String(note[k]).trim() !== '',
        'حقل الشحن مطلوب: ' + k,
      );
    for (const [k, v] of Object.entries(note)) {
      check(allowed.has(k), 'حقل شحن غير معروف: ' + k);
      check(
        ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 500,
        'قيمة حقل الشحن غير صالحة',
      );
      const type = schema.types[k];
      if (type === 'integer') check(Number.isSafeInteger(v), 'الحقل ' + k + ' يحتاج عددًا صحيحًا');
      if (type === 'number')
        check(typeof v === 'number' && Number.isFinite(v), 'الحقل ' + k + ' يحتاج رقمًا');
      if (type === 'email')
        check(typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'الإيميل غير صالح');
      const options = schema.options[k];
      if (options?.length)
        check(
          options.some((o) => String(o.value) === String(v)),
          'اختر قيمة مسموحة للحقل ' + k,
        );
    }
    return note;
  }
  async function handle(req) {
    const url = new URL(req.url),
      path = url.pathname;
    if (
      path !== '/api/webhooks/foxreload' &&
      !path.startsWith('/api/admin/foxreload') &&
      !/^\/api\/orders\/[^/]+\/delivery$/.test(path)
    )
      return null;
    try {
      if (path === '/api/webhooks/foxreload') {
        check(req.method === 'POST', 'طريقة غير مسموحة', 405);
        const raw = await req.text();
        check(raw.length <= 300000, 'حجم الإشعار كبير', 413);
        check(
          await verifyWebhook(
            env.FOXRELOAD_WEBHOOK_SECRET,
            raw,
            req.headers.get('X-Webhook-Signature'),
          ),
          'توقيع غير صالح',
          401,
        );
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          throw new FoxError(400, 'إشعار غير صالح');
        }
        check(typeof event.id === 'string' && event.id.length <= 200, 'معرّف الإشعار غير صالح');
        if (await first('SELECT id FROM fox_events WHERE id=?', event.id))
          return response({ ok: true });
        if (event.type !== 'order.completed') return response({ ok: true });
        const job = await first('SELECT * FROM fox_jobs WHERE remote_id=?', event.data?.id || '');
        check(job, 'لم تتم مطابقة الطلب بعد؛ أعد إرسال الإشعار', 503);
        check(event.data.status === 'completed', 'حالة الإشعار غير مطابقة');
        await applyResult(job, event.data);
        await run(
          'INSERT OR IGNORE INTO fox_events(id,created_at) VALUES (?,?)',
          event.id,
          stamp(),
        );
        return response({ ok: true });
      }
      const user = await resolveIdentity(req);
      check(user, 'سجّل الدخول أولًا', 401);
      if (path.startsWith('/api/admin/'))
        check(user.role === 'admin', 'هذه العملية للإدارة فقط', 403);
      if (req.method !== 'GET')
        check(req.headers.get('origin') === url.origin, 'مصدر الطلب غير مسموح', 403);
      const delivery = path.match(/^\/api\/orders\/([^/]+)\/delivery$/);
      if (delivery) {
        check(req.method === 'GET', 'طريقة غير مسموحة', 405);
        const order = await first(
          'SELECT * FROM orders WHERE id=? AND user_id=?',
          delivery[1],
          user.id,
        );
        check(order, 'الطلب غير موجود', 404);
        if (order.payment_status !== 'paid' || order.status === 'cancelled')
          return response({ items: [] });
        const rows = await all(
          'SELECT i.name,j.status,j.result_json FROM fox_jobs j JOIN order_items i ON i.id=j.item_id WHERE i.order_id=? AND j.is_mock=0',
          order.id,
        );
        return response({
          items: rows.map((x) => ({
            name: x.name,
            status: x.status,
            codes: x.status === 'completed' ? JSON.parse(x.result_json) : [],
          })),
        });
      }
      const suffix = path.slice('/api/admin/foxreload'.length);
      if (suffix === '/status' && req.method === 'GET')
        return response({
          configured: !!env.FOXRELOAD_API_KEY,
          liveEnabled: env.FOXRELOAD_LIVE_ENABLED === 'true',
          webhookConfigured: !!env.FOXRELOAD_WEBHOOK_SECRET,
          links: await all(
            'SELECT f.*,p.name FROM fox_products f JOIN products p ON p.id=f.product_id',
          ),
          webhookUrl: url.origin + '/api/webhooks/foxreload',
        });
      if (suffix === '/balance' && req.method === 'GET')
        return response({ balances: await call('/api/access/me/balances/') });
      if (suffix === '/catalog' && req.method === 'GET') {
        const q = new URLSearchParams({ includeDescendants: 'true', limit: '50' });
        const cursor = url.searchParams.get('cursor'),
          category = url.searchParams.get('categoryId');
        if (cursor) {
          check(cursor.length <= 3000, 'مؤشر الصفحة طويل');
          q.set('cursor', cursor);
        }
        if (category) {
          check(category.length <= 256, 'معرّف التصنيف طويل');
          q.set('categoryId', category);
        }
        const r = await call('/api/products/?' + q);
        check(Array.isArray(r.items), 'كتالوج غير صالح', 502);
        return response({ items: r.items, nextCursor: r.nextCursor || null });
      }
      if (suffix === '/import' && req.method === 'POST') {
        const b = await body(req),
          p = await getProduct(b.remote_id),
          bps = b.markup_bps ?? 1000;
        check(Number.isSafeInteger(bps) && bps >= 0 && bps <= 100000, 'نسبة الربح غير صالحة');
        check(p.min_qty <= 99, 'هذا المنتج يحتاج كمية أكبر من الحد الحالي للسلة (99)');
        check(
          !(await first('SELECT product_id FROM fox_products WHERE remote_id=?', p.id)),
          'هذا المنتج مستورد بالفعل',
          409,
        );
        const id = crypto.randomUUID(),
          t = stamp(),
          price = sellingPrice(p.cost_units, bps);
        check(price <= 100000000, 'سعر البيع خارج الحد');
        await db.batch([
          db
            .prepare(
              "INSERT OR IGNORE INTO suppliers(id,name,base_url,secret_name,notes,created_at) VALUES ('foxreload','FoxReload',?,'FOXRELOAD_API_KEY','ربط API',?)",
            )
            .bind(BASE, t),
          db
            .prepare(
              "INSERT INTO products(id,name,slug,category,description,price_cents,currency,image_url,status,payment_mode,region,player_id_required,supplier_id,supplier_product_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,'USD','','draft','whatsapp','',?,'foxreload',?,0,?,?)",
            )
            .bind(
              id,
              p.name.slice(0, 120),
              'fox-' + id,
              'FoxReload',
              p.description.slice(0, 3000),
              price,
              p.delivery_type === 'direct_topup' ? 1 : 0,
              p.id,
              t,
              t,
            ),
          db
            .prepare(
              'INSERT INTO fox_products(product_id,remote_id,cost_units,stock,min_qty,max_qty,delivery_type,note_schema,markup_bps,auto_price,checked_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)',
            )
            .bind(
              id,
              p.id,
              p.cost_units,
              p.stock,
              p.min_qty,
              p.max_qty,
              p.delivery_type,
              p.note_schema,
              bps,
              t,
            ),
        ]);
        return response({ product_id: id }, 201);
      }
      const linkMatch = suffix.match(/^\/products\/([^/]+)$/);
      if (linkMatch && req.method === 'PUT') {
        const b = await body(req);
        check(
          Number.isSafeInteger(b.markup_bps) && b.markup_bps >= 0 && b.markup_bps <= 100000,
          'نسبة الربح غير صالحة',
        );
        const link = await first('SELECT * FROM fox_products WHERE product_id=?', linkMatch[1]);
        check(link, 'رابط المنتج غير موجود', 404);
        check(typeof b.auto_price === 'boolean', 'خيار التسعير غير صالح');
        await run(
          'UPDATE fox_products SET markup_bps=?,auto_price=? WHERE product_id=?',
          b.markup_bps,
          b.auto_price ? 1 : 0,
          link.product_id,
        );
        await syncOne({ ...link, markup_bps: b.markup_bps, auto_price: b.auto_price });
        return response({ ok: true });
      }
      if (suffix === '/sync' && req.method === 'POST') {
        const b = await body(req),
          link = await first(
            'SELECT * FROM fox_products WHERE product_id=?',
            String(b.product_id || ''),
          );
        check(link, 'المنتج غير موجود', 404);
        await syncOne(link);
        return response({ ok: true });
      }
      const om = suffix.match(/^\/orders\/([^/]+)$/);
      if (om && req.method === 'GET') {
        check(await first('SELECT id FROM orders WHERE id=?', om[1]), 'الطلب غير موجود', 404);
        const items = await all(
          'SELECT i.id,i.name,i.quantity,f.* FROM order_items i JOIN fox_order_lines f ON f.item_id=i.id WHERE i.order_id=?',
          om[1],
        );
        const jobs = await all(
          'SELECT j.id,j.item_id,j.is_mock,j.remote_id,j.status,j.result_json,j.error,j.pay_started FROM fox_jobs j JOIN order_items i ON i.id=j.item_id WHERE i.order_id=?',
          om[1],
        );
        return response({ items, jobs, liveEnabled: env.FOXRELOAD_LIVE_ENABLED === 'true' });
      }
      if (suffix === '/execute' && req.method === 'POST') {
        const b = await body(req);
        check(typeof b.mock === 'boolean', 'حدد الوضع التجريبي أو الحقيقي');
        const item = await first(
          'SELECT i.*,f.remote_id,f.cost_units,f.delivery_type,f.note_schema,f.sale_usd_cents,o.payment_status,o.status AS order_status,o.currency FROM order_items i JOIN fox_order_lines f ON f.item_id=i.id JOIN orders o ON o.id=i.order_id WHERE i.id=?',
          String(b.item_id || ''),
        );
        check(item, 'منتج الطلب غير مربوط بـFoxReload', 404);
        if (!b.mock) {
          check(env.FOXRELOAD_LIVE_ENABLED === 'true', 'التنفيذ الحقيقي غير مفعّل', 409);
          check(b.confirm === true, 'يجب تأكيد الخصم من رصيد المورد');
          check(
            item.payment_status === 'paid' &&
              !['cancelled', 'completed'].includes(item.order_status),
            'أكد استلام الدفع أولًا وتحقق أن الطلب لم يُلغَ أو يكتمل',
            409,
          );
        }
        const id = 'rivo-' + (b.mock ? 'mock-' : 'live-') + item.id;
        let job = await first('SELECT * FROM fox_jobs WHERE id=?', id);
        if (!job) {
          const p = await getProduct(item.remote_id);
          check(p.delivery_type === item.delivery_type, 'تغير نوع تسليم المنتج', 409);
          check(
            p.stock >= item.quantity &&
              item.quantity >= p.min_qty &&
              (p.max_qty === null || item.quantity <= p.max_qty),
            'الكمية المطلوبة غير متاحة أو لا تطابق حدود المورد',
            409,
          );
          check(
            p.cost_units <= item.cost_units,
            'ارتفعت تكلفة المورد منذ إنشاء الطلب؛ راجع الطلب يدويًا',
            409,
          );
          if (!b.mock)
            check(
              item.sale_usd_cents > 0 && p.cost_units <= item.sale_usd_cents * 100,
              'تحقق من سعر البيع وهامش الربح قبل التنفيذ',
              409,
            );
          const note = validateNote(b.note || {}, JSON.parse(p.note_schema));
          const payload = {
            items: [
              {
                itemId: item.remote_id,
                quantity: item.quantity,
                totalPrice: decimal(p.cost_units * item.quantity),
                note,
              },
            ],
            idempotencyKey: id,
            isMock: b.mock,
          };
          await run(
            "INSERT OR IGNORE INTO fox_jobs(id,item_id,is_mock,status,request_json,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?)",
            id,
            item.id,
            b.mock ? 1 : 0,
            JSON.stringify(payload),
            stamp(),
            stamp(),
          );
          job = await first('SELECT * FROM fox_jobs WHERE id=?', id);
        }
        await run(
          'INSERT INTO audit(id,actor,action,target,created_at) VALUES (?,?,?,?,?)',
          crypto.randomUUID(),
          user.id,
          b.mock ? 'fox_mock_requested' : 'fox_live_requested',
          id,
          stamp(),
        );
        const result = await execute(job);
        return response({
          id: result.id,
          status: result.status,
          isMock: !!result.is_mock,
          error: result.error,
        });
      }
      if (suffix === '/refresh' && req.method === 'POST') {
        const b = await body(req),
          job = await first('SELECT * FROM fox_jobs WHERE id=?', String(b.job_id || ''));
        check(job, 'العملية غير موجودة', 404);
        check(job.remote_id, 'لم يصل معرّف المورد بعد؛ استخدم زر التنفيذ لاستعادة نفس الطلب', 409);
        const r = await refreshJob(job);
        return response({ status: r.status });
      }
      throw new FoxError(404, 'المسار غير موجود');
    } catch (e) {
      return response(
        { error: e instanceof FoxError ? e.message : 'تعذّر تنفيذ عملية المورد' },
        e instanceof FoxError ? e.status : 500,
      );
    }
  }
  async function scheduled() {
    if (!env.FOXRELOAD_API_KEY) return;
    // Bounded batches: oldest checked products first, without walking the entire supplier catalog.
    const links = await all('SELECT * FROM fox_products ORDER BY checked_at LIMIT 10');
    for (const l of links) {
      try {
        await syncOne(l);
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const jobs = await all(
      "SELECT * FROM fox_jobs WHERE remote_id IS NOT NULL AND status NOT IN ('completed','failed','refunded','cancelled') ORDER BY updated_at LIMIT 10",
    );
    for (const j of jobs) {
      try {
        await refreshJob(j);
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    await run(
      'DELETE FROM fox_events WHERE created_at<?',
      new Date(Date.now() - 30 * 86400000).toISOString(),
    );
  }
  return { handle, scheduled };
}
