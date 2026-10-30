import { isManager } from './staff.mjs';
const BASE = 'https://payunit.co/api/v1';
const now = () => new Date().toISOString();
const reply = (data, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
class PaymentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const check = (v, m, s = 400) => {
  if (!v) throw new PaymentError(s, m);
};
export const payunitMode = (env) => (env.PAYUNIT_MODE === 'live' ? 'live' : 'test');
export const payunitReady = (env) =>
  (env.PAYUNIT_API_KEY || '').startsWith('pay_' + payunitMode(env) + '_') &&
  (env.PAYUNIT_API_KEY || '').length > 16 &&
  (env.PAYUNIT_WEBHOOK_SECRET || '').length >= 12;
export function payunitCents(value) {
  const s = String(value);
  check(/^\d{1,9}(\.\d{1,2})?$/.test(s), 'مبلغ غير صالح', 502);
  const [a, b = ''] = s.split('.'),
    n = Number(a) * 100 + Number(b.padEnd(2, '0'));
  check(n <= 100000000, 'المبلغ خارج الحد', 502);
  return n;
}
export async function verifyPayunitWebhook(secret, raw, timestamp, signature, time = Date.now()) {
  if (
    !secret ||
    !/^\d{10}$/.test(timestamp || '') ||
    !/^v1=[a-f0-9]{64}$/i.test(signature || '') ||
    Math.abs(time / 1000 - Number(timestamp)) > 300
  )
    return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(signature.slice(3).match(/../g), (x) => parseInt(x, 16)),
    new TextEncoder().encode(timestamp + '.' + raw),
  );
}
export function createPayunit(env, identity = async () => null, fetcher = fetch) {
  const db = env.DB,
    mode = payunitMode(env),
    first = (q, ...p) =>
      db
        .prepare(q)
        .bind(...p)
        .first(),
    run = (q, ...p) =>
      db
        .prepare(q)
        .bind(...p)
        .run();
  async function call(path, body, key) {
    check(payunitReady(env), 'مفاتيح Payunit لا تطابق وضع الدفع المحدد', 503);
    let r;
    try {
      r = await fetcher(BASE + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + env.PAYUNIT_API_KEY,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new PaymentError(503, 'تعذّر الاتصال؛ أعد المحاولة على نفس الطلب');
    }
    check(
      r.ok,
      'تعذّر الاتصال بـPayunit (HTTP ' + r.status + ')',
      r.status >= 500 || r.status === 429 ? 503 : 409,
    );
    const data = await r.json();
    check(data && typeof data === 'object' && !Array.isArray(data), 'رد غير صالح', 502);
    return data;
  }
  function validate(r, s, creation = false) {
    check(payunitCents(r.amount) === s.amount_usd_cents, 'مبلغ الفاتورة غير مطابق', 409);
    if (creation || r.currency !== undefined)
      check(r.currency === 'USD', 'عملة الفاتورة غير مطابقة', 409);
    if (creation || r.environment !== undefined)
      check(r.environment === s.environment, 'بيئة الفاتورة غير مطابقة', 409);
    if (r.external_ref !== undefined)
      check(r.external_ref === s.order_id, 'مرجع الفاتورة غير مطابق', 409);
    if (s.invoice_id && r.id !== undefined)
      check(r.id === s.invoice_id, 'معرّف الفاتورة غير مطابق', 409);
  }
  function summary(s, o) {
    return {
      order_id: o.id,
      status: s.status,
      environment: s.environment,
      amount_usd_cents: s.amount_usd_cents,
      currency: 'USD',
      payment_status: o.payment_status,
      order_status: o.status,
      checkout_url:
        o.payment_status === 'unpaid' &&
        o.status === 'awaiting_payment' &&
        ['creating', 'pending', 'processing'].includes(s.status)
          ? s.checkout_url
          : '',
    };
  }
  async function reconcile(s, eventKey = null, eventType = 'reconcile') {
    check(s.invoice_id && s.environment === mode, 'الفاتورة لا تطابق بيئة الدفع الحالية', 409);
    const r = await call('/invoices/' + encodeURIComponent(s.invoice_id));
    validate(r, s);
    check(
      [
        'pending',
        'processing',
        'paid',
        'expired',
        'cancelled',
        'refunded',
        'partially_refunded',
      ].includes(r.status),
      'حالة فاتورة غير معروفة',
      502,
    );
    const t = now(),
      ss = [];
    ss.push(
      db
        .prepare(
          "UPDATE payunit_invoices SET status=?,updated_at=?,last_error='' WHERE order_id=? AND (status NOT IN ('paid','refunded','partially_refunded') OR (status='paid' AND ? IN ('paid','refunded','partially_refunded')) OR (status='partially_refunded' AND ? IN ('partially_refunded','refunded')) OR (status='refunded' AND ?='refunded'))",
        )
        .bind(r.status, t, s.order_id, r.status, r.status, r.status),
    );
    if (['paid', 'refunded', 'partially_refunded'].includes(r.status)) {
      const test = s.environment === 'test',
        payment = test ? 'test_' + r.status : r.status;
      const message = test
        ? 'نتيجة دفع تجريبية — لم يتم تحصيل أموال أو شراء منتج من المورد.'
        : r.status === 'paid'
          ? 'تم تأكيد الدفع بالدولار، وطلبك بانتظار التنفيذ.'
          : 'تم تسجيل استرجاع من بوابة الدفع؛ يحتاج الطلب مراجعة الإدارة.';
      ss.push(
        db
          .prepare(
            "UPDATE orders SET payment_status=?,status=CASE WHEN status='cancelled' THEN status ELSE ? END,customer_update=?,updated_at=? WHERE id=? AND payment_method='gateway' AND (payment_status='unpaid' OR (payment_status IN ('paid','test_paid') AND ?<>'paid') OR (payment_status IN ('partially_refunded','test_partially_refunded') AND ?='refunded')) AND EXISTS (SELECT 1 FROM payunit_invoices WHERE order_id=orders.id AND status=?)",
          )
          .bind(
            payment,
            test || r.status !== 'paid' ? 'cancelled' : 'processing',
            message,
            t,
            s.order_id,
            r.status,
            r.status,
            r.status,
          ),
      );
    }
    if (['expired', 'cancelled'].includes(r.status))
      ss.push(
        db
          .prepare(
            "UPDATE orders SET status='cancelled',customer_update=?,updated_at=? WHERE id=? AND payment_method='gateway' AND payment_status='unpaid' AND EXISTS (SELECT 1 FROM payunit_invoices WHERE order_id=orders.id AND status=?)",
          )
          .bind(
            r.status === 'expired'
              ? 'انتهت صلاحية فاتورة الدفع؛ أنشئ طلبًا جديدًا.'
              : 'أُلغيت الفاتورة لدى بوابة الدفع.',
            t,
            s.order_id,
            r.status,
          ),
      );
    if (eventKey)
      ss.push(
        db
          .prepare('INSERT INTO payunit_events(event_id,event_type,created_at) VALUES (?,?,?)')
          .bind(eventKey, eventType, t),
      );
    try {
      await db.batch(ss);
    } catch (e) {
      if (
        !eventKey ||
        !(await first('SELECT event_id FROM payunit_events WHERE event_id=?', eventKey))
      )
        throw e;
    }
  }
  async function owned(id, u) {
    check(/^[a-f0-9-]{36}$/.test(id), 'رقم الطلب غير صالح');
    const o = await first('SELECT * FROM orders WHERE id=? AND user_id=?', id, u.id);
    check(o?.payment_method === 'gateway', 'الطلب غير موجود', 404);
    const s = await first('SELECT * FROM payunit_invoices WHERE order_id=?', id);
    check(s, 'فاتورة غير موجودة', 404);
    check(s.environment === mode, 'هذا الطلب يخص بيئة دفع مختلفة', 409);
    check(mode === 'live' || isManager(u), 'الدفع التجريبي مخصص للإدارة', 403);
    return { o, s };
  }
  async function create(req, u) {
    const b = await req.json(),
      { o, s } = await owned(String(b.order_id || ''), u);
    check(payunitReady(env), 'بوابة الدفع غير جاهزة', 503);
    check(
      o.payment_status === 'unpaid' && o.status === 'awaiting_payment',
      'الطلب لا يقبل دفعة جديدة',
      409,
    );
    if (s.invoice_id) return reply(summary(s, o));
    check(s.request_json && s.amount_usd_cents > 0, 'طلب الدفع المحفوظ ناقص', 409);
    let r;
    try {
      r = await call('/invoices', s.request_json, 'rivo-' + mode + '-' + o.id);
    } catch (e) {
      await run(
        'UPDATE payunit_invoices SET last_error=?,updated_at=? WHERE order_id=?',
        e.message,
        now(),
        o.id,
      );
      throw e;
    }
    validate(r, s, true);
    const url = new URL(r.checkout_url);
    check(
      url.origin === 'https://payunit.co' &&
        !url.username &&
        !url.password &&
        /^inv_[A-Za-z0-9_-]{1,140}$/.test(r.id),
      'رابط أو معرّف الفاتورة غير صالح',
      502,
    );
    check(
      [
        'pending',
        'processing',
        'paid',
        'expired',
        'cancelled',
        'refunded',
        'partially_refunded',
      ].includes(r.status),
      'حالة غير صالحة',
      502,
    );
    await run(
      "UPDATE payunit_invoices SET invoice_id=?,checkout_url=?,status='pending',last_error='',updated_at=? WHERE order_id=? AND invoice_id IS NULL",
      r.id,
      url.href,
      now(),
      o.id,
    );
    const saved = await first('SELECT * FROM payunit_invoices WHERE order_id=?', o.id);
    check(saved.invoice_id === r.id, 'فاتورة غير مطابقة', 409);
    if (r.status !== 'pending') await reconcile(saved);
    return reply(
      summary(
        await first('SELECT * FROM payunit_invoices WHERE order_id=?', o.id),
        await first('SELECT * FROM orders WHERE id=?', o.id),
      ),
      201,
    );
  }
  async function webhook(req) {
    const raw = await req.text();
    check(raw.length <= 300000, 'حجم الإشعار كبير', 413);
    check(
      await verifyPayunitWebhook(
        env.PAYUNIT_WEBHOOK_SECRET,
        raw,
        req.headers.get('Payunit-Timestamp'),
        req.headers.get('Payunit-Signature'),
      ),
      'توقيع الإشعار غير صالح',
    );
    const event = JSON.parse(raw);
    check(event && typeof event.event === 'string', 'إشعار غير صالح');
    check(
      /^[A-Za-z0-9._:-]{1,200}$/.test(req.headers.get('Payunit-Event-Id') || ''),
      'معرّف إشعار غير صالح',
    );
    // Event-Id isn't part of HMAC: deduplicate signed body, too.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)),
      key =
        mode +
        ':' +
        [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (await first('SELECT event_id FROM payunit_events WHERE event_id=?', key))
      return reply({ ok: true });
    if (!['invoice.paid', 'payment.failed', 'payment.refunded'].includes(event.event))
      return reply({ ok: true, ignored: true });
    const d = event.data;
    check(d && typeof d === 'object', 'إشعار ناقص');
    const ref = typeof d.external_ref === 'string' ? d.external_ref : '',
      id =
        typeof d.invoice_id === 'string'
          ? d.invoice_id
          : event.event === 'invoice.paid' && typeof d.id === 'string'
            ? d.id
            : '';
    let s = ref ? await first('SELECT * FROM payunit_invoices WHERE order_id=?', ref) : null;
    if (!s && id) s = await first('SELECT * FROM payunit_invoices WHERE invoice_id=?', id);
    check(s?.invoice_id, 'الفاتورة لم تُطابق بعد؛ أعد إرسال الإشعار', 503);
    check((!ref || ref === s.order_id) && (!id || id === s.invoice_id), 'مرجع غير مطابق', 409);
    await reconcile(s, key, event.event);
    return reply({ ok: true });
  }
  async function handle(req) {
    const p = new URL(req.url).pathname;
    if (p !== '/api/webhooks/payunit' && !p.startsWith('/api/payments/payunit')) return null;
    try {
      if (p === '/api/webhooks/payunit') {
        check(req.method === 'POST', 'طريقة غير مسموحة', 405);
        return await webhook(req);
      }
      const u = await identity(req);
      check(u, 'سجّل الدخول أولًا', 401);
      if (req.method !== 'GET')
        check(req.headers.get('origin') === new URL(req.url).origin, 'مصدر غير مسموح', 403);
      if (p === '/api/payments/payunit' && req.method === 'POST') return await create(req, u);
      const m = p.match(/^\/api\/payments\/payunit\/([a-f0-9-]{36})(\/refresh)?$/);
      if (m) {
        const { o, s } = await owned(m[1], u);
        if (m[2] && req.method === 'POST') {
          await reconcile(s);
          return reply(
            summary(
              await first('SELECT * FROM payunit_invoices WHERE order_id=?', o.id),
              await first('SELECT * FROM orders WHERE id=?', o.id),
            ),
          );
        }
        if (!m[2] && req.method === 'GET') return reply(summary(s, o));
      }
      throw new PaymentError(404, 'المسار غير موجود');
    } catch (e) {
      return reply(
        { error: e instanceof PaymentError ? e.message : 'تعذّر تنفيذ عملية الدفع؛ حاول مجددًا' },
        e instanceof PaymentError ? e.status : 500,
      );
    }
  }
  return { handle, configured: () => payunitReady(env) };
}
