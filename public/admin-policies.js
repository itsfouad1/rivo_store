const RivoPolicies = (() => {
  let pages = [],
    active = 'privacy',
    ticket = 0,
    buffers = new Map();
  const titles = { privacy: 'الخصوصية', terms: 'الشروط والأحكام', refunds: 'الاسترجاع' };
  async function render() {
    const n = ++ticket;
    const view = $('dash-view');
    view.innerHTML = '<p class="helper">جاري تحميل محرر السياسات…</p>';
    try {
      const r = await api('/api/admin/policies');
      if (ticket !== n || $('dash-view') !== view) return;
      pages = r.pages;
      draw();
    } catch (e) {
      if ($('dash-view') === view) view.textContent = e.message;
    }
  }
  function draw() {
    const p = pages.find((p) => p.type === active),
      draft = buffers.get(active) || p.draft;
    $('dash-view').innerHTML =
      `<div class="page-head"><div><h2>صفحات وسياسات المتجر</h2><p>اكتب النص الفعلي واحفظه كمسودة. النشر خطوة منفصلة.</p></div></div><section class="panel policy-editor"><nav class="tabs" aria-label="الصفحات">${Object.keys(
        titles,
      )
        .map(
          (t) =>
            `<button class="${t === active ? 'active' : ''}" data-policy="${t}">${titles[t]}</button>`,
        )
        .join(
          '',
        )}</nav><div class="policy-admin-head"><h3>${titles[active]}</h3><span class="badge ${p.published ? 'green' : 'yellow'}">${p.published ? 'منشورة · نسخة ' + p.published.version : 'غير منشورة'}</span></div><p class="helper">تعديل المسودة لا يغيّر النص الظاهر للزبائن حتى تنشرها. اكتب نصًا عاديًا؛ لا يُنفَّذ HTML أو Markdown.</p><form id="policy-form">${field('عنوان الصفحة', 'title', draft.title, { max: 120, full: true })}<label class="field full">نص الصفحة<textarea name="body" maxlength="20000" placeholder="اكتب سياسة المتجر المعتمدة هنا…">${esc(draft.body)}</textarea><small>حتى 20,000 حرف. الحقول فارغة افتراضيًا؛ لا توجد شروط أو وعود استرجاع مفترضة.</small></label><p class="policy-status" id="policy-dirty">${buffers.has(active) ? 'تعديلات غير محفوظة — احفظ قبل النشر.' : 'المسودة المحفوظة جاهزة للمعاينة.'}</p><div class="form-error" role="alert"></div><div class="policy-actions"><button class="primary" type="submit">حفظ المسودة</button><button class="secondary" type="button" id="policy-preview">معاينة محلية</button><button class="primary" type="button" id="policy-publish" ${!p.draft.title || !p.draft.body ? 'disabled' : ''}>نشر النص المحفوظ</button>${p.published ? '<button class="secondary" type="button" id="policy-unpublish">إلغاء النشر</button><a class="text-btn" href="/policy.html?type=' + active + '" target="_blank" rel="noopener">عرض المنشورة ↗</a>' : ''}</div></form><div id="policy-preview-area" class="policy-preview" hidden></div><p class="helper">معاينة المسودة محلية داخل هذه الشاشة فقط، ولا تجعلها متاحة للزبائن. النشر يُظهر الرابط في المتجر وصفحة إكمال الطلب.</p></section>`;
    const form = $('policy-form');
    form.oninput = () => {
      buffers.set(active, { title: form.elements.title.value, body: form.elements.body.value });
      $('policy-dirty').textContent = 'تعديلات غير محفوظة — احفظ قبل النشر.';
      $('policy-publish').disabled = true;
    };
    document.querySelectorAll('[data-policy]').forEach(
      (b) =>
        (b.onclick = () => {
          active = b.dataset.policy;
          draw();
        }),
    );
    $('policy-preview').onclick = () => {
      const area = $('policy-preview-area');
      area.replaceChildren();
      const h = document.createElement('h3'),
        body = document.createElement('div');
      h.textContent = form.elements.title.value;
      body.textContent = form.elements.body.value;
      body.className = 'policy-body';
      area.append(h, body);
      area.hidden = false;
    };
    async function action(kind, body = {}) {
      const type = active;
      const error = form.querySelector('.form-error');
      error.textContent = '';
      form.querySelectorAll('button,input,textarea').forEach((b) => (b.disabled = true));
      try {
        const r = await send('/api/admin/policies/' + type, 'PUT', {
          ...body,
          action: kind,
          revision: p.revision,
        });
        pages = pages.map((x) => (x.type === type ? r.page : x));
        if (kind === 'save') buffers.delete(type);
        toast(
          kind === 'save'
            ? 'تم حفظ المسودة'
            : kind === 'publish'
              ? 'تم نشر الصفحة'
              : 'تم إلغاء النشر',
        );
        if (current === 'policies' && active === type) draw();
      } catch (e) {
        error.textContent = e.message;
        form.querySelectorAll('button,input,textarea').forEach((b) => (b.disabled = false));
        $('policy-publish').disabled = true;
      }
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      action('save', Object.fromEntries(new FormData(form)));
    };
    $('policy-publish').onclick = () => action('publish');
    if ($('policy-unpublish')) $('policy-unpublish').onclick = () => action('unpublish');
  }
  return { render };
})();
