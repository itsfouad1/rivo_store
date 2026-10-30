import { canManage } from './staff.mjs';
import { rateMap, convertCents, currencies } from './exchange.mjs';
import { priceCoupon, couponCode, CouponError } from './coupons.mjs';
import { homeImage } from './homepage.mjs';
const now = () => new Date().toISOString();
class ErrorResponse extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const need = (v, m, status = 400) => {
  if (!v) throw new ErrorResponse(status, m);
};
const str = (v, max) => {
  need(
    typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v),
    'نص غير صالح',
  );
  return v.trim();
};
const int = (v, min, max) => {
  need(Number.isSafeInteger(v) && v >= min && v <= max, 'قيمة رقمية غير صالحة');
  return v;
};
export function createCustomerGrowth(db, identity) {
  const first = (q, ...p) =>
      db
        .prepare(q)
        .bind(...p)
        .first(),
    all = async (q, ...p) =>
      (
        await db
          .prepare(q)
          .bind(...p)
          .all()
      ).results;
  const run = (q, ...p) =>
    db
      .prepare(q)
      .bind(...p)
      .run();
  const json = (v, status = 200) =>
    Response.json(v, {
      status,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  const owned = async (id, user) => {
    const o = await first('SELECT * FROM orders WHERE id=? AND user_id=?', id, user.id);
    need(o, 'الطلب غير موجود', 404);
    return o;
  };
  const body = async (req) => {
    const s = await req.text();
    need(s.length <= 30000, 'البيانات كبيرة', 413);
    try {
      return JSON.parse(s);
    } catch {
      throw new ErrorResponse(400, 'بيانات غير صالحة');
    }
  };
  return async (req) => {
    const url = new URL(req.url),
      path = url.pathname,
      method = req.method;
    if (
      !/^\/api\/(customer\/(favorites|reviews|reorder|order-extras)|reviews|coupons\/quote|admin\/(coupons|price-floors|content|reviews))($|\/)/.test(
        path,
      )
    )
      return null;
    try {
      if (path === '/api/reviews' && method === 'GET') {
        const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
        need(
          ids.length > 0 && ids.length <= 100 && ids.every((id) => id.length <= 100),
          'منتجات غير صالحة',
        );
        const marks = ids.map(() => '?').join(',');
        const where = `r.product_id IN (${marks}) AND r.status='approved' AND p.status='active' AND o.status='completed' AND o.payment_status='paid' AND NOT EXISTS(SELECT 1 FROM payunit_invoices pi WHERE pi.order_id=o.id AND pi.environment='test')`;
        const stats = await first(
          `SELECT count(*) AS count,avg(r.stars) AS average FROM customer_reviews r JOIN orders o ON o.id=r.order_id JOIN products p ON p.id=r.product_id WHERE ${where}`,
          ...ids,
        );
        const rows = await all(
          `SELECT r.id,r.stars,r.body,r.display_name,r.created_at FROM customer_reviews r JOIN orders o ON o.id=r.order_id JOIN products p ON p.id=r.product_id WHERE ${where} ORDER BY r.created_at DESC LIMIT 20`,
          ...ids,
        );
        return json({ items: rows, ...stats });
      }
      const user = await identity(req);
      need(user, 'سجّل الدخول أولًا', 401);
      if (!['GET', 'HEAD'].includes(method))
        need(req.headers.get('Origin') === url.origin, 'مصدر غير مسموح', 403);
      if (!path.startsWith('/api/admin/') && method !== 'GET') {
        const minute = Math.floor(Date.now() / 60000),
          limit = path === '/api/coupons/quote' ? 10 : 30;
        const r = await first(
          'INSERT INTO chat_limits(actor,window,hits) VALUES (?,?,1) ON CONFLICT(actor) DO UPDATE SET hits=CASE WHEN window=excluded.window THEN hits+1 ELSE 1 END,window=excluded.window RETURNING hits',
          'growth:' + user.id + ':' + path,
          minute,
        );
        need(r.hits <= limit, 'محاولات كثيرة؛ انتظر دقيقة', 429);
      }
      if (path.startsWith('/api/admin/'))
        need(
          canManage(
            user,
            path.includes('/coupons') || path.includes('/price-floors') ? 'settings' : 'products',
          ),
          'لا تملك الصلاحية المطلوبة',
          403,
        );
      if (path === '/api/customer/favorites' && method === 'GET')
        return json({
          ids: (
            await all(
              "SELECT f.product_id FROM customer_favorites f JOIN products p ON p.id=f.product_id WHERE f.user_id=? AND p.status='active' ORDER BY f.created_at DESC LIMIT 100",
              user.id,
            )
          ).map((p) => p.product_id),
        });
      if (path === '/api/customer/favorites' && ['POST', 'DELETE'].includes(method)) {
        const b = await body(req),
          id = str(b.product_id, 100);
        if (method === 'DELETE')
          await run('DELETE FROM customer_favorites WHERE user_id=? AND product_id=?', user.id, id);
        else {
          need(
            await first("SELECT id FROM products WHERE id=? AND status='active'", id),
            'المنتج غير متاح',
            404,
          );
          const n = await first(
            'SELECT count(*) AS n FROM customer_favorites WHERE user_id=?',
            user.id,
          );
          need(
            n.n < 100 ||
              (await first(
                'SELECT product_id FROM customer_favorites WHERE user_id=? AND product_id=?',
                user.id,
                id,
              )),
            'الحد الأقصى للمفضلة 100 منتج',
          );
          await run(
            'INSERT OR IGNORE INTO customer_favorites(user_id,product_id,created_at) SELECT ?,?,? WHERE (SELECT count(*) FROM customer_favorites WHERE user_id=?)<100',
            user.id,
            id,
            now(),
            user.id,
          );
        }
        return json({ ok: true });
      }
      const reorder = path.match(/^\/api\/customer\/reorder\/([^/]+)$/);
      if (reorder && method === 'GET') {
        await owned(reorder[1], user);
        const rows = await all(
          'SELECT p.id,p.status,sum(i.quantity) AS quantity FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=? GROUP BY p.id',
          reorder[1],
        );
        return json({
          items: rows
            .filter((p) => p.status === 'active')
            .map((p) => ({ id: p.id, quantity: Math.min(99, p.quantity) })),
          unavailable: rows.filter((p) => p.status !== 'active').length,
        });
      }
      const extras = path.match(/^\/api\/customer\/order-extras\/([^/]+)$/);
      if (extras && method === 'GET') {
        const o = await owned(extras[1], user);
        return json({
          discount: await first(
            'SELECT code,subtotal_cents,discount_cents,currency FROM coupon_redemptions WHERE order_id=?',
            o.id,
          ),
          reviews: await all(
            'SELECT product_id,stars,body,display_name,status FROM customer_reviews WHERE user_id=? AND product_id IN (SELECT product_id FROM order_items WHERE order_id=?)',
            user.id,
            o.id,
          ),
        });
      }
      if (path === '/api/customer/reviews' && method === 'POST') {
        const b = await body(req),
          o = await owned(str(b.order_id, 100), user),
          pid = str(b.product_id, 100),
          stars = int(b.stars, 1, 5),
          text = str(b.body || '', 1000),
          name = str(b.display_name || 'زبون ريفو', 30);
        need(
          o.status === 'completed' &&
            o.payment_status === 'paid' &&
            !(await first(
              "SELECT order_id FROM payunit_invoices WHERE order_id=? AND environment='test'",
              o.id,
            )),
          'التقييم متاح فقط لمشتريات حقيقية مدفوعة ومكتملة',
          403,
        );
        need(
          await first('SELECT id FROM order_items WHERE order_id=? AND product_id=?', o.id, pid),
          'المنتج ليس ضمن طلبك',
          403,
        );
        need(
          name && !/@|https?:|\d{7}/i.test(name + ' ' + text),
          'لا تضع بريدًا أو رابطًا أو بيانات حساب بالتقييم',
        );
        const t = now();
        await run(
          "INSERT INTO customer_reviews(id,user_id,product_id,order_id,stars,body,display_name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET order_id=excluded.order_id,stars=excluded.stars,body=excluded.body,display_name=excluded.display_name,status='pending',updated_at=excluded.updated_at",
          crypto.randomUUID(),
          user.id,
          pid,
          o.id,
          stars,
          text,
          name,
          t,
          t,
        );
        return json({ ok: true, status: 'pending' });
      }
      if (path === '/api/admin/reviews' && method === 'GET')
        return json({
          items: await all(
            'SELECT r.*,p.name AS product_name FROM customer_reviews r JOIN products p ON p.id=r.product_id ORDER BY r.updated_at DESC LIMIT 200',
          ),
        });
      const review = path.match(/^\/api\/admin\/reviews\/([^/]+)$/);
      if (review && method === 'PUT') {
        const b = await body(req);
        need(['approved', 'rejected', 'pending'].includes(b.status), 'حالة غير صالحة');
        await run(
          'UPDATE customer_reviews SET status=?,updated_at=? WHERE id=?',
          b.status,
          now(),
          review[1],
        );
        return json({ ok: true });
      }
      if (path === '/api/admin/content' && method === 'GET')
        return json({
          items: await all(
            "SELECT id,name,category,region,description,activation_instructions,delivery_estimate,purchase_notice,image_url,player_id_required,status,updated_at FROM products WHERE status<>'archived' ORDER BY sort_order,name",
          ),
        });
      const content = path.match(/^\/api\/admin\/content\/([^/]+)$/);
      if (content && method === 'PUT') {
        const b = await body(req),
          p = await first('SELECT * FROM products WHERE id=?', content[1]);
        need(p, 'المنتج غير موجود', 404);
        need(b.updated_at === p.updated_at, 'المنتج تغيّر؛ أعد تحميله قبل الحفظ', 409);
        const fields = {
          name: str(b.name, 120),
          region: str(b.region, 100),
          description: str(b.description, 3000),
          activation_instructions: str(b.activation_instructions, 3000),
          delivery_estimate: str(b.delivery_estimate, 200),
          purchase_notice: str(b.purchase_notice, 1500),
          image_url: homeImage(b.image_url),
        };
        need(fields.name, 'اسم المنتج مطلوب');
        const f = await first('SELECT service_type FROM fox_products WHERE product_id=?', p.id);
        need(f?.service_type !== 'steam' || fields.region, 'Steam يتطلب منطقة مدعومة محددة');
        const t = new Date(Math.max(Date.now(), Date.parse(p.updated_at) + 1)).toISOString();
        const keys = Object.keys(fields);
        const r = await run(
          'UPDATE products SET ' +
            keys.map((k) => k + '=?').join(',') +
            ',updated_at=? WHERE id=? AND updated_at=?',
          ...keys.map((k) => fields[k]),
          t,
          p.id,
          p.updated_at,
        );
        need((r.meta?.changes ?? r.changes) === 1, 'المنتج تغيّر؛ أعد تحميله', 409);
        return json({ ok: true, updated_at: t });
      }
      if (path === '/api/admin/coupons' && method === 'GET')
        return json({
          items: await all(
            'SELECT c.*,(SELECT count(*) FROM coupon_redemptions r WHERE r.code=c.code) AS used FROM store_coupons c ORDER BY created_at DESC LIMIT 200',
          ),
          floors: await all('SELECT * FROM coupon_price_floors'),
        });
      if (path === '/api/admin/coupons' && method === 'POST') {
        const b = await body(req),
          code = couponCode(b.code);
        need(
          Number.isFinite(Date.parse(b.starts_at)) && Number.isFinite(Date.parse(b.expires_at)),
          'راجع تواريخ الكوبون',
        );
        const start = new Date(b.starts_at).toISOString(),
          end = new Date(b.expires_at).toISOString();
        need(end > start && end > now(), 'راجع تواريخ الكوبون');
        const ids = b.product_ids;
        need(
          Array.isArray(ids) &&
            ids.length <= 100 &&
            new Set(ids).size === ids.length &&
            ids.every((id) => typeof id === 'string' && id.length <= 100),
          'قائمة منتجات غير صالحة',
        );
        const known = new Set((await all('SELECT id FROM products')).map((p) => p.id));
        need(
          ids.every((id) => known.has(id)),
          'منتج غير موجود',
        );
        need(
          !(await first('SELECT code FROM store_coupons WHERE code=?', code)),
          'الكود موجود مسبقًا',
          409,
        );
        await run(
          'INSERT INTO store_coupons(code,percent_bps,min_usd_cents,min_margin_bps,max_uses,starts_at,expires_at,product_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          code,
          int(b.percent_bps, 100, 5000),
          int(b.min_usd_cents, 0, 100000000),
          int(b.min_margin_bps, 0, 10000),
          int(b.max_uses, 1, 100000),
          start,
          end,
          JSON.stringify(ids),
          now(),
        );
        return json({ ok: true }, 201);
      }
      const coupon = path.match(/^\/api\/admin\/coupons\/([^/]+)$/);
      if (coupon && method === 'PUT') {
        const b = await body(req);
        need(typeof b.enabled === 'boolean', 'حالة غير صالحة');
        await run(
          'UPDATE store_coupons SET enabled=?,version=version+1 WHERE code=?',
          b.enabled ? 1 : 0,
          couponCode(decodeURIComponent(coupon[1])),
        );
        return json({ ok: true });
      }
      if (path === '/api/admin/price-floors' && method === 'PUT') {
        const b = await body(req),
          id = str(b.product_id, 100);
        need(await first('SELECT id FROM products WHERE id=?', id), 'المنتج غير موجود', 404);
        await run(
          'INSERT INTO coupon_price_floors VALUES (?,?,?) ON CONFLICT(product_id) DO UPDATE SET floor_usd_cents=excluded.floor_usd_cents,updated_at=excluded.updated_at',
          id,
          int(b.floor_usd_cents, 1, 100000000),
          now(),
        );
        return json({ ok: true });
      }
      if (path === '/api/coupons/quote' && method === 'POST') {
        const b = await body(req);
        need(
          currencies.includes(b.currency) &&
            Array.isArray(b.items) &&
            b.items.length > 0 &&
            b.items.length <= 20,
          'سلة غير صالحة',
        );
        const rates = await rateMap(db),
          items = [],
          seen = new Set();
        for (const x of b.items) {
          const id = str(x.id, 100);
          need(!seen.has(id), 'منتج مكرر');
          seen.add(id);
          const p = await first("SELECT * FROM products WHERE id=? AND status='active'", id);
          need(p, 'منتج غير متاح', 409);
          items.push({
            ...p,
            quantity: int(x.quantity, 1, 99),
            unit_cents: convertCents(p.price_cents, p.currency, b.currency, rates),
          });
        }
        const quote = await priceCoupon(db, {
          code: b.code,
          userId: user.id,
          items,
          currency: b.currency,
          rates,
        });
        return json({
          ...quote,
          items: quote.items.map((p) => ({
            id: p.id,
            unit_cents: p.unit_cents,
            quantity: p.quantity,
          })),
        });
      }
      return json({ error: 'طريقة أو مسار غير مدعوم' }, 405);
    } catch (e) {
      if (e instanceof ErrorResponse || e instanceof CouponError)
        return json({ error: e.message }, e.status);
      return json({ error: 'تعذّر تنفيذ العملية؛ راجع البيانات وحاول مجددًا' }, 500);
    }
  };
}
