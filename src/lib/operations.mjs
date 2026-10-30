import { canManage } from './staff.mjs';
import { rateMap, convertCents } from './exchange.mjs';
const stamp = () => new Date().toISOString();
const json = (v, status = 200) =>
  Response.json(v, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
class OpsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const need = (ok, msg, status = 400) => {
  if (!ok) throw new OpsError(status, msg);
};
const integer = (v, min, max) => {
  need(Number.isSafeInteger(v) && v >= min && v <= max, 'قيمة رقمية غير صالحة');
  return v;
};
const text = (v, max) => {
  need(
    typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v),
    'نص غير صالح',
  );
  return v.trim();
};
export function notificationMessage(o) {
  if (o.payment_status.startsWith('test_'))
    return { title: 'تحديث طلب تجريبي', body: 'هذه تجربة فقط؛ راجع تفاصيل الطلب.' };
  if (o.payment_status.includes('refunded'))
    return {
      title: 'تحديث حالة الاسترجاع',
      body: 'تغيّرت حالة الاسترجاع المسجلة لطلبك. راجع التفاصيل أو تواصل مع الدعم.',
    };
  if (o.status === 'cancelled')
    return { title: 'تم إغلاق الطلب', body: 'طلبك مغلق. تواصل مع الدعم إذا احتجت مساعدة.' };
  if (o.status === 'completed')
    return { title: 'اكتمل طلبك', body: 'تفاصيل التسليم متاحة في صفحة الطلب.' };
  if (o.customer_update) return { title: 'تحديث من ريفو', body: o.customer_update };
  if (o.payment_status === 'paid')
    return {
      title: o.status === 'processing' ? 'طلبك قيد التنفيذ' : 'تم تأكيد الدفع',
      body: 'نتابع تنفيذ طلبك؛ ستظهر تفاصيله في حسابك.',
    };
  return { title: 'طلبك محفوظ', body: 'يمكنك متابعة حالة الطلب والتواصل مع الدعم من تفاصيله.' };
}
export function createOperations(db, identity = async () => null) {
  const first = (q, ...p) =>
    db
      .prepare(q)
      .bind(...p)
      .first();
  const all = async (q, ...p) =>
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
  const audit = (u, action, target) =>
    run('INSERT INTO audit VALUES (?,?,?,?,?)', crypto.randomUUID(), u.id, action, target, stamp());
  async function observe(o) {
    const signature = JSON.stringify([o.status, o.payment_status, o.customer_update]);
    await run('INSERT OR IGNORE INTO order_observations(order_id) VALUES (?)', o.id);
    const prior = await first('SELECT * FROM order_observations WHERE order_id=?', o.id),
      time = stamp();
    if (prior.signature === signature) {
      if (Date.now() - Date.parse(prior.checked_at || '2000-01-01') > 3600000)
        await run('UPDATE order_observations SET checked_at=? WHERE order_id=?', time, o.id);
      return;
    }
    const version = prior.version + 1,
      m = notificationMessage(o);
    await db.batch([
      db
        .prepare(
          'UPDATE order_observations SET signature=?,version=?,checked_at=? WHERE order_id=? AND version=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status=? AND payment_status=? AND customer_update=?)',
        )
        .bind(
          signature,
          version,
          time,
          o.id,
          prior.version,
          o.id,
          o.status,
          o.payment_status,
          o.customer_update,
        ),
      db
        .prepare(
          'INSERT OR IGNORE INTO customer_notifications(id,user_id,order_id,title,body,created_at) SELECT ?,?,?,?,?,? FROM order_observations WHERE order_id=? AND version=? AND signature=?',
        )
        .bind(
          o.id + ':' + version,
          o.user_id,
          o.id,
          m.title,
          m.body,
          time,
          o.id,
          version,
          signature,
        ),
    ]);
  }
  async function reconcile(userId) {
    const rows = userId
      ? await all(
          'SELECT o.* FROM orders o LEFT JOIN order_observations v ON v.order_id=o.id WHERE o.user_id=? AND (v.order_id IS NULL OR v.signature<>json_array(o.status,o.payment_status,o.customer_update)) ORDER BY o.updated_at DESC LIMIT 8',
          userId,
        )
      : await all(
          "SELECT o.* FROM orders o LEFT JOIN order_observations v ON v.order_id=o.id ORDER BY coalesce(v.checked_at,'') ASC LIMIT 8",
        );
    for (const o of rows) await observe(o);
    return { processed: rows.length };
  }
  async function issues(params) {
    need((params.get('q') || '').length <= 200, 'البحث طويل');
    if (params.get('state'))
      need(
        ['open', 'in_progress', 'escalated', 'resolved'].includes(params.get('state')),
        'حالة غير صالحة',
      );
    if (params.get('reason'))
      need(
        ['paid_pending', 'delayed', 'supplier_review', 'refund_review'].includes(
          params.get('reason'),
        ),
        'سبب غير صالح',
      );
    const config = await first('SELECT * FROM ops_config WHERE id=1');
    const rows = await all(
      `SELECT o.*,u.name AS customer_name,u.email AS customer_email,f.state AS followup_state,f.assigned_to,f.priority,f.due_at,f.internal_note,f.updated_at AS followup_updated_at,a.name AS assignee_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN order_followups f ON f.order_id=o.id LEFT JOIN users a ON a.id=f.assigned_to WHERE o.payment_status NOT LIKE 'test_%' AND NOT EXISTS(SELECT 1 FROM payunit_invoices pi WHERE pi.order_id=o.id AND pi.environment='test') AND (f.order_id IS NOT NULL OR o.payment_status IN ('refunded','partially_refunded') OR (o.payment_status='paid' AND o.status<>'completed') OR EXISTS(SELECT 1 FROM order_items ii JOIN fox_jobs jj ON jj.item_id=ii.id WHERE ii.order_id=o.id AND jj.is_mock=0 AND (jj.status IN ('failed','action_required','refunded','cancelled') OR (jj.error<>'' AND jj.status<>'completed')))) ORDER BY CASE WHEN f.state='resolved' THEN 1 ELSE 0 END,o.created_at ASC LIMIT 1000`,
    );
    const jobs = await all(
        "SELECT j.item_id,j.status,j.error,i.order_id FROM fox_jobs j JOIN order_items i ON i.id=j.item_id JOIN orders o ON o.id=i.order_id WHERE j.is_mock=0 AND o.payment_status IN ('paid','refunded','partially_refunded') AND (j.status IN ('failed','action_required','refunded','cancelled') OR j.error<>'') LIMIT 5000",
      ),
      by = new Map();
    for (const j of jobs) {
      if (!by.has(j.order_id)) by.set(j.order_id, []);
      by.get(j.order_id).push(j);
    }
    const result = [];
    for (const o of rows) {
      const reasons = [];
      if (o.payment_status === 'paid' && !['completed', 'cancelled'].includes(o.status)) {
        reasons.push('paid_pending');
        if (Date.now() - Date.parse(o.created_at) > config.delay_minutes * 60000)
          reasons.push('delayed');
      }
      if (
        (o.payment_status === 'paid' && o.status === 'cancelled') ||
        o.payment_status.includes('refunded')
      )
        reasons.push('refund_review');
      for (const j of by.get(o.id) || []) {
        if (
          ['failed', 'action_required', 'refunded', 'cancelled'].includes(j.status) ||
          (j.error && j.status !== 'completed')
        )
          reasons.push('supplier_review');
      }
      if (!reasons.length && !o.followup_state) continue;
      const active = [...new Set(reasons)],
        state = o.followup_state || 'open';
      if (params.get('state') && params.get('state') !== state) continue;
      if (params.get('reason') && !active.includes(params.get('reason'))) continue;
      const q = (params.get('q') || '').trim().toLowerCase();
      need(q.length <= 200, 'البحث طويل');
      if (q && ![o.id, o.customer_name, o.customer_email].join(' ').toLowerCase().includes(q))
        continue;
      result.push({
        id: o.id,
        customer_name: o.customer_name,
        customer_email: o.customer_email,
        status: o.status,
        payment_status: o.payment_status,
        created_at: o.created_at,
        state,
        priority: o.priority || 'normal',
        assigned_to: o.assigned_to,
        assignee_name: o.assignee_name,
        due_at: o.due_at,
        internal_note: o.internal_note || '',
        reasons: active,
        unresolved_condition: active.length > 0,
      });
    }
    result.sort(
      (a, b) =>
        ({ urgent: 0, high: 1, normal: 2 })[a.priority] -
          { urgent: 0, high: 1, normal: 2 }[b.priority] || a.created_at.localeCompare(b.created_at),
    );
    const page = integer(Number(params.get('page') || 1), 1, 10000),
      limit = 25;
    return {
      items: result.slice((page - 1) * limit, page * limit),
      page,
      pages: Math.ceil(result.length / limit),
      total: result.length,
      scanned: rows.length,
      limited: rows.length === 1000,
      delay_minutes: config.delay_minutes,
    };
  }
  async function report(params) {
    const days = integer(Number(params.get('days') || 30), 1, 366),
      since = new Date(Date.now() - days * 86400000).toISOString();
    const orders = await all(
      `SELECT o.*,m.revenue_usd_cents,m.manual_cost_units,m.manual_fee_cents,m.recorded_by,pi.amount_usd_cents,pi.fee_usd_cents FROM orders o LEFT JOIN ops_order_money m ON m.order_id=o.id LEFT JOIN payunit_invoices pi ON pi.order_id=o.id WHERE o.created_at>=? AND o.payment_status='paid' AND coalesce(pi.environment,'')<>'test' ORDER BY o.created_at DESC LIMIT 1001`,
      since,
    );
    const items = await all(
      "SELECT i.*,f.sale_usd_cents,j.id AS job_id,j.status AS job_status,r.cost_units AS recorded_cost FROM order_items i LEFT JOIN fox_order_lines f ON f.item_id=i.id LEFT JOIN fox_jobs j ON j.item_id=i.id AND j.is_mock=0 LEFT JOIN supplier_receipts r ON r.job_id=j.id WHERE i.order_id IN (SELECT id FROM orders WHERE created_at>=? AND payment_status='paid' ORDER BY created_at DESC LIMIT 1000)",
      since,
    );
    const map = new Map();
    for (const i of items) {
      if (!map.has(i.order_id)) map.set(i.order_id, []);
      map.get(i.order_id).push(i);
    }
    const top = new Map(),
      rows = orders.slice(0, 1000).map((o) => {
        const lines = map.get(o.id) || [];
        const revenue =
          o.revenue_usd_cents ??
          o.amount_usd_cents ??
          (o.currency === 'USD'
            ? o.total_cents
            : lines.length && lines.every((i) => i.sale_usd_cents !== null)
              ? lines.reduce((s, i) => s + i.sale_usd_cents * i.quantity, 0)
              : null);
        const costUnits =
          o.manual_cost_units ??
          (lines.length &&
          lines.every((i) => i.job_status === 'completed' && i.recorded_cost !== null)
            ? lines.reduce((s, i) => s + i.recorded_cost, 0)
            : null);
        const cost = costUnits === null ? null : Math.ceil(costUnits / 100),
          fee = o.payment_method === 'gateway' ? o.fee_usd_cents : o.manual_fee_cents;
        const margin =
          o.status === 'completed' && revenue !== null && cost !== null && fee !== null
            ? revenue - cost - fee
            : null;
        if (o.status === 'completed')
          for (const i of lines) {
            const key = i.product_id;
            if (!top.has(key))
              top.set(key, { product_id: key, name: i.name, quantity: 0, orders: 0 });
            const t = top.get(key);
            t.quantity += i.quantity;
            t.orders++;
          }
        return {
          id: o.id,
          status: o.status,
          payment_method: o.payment_method,
          created_at: o.created_at,
          revenue_usd_cents: revenue,
          cost_usd_cents: cost,
          fee_usd_cents: fee,
          margin_usd_cents: margin,
          cost_source:
            o.manual_cost_units !== null
              ? 'manual'
              : cost !== null
                ? 'supplier_receipt'
                : 'unknown',
          missing: [
            revenue === null ? 'revenue' : null,
            cost === null ? 'cost' : null,
            fee === null ? 'fee' : null,
            o.status !== 'completed' ? 'not_completed' : null,
          ].filter(Boolean),
        };
      });
    return {
      days,
      rows,
      limited: orders.length > 1000,
      known_margin_cents: rows.reduce((n, r) => n + (r.margin_usd_cents ?? 0), 0),
      complete_count: rows.filter((r) => r.margin_usd_cents !== null).length,
      unknown_count: rows.filter((r) => r.margin_usd_cents === null).length,
      top_products: [...top.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    };
  }
  async function health() {
    const products = await all(
        "SELECT p.*,f.cost_units,f.stock,f.checked_at,f.auto_price FROM products p LEFT JOIN fox_products f ON f.product_id=p.id WHERE p.status<>'archived' ORDER BY p.created_at DESC LIMIT 1001",
      ),
      rates = await rateMap(db);
    const events = await all(
      'SELECT e.*,p.name FROM supplier_product_events e JOIN products p ON p.id=e.product_id WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 100',
    );
    const checks = [];
    for (const p of products.slice(0, 1000)) {
      const flags = [];
      if (!p.image_url) flags.push('missing_image');
      if (!p.region) flags.push('missing_region');
      if (!p.activation_instructions) flags.push('missing_guide');
      if (p.stock === 0) flags.push('out_of_stock');
      if (p.checked_at && Date.now() - Date.parse(p.checked_at) > 86400000)
        flags.push('stale_supplier');
      let sellingUsd = null;
      try {
        sellingUsd = convertCents(p.price_cents, p.currency, 'USD', rates);
        if (p.cost_units !== null && sellingUsd * 100 < p.cost_units)
          flags.push('price_below_cost');
      } catch {
        if (p.cost_units !== null) flags.push('missing_rates');
      }
      if (flags.length)
        checks.push({
          id: p.id,
          name: p.name,
          status: p.status,
          flags,
          sale_usd_cents: sellingUsd,
          cost_units: p.cost_units,
        });
    }
    const cfg = await first('SELECT * FROM ops_config WHERE id=1'),
      balance = await first(
        "SELECT * FROM supplier_balance_snapshots WHERE supplier_id='foxreload'",
      );
    return {
      products: checks,
      events,
      limited: products.length > 1000,
      balance: balance
        ? {
            ...balance,
            low: balance.balance_units < cfg.low_balance_cents * 100,
            stale: Date.now() - Date.parse(balance.checked_at) > 3600000,
          }
        : null,
      low_balance_cents: cfg.low_balance_cents,
    };
  }
  async function launch() {
    const row = await first("SELECT value FROM settings WHERE id='store'"),
      settings = row ? JSON.parse(row.value) : {};
    const policy = await all(
      "SELECT id,value FROM settings WHERE id IN ('policy:privacy','policy:terms','policy:refunds')",
    );
    const published = policy
      .filter((p) => {
        try {
          return Boolean(JSON.parse(p.value).published?.body);
        } catch {
          return false;
        }
      })
      .map((p) => p.id.slice(7));
    const active = await first("SELECT count(*) AS n FROM products WHERE status='active'"),
      missing = await first(
        "SELECT count(*) AS n FROM products WHERE status='active' AND (image_url='' OR region='' OR activation_instructions='')",
      );
    return {
      config: await first('SELECT * FROM ops_config WHERE id=1'),
      checks: [
        { name: 'منتجات منشورة', ready: active.n > 0, detail: active.n + ' منتج' },
        {
          name: 'صور ومناطق وتعليمات المنتجات المنشورة',
          ready: missing.n === 0 && active.n > 0,
          detail: missing.n + ' منتج يحتاج مراجعة',
        },
        {
          name: 'السياسات المنشورة',
          ready: published.length === 3,
          detail: published.join(' / ') || 'لا توجد سياسات منشورة',
        },
        {
          name: 'واتساب المتجر',
          ready: /^[1-9]\d{6,14}$/.test(settings.whatsapp || ''),
          detail: 'تحقق من استقبال الرسائل بنفسك',
        },
        {
          name: 'إرسال البريد',
          ready: false,
          detail: 'غير مربوط؛ تنبيهات هذه النسخة داخل الموقع فقط',
        },
        {
          name: 'النسخ الاحتياطي',
          ready: false,
          detail:
            'شغّل scripts/backup-store.mjs واحتفظ بالنسخة محليًا؛ صور R2 وحسابات Supabase تحتاج نسخًا مستقلة',
        },
        { name: 'الدومين', ready: false, detail: 'مؤجل حسب اختيارك؛ الموقع يعمل على رابط Workers' },
      ],
    };
  }
  async function bulk(b, u) {
    need(Array.isArray(b.ids) && b.ids.length > 0 && b.ids.length <= 100, 'اختر من1 إلى100 منتج');
    const ids = [...new Set(b.ids)];
    need(
      ids.length === b.ids.length && ids.every((id) => typeof id === 'string' && id.length <= 100),
      'معرّفات غير صالحة',
    );
    const products = await all(
      'SELECT p.*,f.cost_units,f.auto_price,f.markup_bps,f.service_type FROM products p LEFT JOIN fox_products f ON f.product_id=p.id WHERE p.id IN (' +
        ids.map(() => '?').join(',') +
        ')',
      ...ids,
    );
    need(products.length === ids.length, 'منتج غير موجود', 404);
    const statements = [],
      time = stamp(),
      rates = await rateMap(db);
    if (b.mode === 'fields')
      need(
        b.category !== undefined || b.region !== undefined || b.payment_mode !== undefined,
        'اختر حقلًا واحدًا على الأقل للتعديل',
      );
    for (const p of products) {
      if (b.mode === 'fields') {
        const category = b.category === undefined ? p.category : text(b.category, 80),
          region = b.region === undefined ? p.region : text(b.region, 100),
          payment = b.payment_mode ?? p.payment_mode;
        need(
          category && ['whatsapp', 'gateway', 'both'].includes(payment),
          'بيانات التصنيف أو الدفع غير صالحة',
        );
        need(p.service_type !== 'steam' || region, 'منطقة Steam مطلوبة');
        statements.push(
          db
            .prepare(
              'UPDATE products SET category=?,region=?,payment_mode=?,updated_at=? WHERE id=?',
            )
            .bind(category, region, payment, time, p.id),
        );
      } else if (b.mode === 'price') {
        integer(b.bps, -9000, 100000);
        need(!p.auto_price, 'يوجد منتج بتسعير تلقائي؛ استخدم تعديل هامش المورد له', 409);
        const cents = Math.ceil((p.price_cents * (10000 + b.bps)) / 10000);
        integer(cents, 0, 100000000);
        statements.push(
          db
            .prepare('UPDATE products SET price_cents=?,updated_at=? WHERE id=?')
            .bind(cents, time, p.id),
        );
      } else if (b.mode === 'margin') {
        integer(b.bps, 0, 100000);
        need(p.cost_units !== null, 'تعديل هامش المورد يحتاج منتجات مربوطة فقط', 409);
        const usd = Number((BigInt(p.cost_units) * BigInt(10000 + b.bps) + 999999n) / 1000000n),
          cents = convertCents(usd, 'USD', p.currency, rates);
        integer(cents, 0, 100000000);
        statements.push(
          db
            .prepare('UPDATE fox_products SET markup_bps=?,auto_price=1 WHERE product_id=?')
            .bind(b.bps, p.id),
          db
            .prepare('UPDATE products SET price_cents=?,updated_at=? WHERE id=?')
            .bind(cents, time, p.id),
        );
      } else throw new OpsError(400, 'نوع تعديل غير صالح');
    }
    statements.push(
      db
        .prepare('INSERT INTO audit VALUES (?,?,?,?,?)')
        .bind(crypto.randomUUID(), u.id, 'bulk_' + b.mode, String(ids.length), time),
    );
    await db.batch(statements);
    return { ok: true, count: ids.length };
  }
  async function handle(req) {
    const url = new URL(req.url),
      path = url.pathname;
    if (
      !path.startsWith('/api/notifications') &&
      !path.startsWith('/api/admin/operations') &&
      !path.startsWith('/api/support/operations')
    )
      return null;
    try {
      const u = await identity(req);
      need(u, 'سجّل الدخول أولًا', 401);
      if (req.method !== 'GET')
        need(req.headers.get('origin') === url.origin, 'مصدر غير مسموح', 403);
      let b = {};
      if (req.method !== 'GET') {
        const raw = await req.text();
        need(raw.length <= 30000, 'حجم الطلب كبير', 413);
        try {
          b = JSON.parse(raw);
        } catch {
          throw new OpsError(400, 'JSON غير صالح');
        }
        need(b && typeof b === 'object' && !Array.isArray(b), 'بيانات غير صالحة');
      }
      if (path === '/api/notifications' && req.method === 'GET') {
        await reconcile(u.id);
        const limit = 25,
          page = integer(Number(url.searchParams.get('page') || 1), 1, 10000);
        return json({
          items: await all(
            'SELECT id,order_id,title,body,created_at,read_at FROM customer_notifications WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?',
            u.id,
            limit,
            (page - 1) * limit,
          ),
          unread: (
            await first(
              'SELECT count(*) AS n FROM customer_notifications WHERE user_id=? AND read_at IS NULL',
              u.id,
            )
          ).n,
          total: (
            await first('SELECT count(*) AS n FROM customer_notifications WHERE user_id=?', u.id)
          ).n,
          page,
        });
      }
      if (path === '/api/notifications/read' && req.method === 'POST') {
        if (b.all === true)
          await run(
            'UPDATE customer_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL',
            stamp(),
            u.id,
          );
        else {
          need(typeof b.id === 'string' && b.id.length <= 100, 'معرّف غير صالح');
          await run(
            'UPDATE customer_notifications SET read_at=? WHERE id=? AND user_id=?',
            stamp(),
            b.id,
            u.id,
          );
        }
        return json({ ok: true });
      }
      const support = path.startsWith('/api/support/');
      need(
        support
          ? ['support', 'admin', 'owner'].includes(u.role)
          : ['admin', 'owner'].includes(u.role),
        'غير مسموح',
        403,
      );
      const suffix = path.replace(/^\/api\/(admin|support)\/operations/, '');
      if (suffix === '/issues' && req.method === 'GET') {
        need(support || canManage(u, 'orders_write'), 'لا تملك صلاحية الطلبات', 403);
        return json(await issues(url.searchParams));
      }
      if (suffix === '/staff' && req.method === 'GET') {
        need(!support && canManage(u, 'orders_write'), 'غير مسموح', 403);
        return json({
          items: await all(
            "SELECT s.user_id AS id,u.name,s.role FROM staff_access s JOIN users u ON u.id=s.user_id WHERE s.active=1 AND s.role IN ('owner','admin','support') ORDER BY u.name",
          ),
        });
      }
      const im = suffix.match(/^\/issues\/([a-f0-9-]{36})$/);
      if (im && req.method === 'GET') {
        need(support || canManage(u, 'orders_write'), 'غير مسموح', 403);
        return json({
          history: await all(
            'SELECT h.action,h.note,h.created_at,u.name AS author FROM order_followup_history h LEFT JOIN users u ON u.id=h.actor WHERE h.order_id=? ORDER BY h.created_at DESC LIMIT 100',
            im[1],
          ),
        });
      }
      if (im && req.method === 'POST') {
        need(await first('SELECT id FROM orders WHERE id=?', im[1]), 'الطلب غير موجود', 404);
        const note = text(b.note ?? '', 2000),
          old = await first('SELECT * FROM order_followups WHERE order_id=?', im[1]);
        let state = b.state ?? old?.state ?? 'open',
          priority = b.priority ?? old?.priority ?? 'normal',
          assigned = b.assigned_to === undefined ? (old?.assigned_to ?? null) : b.assigned_to,
          due = b.due_at === undefined ? (old?.due_at ?? null) : b.due_at;
        if (support && u.role === 'support') {
          need(
            state === 'escalated' &&
              note.length > 0 &&
              b.assigned_to === undefined &&
              b.due_at === undefined &&
              b.priority === undefined,
            'الدعم يستطيع التصعيد مع ملاحظة فقط',
            403,
          );
          priority = old?.priority ?? 'normal';
        } else need(canManage(u, 'orders_write'), 'لا تملك صلاحية تعديل المتابعة', 403);
        need(
          ['open', 'in_progress', 'escalated', 'resolved'].includes(state) &&
            ['normal', 'high', 'urgent'].includes(priority),
          'حالة غير صالحة',
        );
        need(
          assigned === null || (typeof assigned === 'string' && assigned.length <= 100),
          'معرّف موظف غير صالح',
        );
        if (assigned)
          need(
            await first(
              "SELECT user_id FROM staff_access WHERE user_id=? AND active=1 AND role IN ('support','admin','owner')",
              assigned,
            ),
            'الموظف غير متاح',
          );
        if (due)
          need(
            typeof due === 'string' && due.length <= 30 && Number.isFinite(Date.parse(due)),
            'موعد غير صالح',
          );
        const t = stamp();
        await db.batch([
          db
            .prepare(
              'INSERT INTO order_followups VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,assigned_to=excluded.assigned_to,priority=excluded.priority,due_at=excluded.due_at,internal_note=excluded.internal_note,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
            )
            .bind(im[1], state, assigned, priority, due, note, u.id, t),
          db
            .prepare('INSERT INTO order_followup_history VALUES (?,?,?,?,?,?)')
            .bind(crypto.randomUUID(), im[1], u.id, state, note, t),
        ]);
        await audit(u, 'followup_' + state, im[1]);
        return json({ ok: true });
      }
      need(!support, 'غير مسموح', 403);
      if (suffix === '/report' && req.method === 'GET') {
        need(canManage(u, 'reports'), 'لا تملك صلاحية التقارير', 403);
        return json(await report(url.searchParams));
      }
      if (suffix === '/money' && req.method === 'POST') {
        need(canManage(u, 'reports'), 'لا تملك صلاحية التقارير', 403);
        need(b.confirm === true, 'أكد أن هذه تكاليف فعلية وليست تقديرية');
        need(
          typeof b.order_id === 'string' && /^[a-f0-9-]{36}$/.test(b.order_id),
          'معرّف طلب غير صالح',
        );
        const o = await first('SELECT * FROM orders WHERE id=?', b.order_id);
        need(o && o.payment_status === 'paid', 'اختر طلبًا مدفوعًا', 409);
        const note = text(b.note ?? '', 1000);
        need(note, 'أضف مصدر التكلفة للمراجعة');
        const cost = b.cost_units === undefined ? null : integer(b.cost_units, 0, 1e12),
          fee = b.fee_cents === undefined ? null : integer(b.fee_cents, 0, 100000000);
        need(cost !== null || fee !== null, 'أضف تكلفة أو رسومًا');
        need(o.payment_method !== 'gateway' || fee === null, 'رسوم البوابة تقرأ من الفاتورة فقط');
        const prior = await first(
            'SELECT manual_cost_units,manual_fee_cents,note,version FROM ops_order_money WHERE order_id=?',
            o.id,
          ),
          next = {
            cost_units: cost ?? prior?.manual_cost_units ?? null,
            fee_cents: fee ?? prior?.manual_fee_cents ?? null,
          },
          time = stamp(),
          version = prior?.version ?? 0;
        if (b.expected_version !== undefined)
          need(b.expected_version === version, 'عدّل موظف آخر الأرقام؛ أعد تحميلها قبل الحفظ', 409);
        const saved = await db.batch([
          db
            .prepare(
              'INSERT INTO ops_order_money(order_id,manual_cost_units,manual_fee_cents,note,recorded_by,updated_at,version) VALUES (?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET manual_cost_units=coalesce(excluded.manual_cost_units,ops_order_money.manual_cost_units),manual_fee_cents=coalesce(excluded.manual_fee_cents,ops_order_money.manual_fee_cents),note=excluded.note,recorded_by=excluded.recorded_by,updated_at=excluded.updated_at,version=excluded.version WHERE ops_order_money.version=?',
            )
            .bind(o.id, cost, fee, note, u.id, time, version + 1, version),
          db
            .prepare(
              'INSERT OR IGNORE INTO ops_money_history SELECT ?,?,?,?,?,?,? FROM ops_order_money WHERE order_id=? AND version=?',
            )
            .bind(
              o.id + ':' + (version + 1),
              o.id,
              u.id,
              JSON.stringify(prior || {}),
              JSON.stringify(next),
              note,
              time,
              o.id,
              version + 1,
            ),
        ]);
        need(
          Number(saved[0].meta?.changes ?? saved[0].changes) === 1,
          'عدّل موظف آخر الأرقام؛ أعد التحميل',
          409,
        );
        await audit(u, 'actual_cost_recorded', o.id);
        return json({ ok: true });
      }
      const mh = suffix.match(/^\/money\/([a-f0-9-]{36})$/);
      if (mh && req.method === 'GET') {
        need(canManage(u, 'reports'), 'لا تملك صلاحية التقارير', 403);
        return json({
          current: await first(
            'SELECT manual_cost_units,manual_fee_cents,note,version FROM ops_order_money WHERE order_id=?',
            mh[1],
          ),
          history: await all(
            'SELECT h.*,u.name AS author FROM ops_money_history h LEFT JOIN users u ON u.id=h.actor WHERE h.order_id=? ORDER BY h.created_at DESC LIMIT 50',
            mh[1],
          ),
        });
      }
      if (suffix === '/bulk-products' && req.method === 'POST') {
        need(canManage(u, 'products'), 'لا تملك صلاحية المنتجات', 403);
        return json(await bulk(b, u));
      }
      if (suffix === '/health' && req.method === 'GET') {
        need(canManage(u, 'products') || canManage(u, 'suppliers'), 'غير مسموح', 403);
        return json(await health());
      }
      if (suffix === '/acknowledge' && req.method === 'POST') {
        need(canManage(u, 'suppliers'), 'غير مسموح', 403);
        need(typeof b.id === 'string' && b.id.length <= 100, 'معرّف غير صالح');
        await run('UPDATE supplier_product_events SET acknowledged_at=? WHERE id=?', stamp(), b.id);
        return json({ ok: true });
      }
      if (suffix === '/launch' && req.method === 'GET') {
        need(canManage(u, 'settings'), 'لا تملك صلاحية الإعدادات', 403);
        return json(await launch());
      }
      if (suffix === '/config' && req.method === 'PUT') {
        need(u.role === 'owner', 'للمالك فقط', 403);
        await run(
          'UPDATE ops_config SET delay_minutes=?,low_balance_cents=? WHERE id=1',
          integer(b.delay_minutes, 5, 1440),
          integer(b.low_balance_cents, 0, 100000000),
        );
        await audit(u, 'ops_config_updated', 'store');
        return json({ ok: true });
      }
      throw new OpsError(404, 'المسار غير موجود');
    } catch (e) {
      if (!(e instanceof OpsError)) console.error('Operations failed', e?.message);
      return json(
        { error: e instanceof OpsError ? e.message : 'تعذّر تحميل أدوات المتابعة' },
        e instanceof OpsError ? e.status : 500,
      );
    }
  }
  return { handle, reconcile, observe };
}
