import { groupProducts, kindLabels } from './product-groups.js';
import { selectHomeGroups } from './home-content.js';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const request = async (path, method = 'GET', body) => {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'تعذّر الاتصال');
  return d;
};
export async function renderHomepage() {
  const root = document.getElementById('dash-view');
  if (location.hash.slice(1) !== 'homepage') return;
  root.innerHTML = '<section class="panel"><p>جاري تحميل تصميم الرئيسية…</p></section>';
  let draft, groups, store;
  try {
    const [home, catalog, definitions] = await Promise.all([
      request('/api/admin/homepage'),
      request('/api/store?currency=USD'),
      request('/api/collections'),
    ]);
    draft = home;
    store = catalog.settings;
    groups = groupProducts(catalog.products, definitions.groups, {
      gatewayReady: catalog.gatewayReady,
      whatsapp: store.whatsapp,
    });
    if (document.getElementById('dash-view') !== root || location.hash.slice(1) !== 'homepage')
      return;
    draw();
  } catch (e) {
    root.innerHTML = '<section class="panel">' + esc(e.message) + '</section>';
    return;
  }
  function groupFor(id) {
    const resolved = draft.resolved?.find((r) => r.reference === id)?.product_id;
    return groups.find((g) => g.variants.some((p) => p.id === id || p.id === resolved));
  }
  function field(label, name, value, max = 180, placeholder = '') {
    return `<label class="field">${label}<input name="${name}" value="${esc(value)}" maxlength="${max}" placeholder="${esc(placeholder)}"></label>`;
  }
  function collect() {
    const form = root.querySelector('#home-form');
    if (!form) return;
    const fd = new FormData(form);
    for (const k of ['title', 'accent', 'description', 'button', 'link'])
      draft.hero[k] = fd.get('hero-' + k) || '';
    draft.hero.enabled = fd.has('hero-enabled');
    draft.featured.enabled = fd.has('featured-enabled');
    draft.featured.mode = fd.get('featured-mode');
    draft.featured.title = fd.get('featured-title');
    draft.featured.description = fd.get('featured-description');
    draft.featured.limit = Number(fd.get('featured-limit'));
    draft.banners = draft.banners.map((b) => ({
      ...b,
      enabled: fd.has(b.id + '-enabled'),
      ...Object.fromEntries(
        ['title', 'text', 'button', 'link', 'image', 'theme'].map((k) => [
          k,
          fd.get(b.id + '-' + k) || '',
        ]),
      ),
    }));
  }
  function draw() {
    root.innerHTML = `<div class="page-head"><div><h2>تصميم الصفحة الرئيسية</h2><p>عدّل الواجهة، اختار المجموعات المميزة ورتّب البنرات.</p></div><a class="secondary" href="/" target="_blank" rel="noopener">فتح الرئيسية ↗</a></div><form id="home-form" class="home-editor"><div class="home-editor-fields"><section class="panel"><h3>الواجهة الرئيسية — الهيرو</h3><label class="check-field"><span><input type="checkbox" name="hero-enabled" ${draft.hero.enabled ? 'checked' : ''}> إظهار الهيرو</span></label><div class="form-grid">${field('العنوان', 'hero-title', draft.hero.title, 180, store.heroTitle)}${field('النص المميز بالبنفسجي', 'hero-accent', draft.hero.accent, 180, store.heroAccent)}<label class="field full">الوصف<textarea name="hero-description" maxlength="600" placeholder="${esc(store.heroDescription)}">${esc(draft.hero.description)}</textarea></label>${field('نص الزر', 'hero-button', draft.hero.button, 50)}${field('رابط الزر داخل المتجر', 'hero-link', draft.hero.link, 1000)}</div><p class="helper">هذه الحقول تتقدم على نصوص الهيرو الموجودة في إعدادات المتجر. اترك النص فارغًا لاستخدام النص الأساسي.</p></section><section class="panel"><h3>المنتجات المميزة</h3><label class="check-field"><span><input name="featured-enabled" type="checkbox" ${draft.featured.enabled ? 'checked' : ''}> إظهار القسم</span></label><div class="form-grid">${field('عنوان القسم', 'featured-title', draft.featured.title, 100)}${field('وصف مختصر', 'featured-description', draft.featured.description, 250)}<label class="field">طريقة الاختيار<select name="featured-mode"><option value="auto" ${draft.featured.mode === 'auto' ? 'selected' : ''}>تلقائي — المتاح للطلب أولًا</option><option value="manual" ${draft.featured.mode === 'manual' ? 'selected' : ''}>يدوي — حسب اختياري وترتيبي</option></select></label><label class="field">عدد المجموعات<input type="number" name="featured-limit" min="1" max="12" step="1" value="${draft.featured.limit}" required></label></div><div id="home-manual"><label class="field">أضف لعبة أو منصة<select id="home-group"><option value="">اختار مجموعة منشورة…</option>${groups.map((g) => `<option value="${esc(g.representative.id)}">${esc(g.title)} — ${esc(kindLabels[g.kind])} (${g.variants.length} فئة)</option>`).join('')}</select></label><button class="secondary" id="home-add-group" type="button">إضافة للاختيارات</button><div class="home-selected">${
      draft.featured.product_ids
        .map((id, i) => {
          const g = groupFor(id);
          return `<div class="home-sort-row"><strong>${i + 1}. ${esc(g?.title || 'منتج محذوف أو غير منشور — سيُخفى من الرئيسية')}</strong><div><button type="button" data-move-group="${i}" data-direction="-1" ${i === 0 ? 'disabled' : ''} aria-label="رفع المجموعة ${i + 1}">↑</button><button type="button" data-move-group="${i}" data-direction="1" ${i === draft.featured.product_ids.length - 1 ? 'disabled' : ''} aria-label="تنزيل المجموعة ${i + 1}">↓</button><button type="button" data-remove-group="${i}" aria-label="إزالة المجموعة ${i + 1}">×</button></div></div>`;
        })
        .join('') ||
      '<p class="helper">لم تختَر مجموعات بعد. الوضع اليدوي الفارغ لا يعرض منتجات تلقائية.</p>'
    }</div></div><p class="helper">الترتيب من الأعلى للأسفل هو ترتيب العرض. إذا تغيّر تجميع منتج، يتبع الاختيار مجموعته الجديدة. المجموعة التي لا تضم منتجات منشورة تُخفى. لا تُضاف مجموعات لتعويض الاختيارات المخفية في الوضع اليدوي.</p></section><section class="panel"><div class="ops-row"><h3>البنرات (${draft.banners.length}/3)</h3><button type="button" class="secondary" id="add-home-banner" ${draft.banners.length >= 3 ? 'disabled' : ''}>+ بنر</button></div><p class="helper">تظهر تحت الهيرو. روابط الأزرار داخل المتجر فقط، مثل /products.html أو رابط صفحة منتج.</p>${draft.banners.map((b, i) => `<div class="home-banner-editor"><div class="home-sort-row"><strong>بنر ${i + 1}</strong><div><button type="button" data-move-banner="${i}" data-direction="-1" ${i === 0 ? 'disabled' : ''} aria-label="رفع البنر ${i + 1}">↑</button><button type="button" data-move-banner="${i}" data-direction="1" ${i === draft.banners.length - 1 ? 'disabled' : ''} aria-label="تنزيل البنر ${i + 1}">↓</button><button type="button" data-remove-banner="${i}" aria-label="حذف البنر ${i + 1}">×</button></div></div><label class="check-field"><span><input type="checkbox" name="${b.id}-enabled" ${b.enabled ? 'checked' : ''}> إظهار البنر</span></label><div class="form-grid">${field('العنوان', b.id + '-title', b.title, 100)}<label class="field">اللون<select name="${b.id}-theme"><option value="purple" ${b.theme === 'purple' ? 'selected' : ''}>بنفسجي</option><option value="cyan" ${b.theme === 'cyan' ? 'selected' : ''}>سماوي</option></select></label><label class="field full">الوصف<textarea name="${b.id}-text" maxlength="300">${esc(b.text)}</textarea></label>${field('نص الزر', b.id + '-button', b.button, 50)}${field('رابط الزر', b.id + '-link', b.link, 1000)}<label class="field full">رابط الصورة — اختياري<input name="${b.id}-image" value="${esc(b.image)}" maxlength="1000" placeholder="https://… أو /media/…"><small>يمكن استخدام رابط صورة رفعتها سابقًا من إدارة المنتجات. البنر يعمل بدون صورة.</small></label></div></div>`).join('') || '<p class="helper">لا توجد بنرات. التصميم الأساسي يبقى كما هو.</p>'}</section><p class="form-error" id="home-error" role="alert"></p><div class="home-save"><button class="primary" type="submit">حفظ الرئيسية</button><button class="secondary" id="reload-home" type="button">إعادة تحميل المحفوظ</button><span class="helper" id="home-save-state">التعديلات تظهر للزبائن بعد الحفظ وتحديث الصفحة.</span></div></div><aside class="home-preview panel"><h3>معاينة قبل الحفظ</h3><p class="helper">معاينة مختصرة للمحتوى والترتيب.</p><div id="home-preview-content"></div></aside></form>`;
    const form = root.querySelector('#home-form');
    form.oninput = () => {
      collect();
      preview();
    };
    form.onchange = () => {
      collect();
      preview();
    };
    root.querySelector('#home-add-group').onclick = () => {
      collect();
      const id = root.querySelector('#home-group').value,
        g = groups.find((g) => g.variants.some((p) => p.id === id));
      if (!g) return;
      const exists = draft.featured.product_ids.some((id) => groupFor(id)?.id === g.id);
      if (exists) {
        error('المجموعة موجودة باختياراتك');
        return;
      }
      if (draft.featured.product_ids.length >= 12) {
        error('الحد الأقصى 12 مجموعة');
        return;
      }
      draft.featured.product_ids.push(id);
      draw();
    };
    root.querySelectorAll('[data-remove-group]').forEach(
      (b) =>
        (b.onclick = () => {
          collect();
          draft.featured.product_ids.splice(Number(b.dataset.removeGroup), 1);
          draw();
        }),
    );
    root.querySelectorAll('[data-move-group]').forEach(
      (b) =>
        (b.onclick = () => {
          collect();
          move(
            draft.featured.product_ids,
            Number(b.dataset.moveGroup),
            Number(b.dataset.direction),
          );
          draw();
        }),
    );
    root.querySelector('#add-home-banner').onclick = () => {
      collect();
      draft.banners.push({
        id:
          'b-' +
          Array.from(crypto.getRandomValues(new Uint8Array(12)), (v) =>
            v.toString(16).padStart(2, '0'),
          ).join(''),
        enabled: true,
        theme: 'purple',
        title: 'جولة جديدة مع ريفو',
        text: 'اكتشف الألعاب والبطاقات الرقمية.',
        button: 'تصفح المنتجات',
        link: '/products.html',
        image: '',
      });
      draw();
    };
    root.querySelectorAll('[data-remove-banner]').forEach(
      (b) =>
        (b.onclick = () => {
          collect();
          draft.banners.splice(Number(b.dataset.removeBanner), 1);
          draw();
        }),
    );
    root.querySelectorAll('[data-move-banner]').forEach(
      (b) =>
        (b.onclick = () => {
          collect();
          move(draft.banners, Number(b.dataset.moveBanner), Number(b.dataset.direction));
          draw();
        }),
    );
    root.querySelector('#reload-home').onclick = () => {
      if (confirm('تجاهل التعديلات غير المحفوظة وإعادة تحميل المحفوظ؟')) renderHomepage();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      collect();
      const button = e.submitter;
      button.disabled = true;
      form.inert = true;
      error('');
      try {
        draft = await request('/api/admin/homepage', 'PUT', draft);
        if (document.getElementById('dash-view') !== root) return;
        draw();
        root.querySelector('#home-save-state').textContent =
          'تم الحفظ. حدّث الرئيسية لرؤية التعديلات.';
      } catch (e) {
        error(e.message);
        form.inert = false;
        button.disabled = false;
      }
    };
    preview();
  }
  function error(t) {
    root.querySelector('#home-error').textContent = t;
  }
  function move(list, i, direction) {
    const j = i + direction;
    if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
  }
  function preview() {
    root.querySelector('#home-manual').hidden = draft.featured.mode !== 'manual';
    const selected = selectHomeGroups(groups, {
      ...draft.featured,
      product_ids: draft.featured.product_ids.map(
        (id) => draft.resolved?.find((r) => r.reference === id)?.product_id || id,
      ),
    });
    root.querySelector('#home-preview-content').innerHTML =
      (draft.hero.enabled
        ? `<div class="home-preview-hero"><small>RIVO | ريفو</small><h2>${esc(draft.hero.title || store.heroTitle)}<br><span>${esc(draft.hero.accent || store.heroAccent)}</span></h2><p>${esc(draft.hero.description || store.heroDescription)}</p><b>${esc(draft.hero.button)} ←</b></div>`
        : '<p class="helper">الهيرو مخفي</p>') +
      draft.banners
        .filter((b) => b.enabled)
        .map(
          (b) =>
            `<div class="home-preview-banner promo-${b.theme}"><strong>${esc(b.title)}</strong><p>${esc(b.text)}</p><small>${esc(b.button)} ←</small></div>`,
        )
        .join('') +
      (draft.featured.enabled
        ? `<h4>${esc(draft.featured.title)}</h4><p class="helper">${esc(draft.featured.description)}</p><ol>${selected.map((g) => `<li>${esc(g.title)}</li>`).join('')}</ol>${!selected.length ? '<p class="helper">لا توجد مجموعات مختارة متاحة للعرض</p>' : ''}`
        : '<p class="helper">قسم المنتجات المميزة مخفي</p>');
  }
}
