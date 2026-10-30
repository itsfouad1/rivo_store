const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const api = async (path, method = 'GET', body) => {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'تعذّر الاتصال');
  return d;
};
const localDate = (d) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
export async function renderGrowth(view) {
  const root = document.getElementById('dash-view');
  if (location.hash.slice(1) !== view) return;
  root.innerHTML = '<section class="panel">جاري التحميل…</section>';
  try {
    if (view === 'content') return await content(root);
    if (view === 'coupons') return await coupons(root);
    if (view === 'reviews') return await reviews(root);
    if (view === 'email') return await email(root);
  } catch (e) {
    if (root.isConnected)
      root.innerHTML = '<section class="panel">' + esc(e.message) + '</section>';
  }
}
async function content(root) {
  const { items } = await api('/api/admin/content');
  if (!root.isConnected) return;
  const missing = (p) =>
    [
      'image_url',
      'region',
      'description',
      'activation_instructions',
      'delivery_estimate',
      'purchase_notice',
    ].filter((k) => !p[k]?.trim());
  const titles = {
    image_url: 'الصورة',
    region: 'منطقة التفعيل',
    description: 'الوصف',
    activation_instructions: 'التعليمات',
    delivery_estimate: 'مدة التنفيذ',
    purchase_notice: 'تنبيه الشراء',
  };
  root.innerHTML = `<div class="page-head"><div><h2>جودة محتوى المنتجات</h2><p>أكمل المعلومات الفعلية من المورد؛ لا تضف مددًا أو مناطق غير مؤكدة.</p></div></div><div class="stats"><div class="stat"><span>منتجات تحتاج مراجعة</span><strong>${items.filter((p) => missing(p).length).length}</strong></div><div class="stat"><span>منتجات مكتملة الحقول</span><strong>${items.filter((p) => !missing(p).length).length}</strong></div></div><section class="panel"><div class="growth-fields"><label>ابحث<input id="content-search" type="search" placeholder="الاسم أو التصنيف أو المنطقة"></label><label>النقص<select id="content-filter"><option value="">كل المنتجات</option>${Object.entries(
    titles,
  )
    .map(([v, t]) => `<option value="${v}">ينقص ${t}</option>`)
    .join(
      '',
    )}</select></label></div><p class="helper">اكتمال الحقول لا يعني التحقق من صحتها. الصور والحقوق والمناطق والتعليمات مسؤولية مراجعة المتجر.</p><div id="content-list"></div></section><section id="content-editor" class="panel" hidden></section>`;
  const list = () => {
    const term = root.querySelector('#content-search').value.toLowerCase(),
      field = root.querySelector('#content-filter').value;
    root.querySelector('#content-list').innerHTML =
      items
        .filter(
          (p) =>
            (!field || !p[field]?.trim()) &&
            [p.name, p.category, p.region].join(' ').toLowerCase().includes(term),
        )
        .map(
          (p) =>
            `<div class="content-audit-row"><div><strong>${esc(p.name)}</strong><small>${esc(p.category)} · ${esc(p.region || 'المنطقة غير محددة')} · ${esc(p.status)}</small><p>${
              missing(p)
                .map((k) => `<span class="ops-tag">${titles[k]}</span>`)
                .join('') || '<span class="badge green">الحقول مكتملة</span>'
            }</p></div><button class="secondary" data-content-id="${esc(p.id)}">راجع وعدّل</button></div>`,
        )
        .join('') || '<p>لا توجد نتائج</p>';
    root
      .querySelectorAll('[data-content-id]')
      .forEach((b) => (b.onclick = () => edit(items.find((p) => p.id === b.dataset.contentId))));
  };
  root.querySelector('#content-search').oninput = list;
  root.querySelector('#content-filter').onchange = list;
  list();
  function edit(p) {
    const target = root.querySelector('#content-editor');
    target.hidden = false;
    target.innerHTML = `<h3>${esc(p.name)}</h3><form id="content-edit-form"><div class="form-grid"><label class="field">الاسم الواضح للفئة<input name="name" maxlength="120" required value="${esc(p.name)}"></label><label class="field">المنطقة المدعومة<input name="region" maxlength="100" value="${esc(p.region)}"></label><label class="field full">رابط الصورة<input name="image_url" maxlength="1000" value="${esc(p.image_url)}" placeholder="https://… أو /media/…"><small>استخدم صورة موثوقة تملك حق عرضها، أو ارفعها من محرر المنتج الأساسي.</small></label>${[
      ['description', 'الوصف', 3000],
      ['activation_instructions', 'خطوات التفعيل أو الاستخدام', 3000],
      ['delivery_estimate', 'وقت التنفيذ الفعلي المتوقع', 200],
      ['purchase_notice', 'قيود وتنبيه قبل الشراء', 1500],
    ]
      .map(
        ([k, t, max]) =>
          `<label class="field full">${t}<textarea name="${k}" maxlength="${max}">${esc(p[k])}</textarea></label>`,
      )
      .join(
        '',
      )}</div><button class="secondary" id="content-template" type="button">ضع قالب مراجعة عام للتعليمات</button><p class="helper">القالب لا يشرح آلية المورد تلقائيًا. عدّله حسب الخدمة قبل الحفظ. مدة التنفيذ والصورة لا تُملآن تلقائيًا.</p><p role="alert" data-content-error class="form-error"></p><button class="primary" type="submit">حفظ محتوى المنتج</button></form>`;
    target.scrollIntoView({ block: 'start' });
    const form = target.querySelector('form');
    target.querySelector('#content-template').onclick = () => {
      if (
        form.elements.activation_instructions.value &&
        !confirm('استبدال النص الحالي بقالب قابل للمراجعة؟')
      )
        return;
      form.elements.activation_instructions.value =
        (p.region
          ? 'تأكد أن منطقة حسابك متوافقة مع ' + p.region + '.\n'
          : 'تحقق من المنطقة المدعومة مع المتجر قبل الشراء.\n') +
        (p.player_id_required
          ? 'راجع معرّف اللاعب أو اسم الحساب عند الطلب. لا تشارك كلمة المرور أو رمز التحقق.\n'
          : 'راجع فئة المنتج وطريقة استلامه قبل إكمال الطلب.\n') +
        'تابع حالة الطلب وتعليماته من صفحة طلبك بعد تأكيد الدفع.';
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const b = { ...Object.fromEntries(new FormData(form)), updated_at: p.updated_at };
      form.querySelectorAll('input,textarea,button').forEach((el) => (el.disabled = true));
      try {
        const r = await api('/api/admin/content/' + encodeURIComponent(p.id), 'PUT', b);
        Object.assign(p, b, { updated_at: r.updated_at });
        target.querySelector('[data-content-error]').textContent =
          'تم الحفظ؛ راجع النتيجة في صفحة المنتج';
        list();
      } catch (err) {
        target.querySelector('[data-content-error]').textContent = err.message;
      } finally {
        form.querySelectorAll('input,textarea,button').forEach((el) => (el.disabled = false));
      }
    };
  }
}
async function coupons(root) {
  const [data, catalog] = await Promise.all([
    api('/api/admin/coupons'),
    api('/api/store?currency=USD'),
  ]);
  if (!root.isConnected) return;
  const products = catalog.products;
  root.innerHTML = `<div class="page-head"><div><h2>الكوبونات وحدود التسعير</h2><p>خصومات بالنسبة المئوية، تُحسب وتُراجع على الخادم.</p></div></div><div class="warning-box">الاستخدام يُحجز عند إنشاء الطلب حتى لو لم يُدفع أو كان تجريبيًا. كل زبون يستخدم الكود مرة واحدة، ولا يُعاد الاستخدام تلقائيًا بعد الإلغاء. الحد الأدنى يحمي تسعير المنتج لكنه لا يضمن صافي الربح بعد الرسوم والضرائب.</div><section class="panel"><h3>الكوبونات</h3>${data.items.map((c) => `<div class="content-audit-row"><div><strong>${esc(c.code)} — ${c.percent_bps / 100}%</strong><small>${c.enabled ? 'مفعّل' : 'متوقف'} · ${c.used}/${c.max_uses} استخدام · ينتهي ${esc(new Date(c.expires_at).toLocaleString('ar'))}</small></div><button class="secondary" data-coupon="${esc(c.code)}" data-enabled="${c.enabled}">${c.enabled ? 'إيقاف' : 'تفعيل'}</button></div>`).join('') || '<p>لا توجد كوبونات بعد</p>'}</section><div class="two-col"><section class="panel"><h3>كوبون جديد</h3><form id="coupon-form"><div class="form-grid"><label class="field">الكود<input name="code" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" maxlength="32" required dir="ltr" placeholder="RIVO10"></label><label class="field">نسبة الخصم %<input name="percent" type="number" min="1" max="50" step="1" value="10" required></label><label class="field">حد السلة الأدنى USD<input name="minimum" type="number" min="0" max="1000000" step="0.01" value="0" required></label><label class="field">هامش فوق تكلفة المورد %<input name="margin" type="number" min="0" max="100" step="1" value="10" required></label><label class="field">عدد الاستخدامات الكلي<input name="uses" type="number" min="1" max="100000" step="1" value="100" required></label><label class="field">يبدأ<input name="start" type="datetime-local" value="${localDate(new Date())}" required></label><label class="field full">ينتهي<input name="end" type="datetime-local" value="${localDate(new Date(Date.now() + 7 * 86400000))}" required></label><label class="field full">المنتجات المشمولة — اختياري<select name="products" multiple size="7">${products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.region)}</option>`).join('')}</select><small>عدم التحديد يشمل السلة كلها. أي منتج غير مجهّز بحد تسعير آمن يمنع تطبيق الخصم.</small></label></div><p class="form-error" data-coupon-error role="alert"></p><button class="primary" type="submit">إنشاء الكوبون</button></form></section><section class="panel"><h3>حد التسعير الأدنى للمنتج</h3><p class="helper">للمنتج اليدوي أدخل أقل سعر بيع مسموح بالدولار للوحدة، شاملاً التكلفة والهامش والرسوم التي حسبتها. منتجات FoxReload تستخدم الأعلى بين هذا الحد وتكلفة المورد المحدثة مضافًا إليها هامش الكوبون.</p><form id="floor-form"><label class="field">المنتج<select name="product_id" required>${products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><label class="field">أقل سعر بيع مسموح USD / وحدة<input name="floor" type="number" min="0.01" max="1000000" step="0.01" required></label><p class="helper" id="floor-current"></p><p class="form-error" data-floor-error role="alert"></p><button class="primary" type="submit">حفظ الحد</button></form></section></div><p class="helper" id="coupon-global-error" role="status"></p>`;
  root.querySelectorAll('[data-coupon]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api('/api/admin/coupons/' + encodeURIComponent(b.dataset.coupon), 'PUT', {
            enabled: b.dataset.enabled !== '1',
          });
          renderGrowth('coupons');
        } catch (e) {
          root.querySelector('#coupon-global-error').textContent = e.message;
          b.disabled = false;
        }
      }),
  );
  const form = root.querySelector('#coupon-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    e.submitter.disabled = true;
    try {
      await api('/api/admin/coupons', 'POST', {
        code: f.get('code'),
        percent_bps: Math.round(Number(f.get('percent')) * 100),
        min_usd_cents: Math.round(Number(f.get('minimum')) * 100),
        min_margin_bps: Math.round(Number(f.get('margin')) * 100),
        max_uses: Number(f.get('uses')),
        starts_at: new Date(f.get('start')).toISOString(),
        expires_at: new Date(f.get('end')).toISOString(),
        product_ids: f.getAll('products'),
      });
      renderGrowth('coupons');
    } catch (err) {
      form.querySelector('[data-coupon-error]').textContent = err.message;
      e.submitter.disabled = false;
    }
  };
  const floor = root.querySelector('#floor-form');
  const show = () => {
    const row = data.floors.find((r) => r.product_id === floor.elements.product_id.value);
    root.querySelector('#floor-current').textContent = row
      ? 'الحد المحفوظ: ' + (row.floor_usd_cents / 100).toFixed(2) + ' USD'
      : 'لا يوجد حد يدوي محفوظ';
  };
  floor.elements.product_id.onchange = show;
  show();
  floor.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(floor);
    e.submitter.disabled = true;
    try {
      const b = {
        product_id: f.get('product_id'),
        floor_usd_cents: Math.round(Number(f.get('floor')) * 100),
      };
      await api('/api/admin/price-floors', 'PUT', b);
      data.floors = data.floors.filter((x) => x.product_id !== b.product_id).concat(b);
      show();
      floor.querySelector('[data-floor-error]').textContent = 'تم حفظ الحد';
    } catch (err) {
      floor.querySelector('[data-floor-error]').textContent = err.message;
    } finally {
      e.submitter.disabled = false;
    }
  };
}
async function reviews(root) {
  const { items } = await api('/api/admin/reviews');
  if (!root.isConnected) return;
  root.innerHTML = `<div class="page-head"><div><h2>مراجعة تقييمات المشتريات</h2><p>انشر التقييمات المفيدة سواء كانت إيجابية أو سلبية. أخفِ البيانات الخاصة والإساءة والمحتوى غير المرتبط فقط.</p></div></div><section class="panel">${items.map((r) => `<article class="review-admin"><h3>${esc(r.product_name)} — ${r.stars}/5</h3><p class="helper">اسم العرض: ${esc(r.display_name)} · ${esc({ pending: 'بانتظار المراجعة', approved: 'منشور', rejected: 'غير منشور' }[r.status])} · الطلب ${esc(r.order_id)}</p><p class="order-note">${esc(r.body)}</p><div class="growth-actions"><button class="secondary" data-review="${esc(r.id)}" data-state="approved">نشر</button><button class="secondary" data-review="${esc(r.id)}" data-state="rejected">إخفاء</button><button class="secondary" data-review="${esc(r.id)}" data-state="pending">إرجاع للمراجعة</button></div></article>`).join('') || '<p>لا توجد تقييمات بعد</p>'}<p class="form-error" data-review-error role="alert"></p></section>`;
  root.querySelectorAll('[data-review]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api('/api/admin/reviews/' + encodeURIComponent(b.dataset.review), 'PUT', {
            status: b.dataset.state,
          });
          renderGrowth('reviews');
        } catch (e) {
          root.querySelector('[data-review-error]').textContent = e.message;
          b.disabled = false;
        }
      }),
  );
}
async function email(root) {
  const data = await api('/api/admin/email');
  if (!root.isConnected) return;
  const labels = {
    pending: 'بانتظار المعالجة',
    sending: 'جاري الإرسال',
    accepted: 'قبله مزوّد البريد',
    review: 'يحتاج مراجعة',
    cancelled: 'ملغى',
  };
  root.innerHTML = `<div class="page-head"><div><h2>إشعارات البريد</h2><p>إرسال تحديثات الطلبات بعد موافقة الزبون وتأكيد بريده.</p></div></div><section class="panel"><h3>${data.ready ? 'الإرسال مهيّأ' : 'الإرسال غير مهيّأ أو متوقف'}</h3><p class="helper">حالة قبول الرسالة لا تعني تأكيد وصولها لصندوق الوارد. لا تُرسل الأكواد أو معرّفات اللاعب في الرسائل.</p><ul>${Object.entries(
    {
      flag: 'EMAIL_ENABLED=true',
      key: 'RESEND_API_KEY — مفتاح سري',
      from: 'EMAIL_FROM — بريد من نطاق موثّق',
      site: 'PUBLIC_SITE_URL — رابط المتجر HTTPS',
    },
  )
    .map(([k, v]) => `<li>${data.requirements[k] ? '✓' : '○'} ${esc(v)}</li>`)
    .join(
      '',
    )}</ul><p>السماح من الإدارة: ${data.enabled ? 'مفعّل' : 'متوقف'}</p><button class="primary" id="email-toggle">${data.enabled ? 'إيقاف إرسال البريد' : 'السماح بإرسال البريد بعد اكتمال الإعداد'}</button><p role="status" id="email-message"></p><p class="warning-box">تفعيل الزر وحده لا يكفي. أضف إعدادات الخادم الواردة في دليل التحديث وفعّل النطاق لدى المزوّد. الرسائل تُعالج كل 15 دقيقة، بحد أقصى 100 محاولة يوميًا في هذا النظام.</p></section><section class="panel"><h3>الطابور</h3><div class="growth-actions">${data.queue.map((x) => `<span class="ops-tag">${esc(labels[x.status] || x.status)}: ${x.count}</span>`).join('') || '<p>لا توجد رسائل</p>'}</div>${data.recent.map((x) => `<div class="content-audit-row"><div><strong>${esc(x.kind === 'confirmation' ? 'تأكيد بريد' : 'تحديث طلب')}</strong><small>${esc(labels[x.status] || x.status)} · ${x.attempts} محاولة · ${esc(x.created_at)}</small>${x.error ? '<p class="form-error">' + esc(x.error) + '</p>' : ''}</div></div>`).join('')}</section>`;
  root.querySelector('#email-toggle').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api('/api/admin/email', 'PUT', { enabled: !data.enabled });
      renderGrowth('email');
    } catch (err) {
      root.querySelector('#email-message').textContent = err.message;
      e.currentTarget.disabled = false;
    }
  };
}
