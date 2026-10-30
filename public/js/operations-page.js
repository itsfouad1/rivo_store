const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
let user,
  current = 'operations';
const api = async (path, options = {}) => {
  const r = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    }),
    d = await r.json();
  if (!r.ok) throw Error(d.error || 'تعذّر تنفيذ الطلب');
  return d;
};
const send = (path, method, b) => api(path, { method, body: JSON.stringify(b) }),
  date = (v) => new Date(v).toLocaleString('ar-PS'),
  money = (n, c = 'USD') =>
    new Intl.NumberFormat('ar-PS', { style: 'currency', currency: c }).format(n / 100);
const labels = {
  paid: 'مدفوع',
  unpaid: 'غير مدفوع',
  completed: 'مكتمل',
  processing: 'قيد التنفيذ',
  awaiting_payment: 'بانتظار الدفع',
  contact_pending: 'بانتظار التواصل',
  cancelled: 'ملغي',
  refunded: 'مسترجع',
  partially_refunded: 'استرجاع جزئي',
};
const editorHead = (t) =>
  '<div class="editor-header"><h2>' +
  esc(t) +
  '</h2><button class="secondary" data-close aria-label="إغلاق">×</button></div>';
function closeEditor() {
  $('editor').close();
}
function openEditor(html) {
  $('editor-content').innerHTML = html;
  $('editor').showModal();
  $('editor-content').querySelector('[data-close]').onclick = closeEditor;
}
const field = (label, name, value = '', o = {}) =>
  '<label class="field">' +
  esc(label) +
  '<input name="' +
  esc(name) +
  '" type="' +
  (o.type || 'text') +
  '" value="' +
  esc(value) +
  '" ' +
  (o.min !== undefined ? 'min="' + o.min + '"' : '') +
  ' ' +
  (o.step ? 'step="' + o.step + '"' : '') +
  '></label>';
const select = (label, name, value, choices) =>
  '<label class="field">' +
  esc(label) +
  '<select name="' +
  esc(name) +
  '">' +
  choices
    .map(
      ([v, t]) =>
        '<option value="' +
        esc(v) +
        '" ' +
        (v === value ? 'selected' : '') +
        '>' +
        esc(t) +
        '</option>',
    )
    .join('') +
  '</select></label>';
const formEnd = (t) =>
  '<p class="form-error" role="alert"></p><div class="form-actions"><button type="submit" class="primary">' +
  esc(t) +
  '</button><button type="button" class="secondary" onclick="closeEditor()">إلغاء</button></div>';
function bindForm(id, save) {
  const f = $(id);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = f.querySelector('[type=submit]');
    b.disabled = true;
    f.querySelector('.form-error').textContent = '';
    try {
      await save(new FormData(f));
    } catch (e) {
      f.querySelector('.form-error').textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
}
function toast(t) {
  $('toast').textContent = t;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 3000);
}
(async () => {
  try {
    ({ user } = await api('/api/session'));
    if (!user || !['support', 'admin', 'owner'].includes(user.role))
      throw Error('هذه الصفحة للفريق المخوّل؛ سجّل الدخول من صفحة الحساب.');
    RivoOperations.render();
  } catch (e) {
    $('dash-view').textContent = e.message;
  }
})();
