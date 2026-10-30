// Uses dashboard authentication, escaping and editor helpers.
function foxSavedNote(item, schema) {
  const note = Object.fromEntries(schema.required.map((k) => [k, '']));
  if (item.input_source !== 'item' || !item.player_id || schema.required.length !== 1) return note;
  const key = schema.required[0];
  if (!/^(player_?id|user_?id|uid|login|account_?id|account_?name)$/i.test(key)) return note;
  const type = schema.types?.[key];
  if (type === 'integer' || type === 'number') {
    if (/^(0|[1-9]\d*)$/.test(item.player_id) && Number.isSafeInteger(Number(item.player_id)))
      note[key] = Number(item.player_id);
  } else if (!type || type === 'string') note[key] = item.player_id;
  return note;
}
function foxNewPager() {
  return { page: 1, cursors: { 1: '' }, next: null };
}
function foxRemember(pager, page, next) {
  if (pager.cursors[page + 1] !== next)
    for (const n of Object.keys(pager.cursors)) if (Number(n) > page) delete pager.cursors[n];
  if (next) pager.cursors[page + 1] = next;
  pager.page = page;
  pager.next = next;
}
let foxState = null,
  foxCatalog = [],
  foxCategory = '';
const foxUI = {
  tab: 'catalog',
  epoch: 0,
  size: 20,
  stock: false,
  query: '',
  categoryName: 'كل التصنيفات',
  catalog: foxNewPager(),
  categories: foxNewPager(),
  trail: [],
  categoryQuery: '',
  categoryRows: [],
  linkedQuery: '',
  linkedType: 'all',
  linkedPage: 1,
};
const foxType = (v) =>
  ({ code: 'كود رقمي', direct_topup: 'شحن مباشر', login_topup: 'شحن بدخول الحساب', esim: 'eSIM' })[
    v
  ] || v;
const foxError = (target, error, retry) => {
  const el = $(target);
  if (!el) return;
  el.innerHTML =
    '<div class="fox-message is-error" role="alert"><b>تعذّر تحميل البيانات</b><p>' +
    esc(error.message) +
    '</p><button class="secondary" type="button" data-retry>أعد المحاولة</button></div>';
  el.querySelector('[data-retry]').onclick = retry;
};
function foxPages(pager, label) {
  const known = Object.keys(pager.cursors)
      .map(Number)
      .sort((a, b) => a - b),
    last = known.at(-1) || 1;
  const pages = known.filter((n) => n === 1 || n === last || Math.abs(n - pager.page) <= 2);
  let prev = 0;
  return (
    '<nav class="fox-pagination" aria-label="' +
    esc(label) +
    '"><button class="secondary" data-page="' +
    (pager.page - 1) +
    '" ' +
    (pager.page === 1 ? 'disabled' : '') +
    '>السابق</button><div>' +
    pages
      .map((n) => {
        const gap = n - prev > 1 ? '<span>…</span>' : '';
        prev = n;
        return (
          gap +
          '<button class="' +
          (n === pager.page ? 'primary' : 'secondary') +
          '" data-page="' +
          n +
          '" ' +
          (n === pager.page ? 'aria-current="page"' : '') +
          '>' +
          n +
          '</button>'
        );
      })
      .join('') +
    '</div><button class="secondary" data-page="' +
    (pager.page + 1) +
    '" ' +
    (!pager.next ? 'disabled' : '') +
    '>التالي</button><small>صفحة ' +
    pager.page +
    ' · تُضاف الأرقام مع التصفّح</small></nav>'
  );
}
async function foxView() {
  const epoch = ++foxUI.epoch;
  $('dash-view').innerHTML =
    '<section class="panel"><h2>FoxReload</h2><p role="status">جاري تحميل لوحة المورد…</p></section>';
  try {
    const state = await api('/api/admin/foxreload/status');
    if (current !== 'foxreload' || epoch !== foxUI.epoch) return;
    foxState = state;
    $('dash-view').innerHTML =
      `<div class="fox-workspace"><div class="page-head"><div><span class="fox-eyebrow">الموردون / FoxReload</span><h2>إدارة المورد</h2><p>تصفّح الكتالوج، راجع الفئات، وتحكّم بمنتجاتك المربوطة.</p></div><button class="secondary" id="fox-refresh">تحديث اللوحة</button></div><div class="fox-stats"><div><small>مفتاح API</small><strong>${state.configured ? 'مضاف' : 'غير مضاف'}</strong></div><div><small>منتجات مربوطة</small><strong>${state.links.length}</strong></div><div><small>التنفيذ الحقيقي</small><strong>${state.liveEnabled ? 'مفعّل' : 'متوقف'}</strong></div><div><small>سر الإشعارات</small><strong>${state.webhookConfigured ? 'مضاف' : 'غير مضاف'}</strong></div></div><nav class="fox-tabs" aria-label="أقسام المورد">${[
        ['catalog', 'كتالوج المورد'],
        ['categories', 'التصنيفات'],
        ['linked', 'المنتجات المربوطة'],
        ['connection', 'الربط والرصيد'],
      ]
        .map(([id, label]) => '<button type="button" data-tab="' + id + '">' + label + '</button>')
        .join('')}</nav><div id="fox-body"></div></div>`;
    $('fox-refresh').onclick = foxView;
    document
      .querySelectorAll('[data-tab]')
      .forEach((b) => (b.onclick = () => foxTab(b.dataset.tab)));
    foxTab(foxUI.tab);
  } catch (e) {
    if (current === 'foxreload' && epoch === foxUI.epoch) foxError('dash-view', e, foxView);
  }
}
function foxTab(tab) {
  foxUI.tab = tab;
  ++foxUI.epoch;
  document.querySelectorAll('.fox-tabs button').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  if (tab === 'categories') foxCategoryPanel();
  else if (tab === 'linked') foxLinkedPanel();
  else if (tab === 'connection') foxConnection();
  else foxCatalogPanel();
}
function foxCatalogPanel() {
  $('fox-body').innerHTML =
    `<section class="panel"><div class="fox-section-head"><div><h3>كتالوج المورد</h3><p class="helper">التصنيف الحالي: <b id="fox-selected-category">${esc(foxUI.categoryName)}</b></p></div><button class="secondary" id="fox-browse-categories">اختيار تصنيف</button></div><form class="fox-filter-grid" id="fox-catalog-filter"><label class="field">تصنيف بالمعرّف أو slug<input name="category" value="${esc(foxCategory)}" maxlength="256" placeholder="اختياري — كل التصنيفات"></label><label class="field">عدد المنتجات بالصفحة<select name="size">${[20, 50, 100].map((n) => '<option ' + (n === foxUI.size ? 'selected' : '') + '>' + n + '</option>').join('')}</select></label><label class="check-field"><input name="stock" type="checkbox" ${foxUI.stock ? 'checked' : ''}> المتوفر عند المورد فقط</label><button class="primary" type="submit">تطبيق التصفية</button><button class="secondary" type="button" id="fox-all-products">كل المنتجات</button></form><div class="fox-table-tools"><label class="field">بحث ضمن هذه الصفحة<input id="fox-page-search" type="search" value="${esc(foxUI.query)}" placeholder="اسم المنتج أو معرّفه"></label><span class="helper" id="fox-page-count" role="status"></span></div><div id="fox-catalog-results"></div><div id="fox-catalog-pages"></div><p class="helper">الأسعار هنا هي تكلفة المورد بالدولار؛ سعر بيع الزبون يُحدّد عند الاستيراد. البحث أعلاه يفلتر الصفحة الحالية فقط.</p></section><details class="panel fox-direct"><summary>فتح منتج مباشرة بالمعرّف / إعداد فئات Steam</summary><p class="helper">استخدم معرّفًا حقيقيًا من حساب المورد. خدمة Steam USD الرئيسية:</p><code dir="ltr">product_01kjp6vtmjf8rbbxw88719wz3b</code><form id="fox-direct-form" class="fox-direct-form"><input name="id" aria-label="معرّف المنتج" placeholder="معرّف المنتج أو slug" maxlength="64" required><button class="secondary">عرض التفاصيل</button></form></details>`;
  $('fox-browse-categories').onclick = () => foxTab('categories');
  $('fox-all-products').onclick = () => {
    foxCategory = '';
    foxUI.categoryName = 'كل التصنيفات';
    foxUI.catalog = foxNewPager();
    foxUI.query = '';
    foxUI.stock = false;
    foxCatalogPanel();
  };
  $('fox-catalog-filter').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      category = String(f.get('category')).trim();
    if (category !== foxCategory) foxUI.categoryName = category || 'كل التصنيفات';
    foxCategory = category;
    foxUI.size = Number(f.get('size'));
    foxUI.stock = f.has('stock');
    foxUI.query = '';
    foxUI.catalog = foxNewPager();
    foxCatalogPanel();
  };
  $('fox-page-search').oninput = (e) => {
    foxUI.query = e.target.value;
    foxRenderProducts();
  };
  $('fox-direct-form').onsubmit = (e) => {
    e.preventDefault();
    foxDetails(e.target.elements.id.value.trim());
  };
  foxLoadProducts(foxUI.catalog.page);
}
async function foxLoadProducts(page) {
  const pager = foxUI.catalog;
  if (!Object.hasOwn(pager.cursors, page)) return;
  const epoch = ++foxUI.epoch,
    q = new URLSearchParams({ limit: String(foxUI.size) });
  if (pager.cursors[page]) q.set('cursor', pager.cursors[page]);
  if (foxCategory) q.set('categoryId', foxCategory);
  if (foxUI.stock) q.set('withStockOnly', 'true');
  foxCatalog = [];
  $('fox-page-search').disabled = true;
  $('fox-page-count').textContent = 'جاري التحميل…';
  $('fox-catalog-results').innerHTML =
    '<p class="fox-loading" role="status">جاري تحميل الصفحة ' + page + '…</p>';
  $('fox-catalog-pages').innerHTML = '';
  try {
    const r = await api('/api/admin/foxreload/catalog?' + q);
    if (current !== 'foxreload' || epoch !== foxUI.epoch) return;
    $('fox-page-search').disabled = false;
    foxCatalog = r.items;
    foxRemember(pager, page, r.nextCursor);
    foxRenderProducts();
    $('fox-catalog-pages').innerHTML = foxPages(pager, 'صفحات كتالوج المورد');
    $('fox-catalog-pages')
      .querySelectorAll('[data-page]')
      .forEach((b) => (b.onclick = () => foxLoadProducts(Number(b.dataset.page))));
  } catch (e) {
    if (current === 'foxreload' && epoch === foxUI.epoch) {
      $('fox-page-search').disabled = false;
      $('fox-page-count').textContent = 'تعذّر تحميل الصفحة';
      foxError('fox-catalog-results', e, () => foxLoadProducts(page));
    }
  }
}
function foxRenderProducts() {
  const target = $('fox-catalog-results');
  if (!target || !foxState) return;
  const query = foxUI.query.trim().toLocaleLowerCase(),
    rows = foxCatalog
      .map((p, index) => ({ p, index }))
      .filter(
        ({ p }) =>
          !query ||
          String(p.name + ' ' + p.id)
            .toLocaleLowerCase()
            .includes(query),
      );
  $('fox-page-count').textContent = rows.length + ' من ' + foxCatalog.length + ' منتج في الصفحة';
  target.innerHTML = rows.length
    ? '<div class="table-wrap"><table class="fox-products-table"><thead><tr><th>المنتج</th><th>التسليم</th><th>تكلفة الوحدة USD</th><th>المتوفر</th><th>الإجراء</th></tr></thead><tbody>' +
      rows
        .map(({ p, index }) => {
          const linked = foxState.links.filter((l) => l.remote_id === p.id),
            steam =
              p.deliveryType === 'direct_topup' &&
              /steam/i.test(p.name) &&
              p.requiredNoteFields?.includes('login'),
            supported =
              ['code', 'direct_topup'].includes(p.deliveryType) &&
              p.currency === 'usd' &&
              p.price !== null &&
              (p.orderMinQuantity ?? 1) <= 99;
          return (
            '<tr><td><strong>' +
            esc(p.name) +
            '</strong><details class="fox-id"><summary>معرّف المنتج</summary><code dir="ltr">' +
            esc(p.id) +
            '</code></details>' +
            (linked.length ? '<span class="fox-pill">مربوط · ' + linked.length + '</span>' : '') +
            '</td><td data-label="التسليم">' +
            esc(foxType(p.deliveryType)) +
            '</td><td data-label="تكلفة الوحدة USD"><span dir="ltr">' +
            esc(p.price ?? 'غير متاح') +
            '</span></td><td data-label="المتوفر">' +
            Number(p.quantity || 0).toLocaleString('en-US') +
            '</td><td><div class="fox-actions"><button class="secondary" data-detail="' +
            index +
            '">التفاصيل' +
            (steam ? ' / فئات Steam' : '') +
            '</button><button class="text-btn" data-import="' +
            index +
            '" ' +
            (linked.length || !supported || steam ? 'disabled' : '') +
            '>' +
            (steam
              ? 'أضف الفئة من التفاصيل'
              : linked.length
                ? 'مستورد'
                : supported
                  ? 'استيراد كمسودة'
                  : 'غير مدعوم للاستيراد') +
            '</button></div></td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>'
    : '<div class="fox-message"><b>' +
      esc(query ? 'لا توجد نتيجة بهذا البحث ضمن الصفحة' : 'لا توجد منتجات بهذه التصفية') +
      '</b><p>غيّر البحث أو التصنيف أو شرط التوفّر.</p></div>';
  target
    .querySelectorAll('[data-detail]')
    .forEach((b) => (b.onclick = () => foxDetails(foxCatalog[Number(b.dataset.detail)].id)));
  target
    .querySelectorAll('[data-import]')
    .forEach((b) => (b.onclick = () => foxImport(Number(b.dataset.import))));
}
function foxCategoryPanel() {
  const parent = foxUI.trail.at(-1);
  $('fox-body').innerHTML =
    `<section class="panel"><div class="fox-section-head"><div><h3>التصنيفات</h3><p class="helper">تصفّح التصنيفات وفروعها، أو ابحث بالاسم ضمن القائمة التي يرجعها المورد.</p></div><button class="secondary" id="fox-category-products">عرض منتجات ${parent ? esc(parent.name) : 'كل التصنيفات'}</button></div><nav class="fox-breadcrumb" aria-label="مسار التصنيف"><button data-level="0">كل التصنيفات</button>${foxUI.trail.map((c, i) => '<span>‹</span><button data-level="' + (i + 1) + '">' + esc(c.name) + '</button>').join('')}</nav><form class="fox-category-search" id="fox-category-search"><label class="field">بحث باسم التصنيف<input name="name" type="search" maxlength="128" value="${esc(foxUI.categoryQuery)}" placeholder="مثل Steam أو PlayStation"></label><button class="primary">بحث</button><button class="secondary" type="button" id="fox-category-reset">مسح البحث</button></form><div id="fox-category-results"></div><div id="fox-category-pages"></div></section>`;
  $('fox-category-search').onsubmit = (e) => {
    e.preventDefault();
    foxUI.categoryQuery = e.target.elements.name.value.trim();
    foxUI.categories = foxNewPager();
    foxLoadCategories(1);
  };
  $('fox-category-reset').onclick = () => {
    foxUI.categoryQuery = '';
    foxUI.categories = foxNewPager();
    foxCategoryPanel();
  };
  document.querySelectorAll('[data-level]').forEach(
    (b) =>
      (b.onclick = () => {
        foxUI.trail = foxUI.trail.slice(0, Number(b.dataset.level));
        foxUI.categoryQuery = '';
        foxUI.categories = foxNewPager();
        foxCategoryPanel();
      }),
  );
  $('fox-category-products').onclick = () => foxChooseCategory(parent);
  foxLoadCategories(foxUI.categories.page);
}
function foxChooseCategory(category) {
  foxCategory = category?.id || '';
  foxUI.categoryName = category?.name || 'كل التصنيفات';
  foxUI.catalog = foxNewPager();
  foxUI.query = '';
  foxTab('catalog');
}
async function foxLoadCategories(page) {
  const pager = foxUI.categories;
  if (!Object.hasOwn(pager.cursors, page)) return;
  const epoch = ++foxUI.epoch,
    q = new URLSearchParams({ limit: '20' }),
    parent = foxUI.trail.at(-1);
  if (parent) q.set('parentId', parent.id);
  if (foxUI.categoryQuery) q.set('name', foxUI.categoryQuery);
  if (pager.cursors[page]) q.set('cursor', pager.cursors[page]);
  $('fox-category-results').innerHTML =
    '<p class="fox-loading" role="status">جاري تحميل التصنيفات…</p>';
  $('fox-category-pages').innerHTML = '';
  try {
    const r = await api('/api/admin/foxreload/categories?' + q);
    if (current !== 'foxreload' || epoch !== foxUI.epoch) return;
    foxUI.categoryRows = r.items;
    foxRemember(pager, page, r.nextCursor);
    $('fox-category-results').innerHTML = r.items.length
      ? '<div class="fox-category-grid">' +
        r.items
          .map(
            (c, i) =>
              '<article class="fox-category-card"><div class="fox-category-symbol" aria-hidden="true">◇</div><h4>' +
              esc(c.name) +
              '</h4><p>' +
              Number(c.inStockCount || 0).toLocaleString('en-US') +
              ' منتج متوفر في الفرع</p><small dir="ltr">' +
              esc(c.slug || c.id) +
              '</small><div class="fox-actions"><button class="primary" data-category-products="' +
              i +
              '">عرض المنتجات</button><button class="secondary" data-category-children="' +
              i +
              '">التصنيفات الفرعية ←</button></div></article>',
          )
          .join('') +
        '</div>'
      : '<div class="fox-message"><b>لا توجد تصنيفات في هذه القائمة</b><p>' +
        esc(
          parent
            ? 'قد يكون هذا آخر مستوى؛ استخدم «عرض منتجات» أو ارجع من مسار التصنيف.'
            : 'جرّب مسح البحث أو الوصول بمعرّف التصنيف من الكتالوج.',
        ) +
        '</p></div>';
    $('fox-category-results')
      .querySelectorAll('[data-category-products]')
      .forEach(
        (b) => (b.onclick = () => foxChooseCategory(r.items[Number(b.dataset.categoryProducts)])),
      );
    $('fox-category-results')
      .querySelectorAll('[data-category-children]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            foxUI.trail.push(r.items[Number(b.dataset.categoryChildren)]);
            foxUI.categoryQuery = '';
            foxUI.categories = foxNewPager();
            foxCategoryPanel();
          }),
      );
    $('fox-category-pages').innerHTML = foxPages(pager, 'صفحات التصنيفات');
    $('fox-category-pages')
      .querySelectorAll('[data-page]')
      .forEach((b) => (b.onclick = () => foxLoadCategories(Number(b.dataset.page))));
  } catch (e) {
    if (current === 'foxreload' && epoch === foxUI.epoch)
      foxError('fox-category-results', e, () => foxLoadCategories(page));
  }
}
function foxLinkedPanel() {
  $('fox-body').innerHTML =
    `<section class="panel"><div class="fox-section-head"><div><h3>منتجات متجرك المربوطة</h3><p class="helper">ابحث في جميع الروابط، وعدّل التسعير أو حدّث تكلفة المنتج من المورد.</p></div><span class="fox-pill">${foxState.links.length} منتج</span></div><div class="fox-filter-grid"><label class="field">بحث بالاسم أو المعرّف<input type="search" id="fox-linked-search" value="${esc(foxUI.linkedQuery)}"></label><label class="field">نوع الربط<select id="fox-linked-type"><option value="all">كل الروابط</option><option value="steam">فئات Steam</option><option value="standard">المنتجات الأخرى</option></select></label></div><div id="fox-linked-results"></div><div id="fox-linked-pages"></div><p class="helper">تُحدّث أقدم 10 روابط كل 15 دقيقة. عدد أكبر من الروابط يحتاج عدة دفعات. تحديث السعر التلقائي يحافظ على عملة المنتج ويحسب نسبة الزيادة على التكلفة.</p></section>`;
  $('fox-linked-type').value = foxUI.linkedType;
  $('fox-linked-search').oninput = (e) => {
    foxUI.linkedQuery = e.target.value;
    foxUI.linkedPage = 1;
    foxRenderLinked();
  };
  $('fox-linked-type').onchange = (e) => {
    foxUI.linkedType = e.target.value;
    foxUI.linkedPage = 1;
    foxRenderLinked();
  };
  foxRenderLinked();
}
function foxRenderLinked() {
  const query = foxUI.linkedQuery.trim().toLocaleLowerCase(),
    rows = foxState.links.filter(
      (p) =>
        (foxUI.linkedType === 'all' || p.service_type === foxUI.linkedType) &&
        (!query ||
          [p.name, p.remote_id, p.product_id].join(' ').toLocaleLowerCase().includes(query)),
    ),
    total = Math.max(1, Math.ceil(rows.length / 20));
  foxUI.linkedPage = Math.min(foxUI.linkedPage, total);
  const start = (foxUI.linkedPage - 1) * 20;
  $('fox-linked-results').innerHTML = rows.length
    ? '<div class="table-wrap"><table class="fox-products-table"><thead><tr><th>المنتج</th><th>تكلفة USD</th><th>التسعير</th><th>التوفر / آخر تحديث</th><th>الإجراء</th></tr></thead><tbody>' +
      rows
        .slice(start, start + 20)
        .map(
          (p) =>
            '<tr><td><b>' +
            esc(p.name) +
            '</b><br><span class="fox-pill">' +
            esc(
              p.service_type === 'steam'
                ? 'Steam · ' + p.supplier_quantity + ' USD'
                : foxType(p.delivery_type),
            ) +
            '</span> <span>' +
            esc({ active: 'منشور', draft: 'مسودة', archived: 'مؤرشف' }[p.product_status] || '') +
            '</span><details class="fox-id"><summary>معرّف المورد</summary><code dir="ltr">' +
            esc(p.remote_id) +
            '</code></details></td><td data-label="التكلفة USD">' +
            (p.cost_units / 10000).toFixed(4) +
            '</td><td data-label="نسبة الزيادة">' +
            p.markup_bps / 100 +
            '%<br><small>' +
            esc(p.auto_price ? 'تلقائي' : 'يدوي') +
            '</small></td><td data-label="المتوفر / التحديث">' +
            p.stock +
            '<br><small>' +
            esc(date(p.checked_at)) +
            '</small></td><td><button class="secondary" data-price="' +
            esc(p.product_id) +
            '">التسعير والتحديث</button></td></tr>',
        )
        .join('') +
      '</tbody></table></div>'
    : '<div class="fox-message">لا توجد منتجات مربوطة تطابق البحث.</div>';
  $('fox-linked-results')
    .querySelectorAll('[data-price]')
    .forEach((b) => (b.onclick = () => foxPricing(b.dataset.price)));
  const currentPage = foxUI.linkedPage,
    nums = Array.from({ length: total }, (_, i) => i + 1).filter(
      (n) => n === 1 || n === total || Math.abs(n - currentPage) <= 2,
    );
  let previous = 0;
  $('fox-linked-pages').innerHTML =
    '<nav class="fox-pagination" aria-label="صفحات المنتجات المربوطة"><button class="secondary" data-linked-page="' +
    (currentPage - 1) +
    '" ' +
    (currentPage === 1 ? 'disabled' : '') +
    '>السابق</button><div>' +
    nums
      .map((n) => {
        const gap = n - previous > 1 ? '<span>…</span>' : '';
        previous = n;
        return (
          gap +
          '<button class="' +
          (n === currentPage ? 'primary' : 'secondary') +
          '" data-linked-page="' +
          n +
          '" ' +
          (n === currentPage ? 'aria-current="page"' : '') +
          '>' +
          n +
          '</button>'
        );
      })
      .join('') +
    '</div><button class="secondary" data-linked-page="' +
    (currentPage + 1) +
    '" ' +
    (currentPage === total ? 'disabled' : '') +
    '>التالي</button><small>صفحة ' +
    currentPage +
    ' من ' +
    total +
    ' · ' +
    rows.length +
    ' منتج</small></nav>';
  $('fox-linked-pages')
    .querySelectorAll('[data-linked-page]')
    .forEach(
      (b) =>
        (b.onclick = () => {
          foxUI.linkedPage = Number(b.dataset.linkedPage);
          foxRenderLinked();
        }),
    );
}
function foxConnection() {
  $('fox-body').innerHTML =
    `<section class="panel"><h3>الربط والصلاحيات</h3><div class="info-box">مفتاح API: ${foxState.configured ? 'مضاف — ليس إثباتًا لصلاحية الاتصال' : 'غير مضاف'}<br>التنفيذ الحقيقي: ${foxState.liveEnabled ? 'مفعّل؛ كل عملية تحتاج تأكيد الإدارة' : 'متوقف — العمليات التجريبية فقط'}<br>سر Webhook: ${foxState.webhookConfigured ? 'مضاف؛ تأكد من تسجيل الرابط عند المورد' : 'غير مضاف'}</div><label class="field">رابط إشعارات المورد<input value="${esc(foxState.webhookUrl)}" dir="ltr" readonly></label><p class="helper">الإشعار يحدّث نتائج عمليات المورد. لا يؤكد دفع الزبون ولا ينفذ شراءً جديدًا.</p></section><section class="panel"><div class="fox-section-head"><div><h3>رصيد المورد</h3><p class="helper">قراءة الرصيد المتاح من حساب FoxReload؛ لا تُجري أي عملية شراء.</p></div><button class="primary" id="fox-balance-button">عرض / تحديث الرصيد</button></div><div id="fox-balance" role="status"></div></section>`;
  $('fox-balance-button').onclick = async () => {
    const b = $('fox-balance-button'),
      epoch = foxUI.epoch;
    b.disabled = true;
    $('fox-balance').textContent = 'جاري قراءة الرصيد…';
    try {
      const r = await api('/api/admin/foxreload/balance');
      if (epoch !== foxUI.epoch) return;
      $('fox-balance').textContent =
        r.balances.map((x) => `${x.available ?? '—'} ${x.currency}`).join(' / ') ||
        'لا توجد أرصدة.';
    } catch (e) {
      if (epoch === foxUI.epoch) $('fox-balance').textContent = e.message;
    } finally {
      if (epoch === foxUI.epoch) b.disabled = false;
    }
  };
}
function foxImport(index) {
  const p = foxCatalog[index];
  openEditor(
    `${editorHead('استيراد من FoxReload')}<p>${esc(p.name)}</p><p class="helper">التكلفة: ${esc(p.price)} USD. سيُحفظ كمسودة وبطريقة طلب واتساب. عدّل الاسم والوصف والمنطقة والصورة من المنتجات قبل نشره.</p><form id="fox-import-form">${field('نسبة الزيادة على التكلفة (%)', 'markup', 10, { type: 'number', min: 0, step: '0.01', required: true })}${formEnd('استيراد المنتج')}</form>`,
  );
  bindForm('fox-import-form', async (fd) => {
    await send('/api/admin/foxreload/import', 'POST', {
      remote_id: p.id,
      markup_bps: Math.round(Number(fd.get('markup')) * 100),
    });
    closeEditor();
    await refresh();
    toast('تم استيراد المنتج كمسودة');
  });
}
function foxPricing(id) {
  const p = foxState.links.find((l) => l.product_id === id);
  openEditor(
    `${editorHead('تسعير ' + esc(p.name))}<form id="fox-pricing-form">${field('نسبة الزيادة على تكلفة المورد (%)', 'markup', p.markup_bps / 100, { type: 'number', min: 0, step: '0.01', required: true })}<label class="check-field"><input type="checkbox" name="auto" ${p.auto_price ? 'checked' : ''}> تحديث سعر البيع تلقائيًا بعملة المنتج</label><p class="helper">إلغاء الخيار يُبقي سعر البيع الذي تحدده من صفحة المنتجات، مع استمرار تحديث التكلفة والمخزون.</p>${formEnd('حفظ وتحديث من المورد')}</form>`,
  );
  bindForm('fox-pricing-form', async (fd) => {
    await send('/api/admin/foxreload/products/' + id, 'PUT', {
      markup_bps: Math.round(Number(fd.get('markup')) * 100),
      auto_price: fd.has('auto'),
    });
    closeEditor();
    await refresh();
    toast('تم تحديث المنتج');
  });
}
async function foxOrder(id) {
  try {
    const r = await api('/api/admin/foxreload/orders/' + id);
    openEditor(
      `${editorHead('تنفيذ FoxReload')}<div class="warning-box">التجربة لا تسلّم منتجات حقيقية ولا تظهر في مشتريات الزبون. التنفيذ الحقيقي يخصم من رصيد المورد ويحتاج تأكيد استلام دفع الزبون. راجع الدفع وبيانات حساب هذا المنتج قبل التنفيذ.</div><div id="fox-job-list"></div>`,
    );
    $('fox-job-list').innerHTML = r.items.length
      ? r.items
          .map((p, index) => {
            const schema = JSON.parse(p.note_schema),
              jobs = r.jobs.filter((j) => j.item_id === p.item_id);
            return `<section class="panel"><h3>${esc(p.name)} × ${p.quantity}</h3>${p.service_type === 'steam' ? '<p class="info-box">المبلغ المرسل للمورد: ' + p.supplier_quantity + ' وحدة شحن USD. اسم الدخول ملزم ببيانات الزبون المحفوظة.</p>' : ''}${p.player_id ? '<p class="info-box">معرّف حساب هذا المنتج: <bdi>' + esc(p.player_id) + '</bdi>' + (p.input_source === 'legacy' ? ' — بيانات مشتركة من طلب قديم؛ تحقق منها قبل التنفيذ.' : ' — كما أدخله الزبون.') + '</p>' : ''}<p class="helper">أقصى تكلفة محفوظة: ${((p.cost_units * p.quantity) / 10000).toFixed(4)} USD</p>${jobs.map((j) => `<p>${j.is_mock ? 'تجريبي' : 'حقيقي'} · ${esc(j.status)}<br>${esc(j.error)}${j.pay_started && j.status === 'active' ? '<br>بدأت محاولة الدفع؛ تحديث الحالة فقط. لا تعِد شراء الطلب من حساب المورد قبل مراجعة النتيجة.' : ''}</p>${j.is_mock && j.status === 'completed' ? '<pre dir="ltr">' + esc(JSON.parse(j.result_json).join('\n')) + '</pre>' : ''}<button type="button" class="secondary fox-refresh" data-job="${esc(j.id)}">تحديث حالة العملية</button>`).join('')}<form id="fox-execute-${index}">${schema.required.length ? `<p class="helper">بيانات الشحن المطلوبة: ${esc(schema.required.join('، '))}. تأكد منها مع الزبون.</p>` : ''}<label class="field">بيانات الشحن JSON<textarea name="note" dir="ltr" required>${esc(JSON.stringify(foxSavedNote(p, schema), null, 2))}</textarea></label><details><summary>خيارات الحقول لدى المورد</summary><pre dir="ltr">${esc(JSON.stringify(schema, null, 2))}</pre></details>${select('نوع التنفيذ', 'mode', 'mock', [['mock', 'طلب تجريبي'], ...(r.liveEnabled ? [['live', 'شراء حقيقي من رصيد المورد']] : [])])}<label class="check-field"><input name="confirm" type="checkbox"> أؤكد استلام الدفع وأوافق على الخصم من رصيد المورد عند اختيار التنفيذ الحقيقي.</label>${formEnd('تنفيذ / استعادة نفس العملية')}</form></section>`;
          })
          .join('')
      : '<p class="helper">هذا الطلب لا يحتوي منتجات FoxReload مستوردة بعد تثبيت الربط. الطلبات القديمة تبقى للمعالجة اليدوية.</p>';
    r.items.forEach((p, index) =>
      bindForm('fox-execute-' + index, async (fd) => {
        let note;
        try {
          note = JSON.parse(fd.get('note'));
        } catch {
          throw Error('بيانات الشحن يجب أن تكون JSON صالحًا');
        }
        const mock = fd.get('mode') === 'mock';
        if (!mock && !fd.has('confirm')) throw Error('أكد استلام الدفع والموافقة على الخصم');
        await send('/api/admin/foxreload/execute', 'POST', {
          item_id: p.item_id,
          mock,
          confirm: fd.has('confirm'),
          note,
        });
        await refresh();
        await foxOrder(id);
        toast('تم إرسال العملية؛ راجع الحالة');
      }),
    );
    document.querySelectorAll('.fox-refresh').forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            await send('/api/admin/foxreload/refresh', 'POST', { job_id: b.dataset.job });
            await refresh();
            await foxOrder(id);
          } catch (e) {
            toast(e.message);
            b.disabled = false;
          }
        }),
    );
  } catch (e) {
    toast(e.message);
  }
}
async function foxDetails(id) {
  try {
    const { product: p } = await api('/api/admin/foxreload/product?' + new URLSearchParams({ id }));
    const candidate =
      p.deliveryType === 'direct_topup' &&
      p.currency === 'usd' &&
      JSON.stringify(p.requiredNoteFields) === JSON.stringify(['login']) &&
      (p.orderMinQuantity ?? 1) <= 500;
    openEditor(
      `${editorHead('تفاصيل خدمة المورد')}<h3>${esc(p.name)}</h3><p dir="ltr">${esc(p.id)}</p><p>سعر الوحدة لدى المورد: ${esc(p.price)} ${esc(p.currency)} · الحد: ${p.orderMinQuantity ?? 1} إلى ${p.orderMaxQuantity ?? 'غير محدد'}</p><p style="white-space:pre-wrap">${esc(p.description || 'لا يوجد وصف')}</p><details><summary>تعليمات وحقول المورد</summary><p style="white-space:pre-wrap">${esc(p.userGuide || '')}</p><pre dir="ltr">${esc(JSON.stringify({ required: p.requiredNoteFields, types: p.noteFieldTypes, options: p.noteFieldOptions, attributes: p.attributes }, null, 2))}</pre></details>${candidate ? `<hr><h3>إنشاء فئة شحن Steam</h3><p class="warning-box">لا تستخدم هذا الخيار إلا لخدمة Steam التي تؤكد أن كمية 1 عند المورد تعني شحن 1 USD. عملة تكلفة المورد USD وحدها لا تثبت عملة الشحن. ستُنشأ الفئة كمسودة؛ راجع المناطق قبل النشر.</p><form id="fox-steam-form">${field('المبلغ الذي يصل لمحفظة Steam بالدولار', 'amount', Math.min(500, p.orderMaxQuantity ?? 500, Math.max(10, p.orderMinQuantity ?? 1)), { type: 'number', min: Math.max(1, p.orderMinQuantity ?? 1), max: Math.min(500, p.orderMaxQuantity ?? 500), step: 1, required: true })}${field('المناطق المدعومة كما أكدها المورد', 'regions', '', { required: true, maxlength: 100 })}${field('نسبة الزيادة على تكلفة المورد (%)', 'markup', 10, { type: 'number', min: 0, max: 1000, step: '0.01', required: true })}<label class="check-field"><input type="checkbox" name="unit" required> تأكدت أن هذه خدمة Steam وأن كل وحدة تشحن 1 USD، وراجعت المناطق المدعومة.</label>${formEnd('إنشاء الفئة كمسودة')}</form>` : '<p class="helper">هذه الخدمة لا تطابق شحن Steam عبر login فقط بالدولار. لا تحوّل بطاقة أو خدمة تتطلب كلمة مرور إلى شحن مباشر.</p>'}`,
    );
    if (candidate) {
      $('fox-steam-form').elements.amount.max = String(Math.min(500, p.orderMaxQuantity ?? 500));
      $('fox-steam-form').elements.regions.maxLength = 100;
    }
    if (candidate)
      bindForm('fox-steam-form', async (fd) => {
        await send('/api/admin/foxreload/steam/import', 'POST', {
          remote_id: p.id,
          amount: Number(fd.get('amount')),
          regions: String(fd.get('regions') || ''),
          markup_bps: Math.round(Number(fd.get('markup')) * 100),
          confirm_usd_unit: fd.has('unit'),
        });
        closeEditor();
        await refresh();
        toast('تم إنشاء فئة Steam كمسودة؛ راجعها من المنتجات');
      });
  } catch (e) {
    toast(e.message);
  }
}
async function showDelivery(id) {
  try {
    const r = await api('/api/orders/' + id + '/delivery');
    openEditor(
      `${editorHead('تفاصيل التسليم')} ${r.items.length ? r.items.map((i) => `<section class="panel"><h3>${esc(i.name)}</h3><p>${esc({ completed: 'تم التنفيذ', processing: 'قيد التنفيذ', paid: 'قيد التنفيذ', failed: 'تحتاج متابعة مع المتجر', refunded: 'تحتاج متابعة مع المتجر' }[i.status] || 'قيد المتابعة')}</p>${i.codes.length ? '<pre dir="ltr" style="white-space:pre-wrap;overflow-wrap:anywhere;user-select:all">' + esc(i.codes.join('\n\n')) + '</pre>' : ''}</section>`).join('') : '<p>لا توجد تفاصيل تسليم حتى الآن. تظهر بعد تأكيد الدفع وتنفيذ الطلب.</p>'}`,
    );
  } catch (e) {
    toast(e.message);
  }
}
