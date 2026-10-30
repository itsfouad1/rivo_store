import { mountOrderExtras } from './customer-growth-ui.js';
import { progressHTML } from './order-progress.js';
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const id = new URLSearchParams(location.search).get('order');
const labels = {
  contact_pending: 'بانتظار التواصل',
  awaiting_payment: 'بانتظار الدفع',
  processing: 'قيد التنفيذ',
  completed: 'تم التسليم',
  cancelled: 'ملغي',
  unpaid: 'لم يُؤكَّد الدفع',
  paid: 'مدفوع',
  refunded: 'مسترجع',
  partially_refunded: 'مسترجع جزئيًا',
  test_paid: 'دفع تجريبي ناجح',
  test_refunded: 'استرجاع تجريبي',
  test_partially_refunded: 'استرجاع جزئي تجريبي',
};
const money = (n, c) =>
  new Intl.NumberFormat('ar-PS', { style: 'currency', currency: c }).format(n / 100);
const date = (v) =>
  new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v));
let busy = false;
async function api(path) {
  const r = await fetch(path, { cache: 'no-store' });
  const d = await r.json();
  if (!r.ok) {
    const e = new Error(d.error || 'تعذّر تحميل الطلب');
    e.status = r.status;
    throw e;
  }
  return d;
}
function render({ order: o, support_url }) {
  const test = o.payment_status.startsWith('test_');
  const title = test ? 'اختبار مكتمل' : labels[o.status] || 'طلبك مسجّل';
  const message = test
    ? 'هذه نتيجة تجربة فقط، لم تُحصّل أموال ولم يُشترَ منتج حقيقي من المورد.'
    : o.payment_status.includes('refunded')
      ? 'سُجّل استرجاع لهذا الطلب. تواصل معنا لمراجعة تفاصيله.'
      : o.status === 'cancelled'
        ? 'هذا الطلب مغلق. تواصل معنا إذا احتجت مساعدة.'
        : o.status === 'completed'
          ? 'تفاصيل تسليم المنتجات متاحة في القسم أدناه.'
          : o.payment_status === 'paid'
            ? 'وصل تأكيد الدفع. طلبك بانتظار إكمال التنفيذ، وستظهر نتيجة التسليم هنا.'
            : o.payment_method === 'whatsapp'
              ? 'تواصل معنا لإكمال الطلب. فتح محادثة واتساب وحده لا يؤكد الدفع.'
              : 'بانتظار تأكيد الدفع. إذا دفعت بالفعل فلا تكرر الدفع؛ راجع حالته من الزر أدناه.';
  $('details').innerHTML =
    `<section class="panel order-summary"><span class="badge purple">${esc(test ? 'طلب تجريبي' : labels[o.payment_status] || o.payment_status)}</span><h2>${esc(title)}</h2><p>${esc(message)}</p><p class="order-id">رقم الطلب: <bdi>${esc(o.id)}</bdi></p><button id="copy-id" class="text-btn" type="button">نسخ رقم الطلب</button></section>
 <div class="order-layout"><div><section class="panel"><h2>المنتجات</h2>${o.items.map((i) => `<div class="order-item"><div><strong>${esc(i.name)}</strong><small>الكمية: ${i.quantity}${i.region ? ' · المنطقة: ' + esc(i.region) : ''}</small>${i.player_id ? '<small>معرّف الحساب: <bdi>' + esc(i.player_id) + '</bdi>' + (i.input_source === 'legacy' ? ' · بيانات مشتركة من طلب قديم' : '') + '</small>' : ''}</div><b>${esc(money(i.unit_cents * i.quantity, o.currency))}</b></div>`).join('')}<div class="order-meta"><span>إجمالي الطلب</span><strong class="order-total">${esc(money(o.total_cents, o.currency))}</strong></div>${o.gateway ? `<p class="helper">مبلغ فاتورة الدفع: <bdi>${esc(money(o.gateway.amount_usd_cents, 'USD'))}</bdi> — ${test ? 'تجريبي' : 'التحصيل بالدولار'}. مبلغ الطلب محفوظ وقت إنشائه.</p>` : ''}</section>
 ${
   o.items.some((i) => i.activation_instructions || i.delivery_estimate || i.purchase_notice)
     ? '<section class="panel"><h2>تعليمات منتجاتك</h2><p class="helper">التفاصيل المحفوظة وقت إنشاء هذا الطلب.</p>' +
       o.items
         .filter((i) => i.activation_instructions || i.delivery_estimate || i.purchase_notice)
         .map(
           (i) =>
             '<div class="order-delivery"><h3>' +
             esc(i.name) +
             '</h3>' +
             (i.delivery_estimate
               ? '<p class="order-note"><strong>وقت التنفيذ المتوقع:</strong> ' +
                 esc(i.delivery_estimate) +
                 '</p>'
               : '') +
             (i.purchase_notice
               ? '<p class="order-note"><strong>تنبيه المنتج:</strong> ' +
                 esc(i.purchase_notice) +
                 '</p>'
               : '') +
             (i.activation_instructions
               ? '<details><summary>طريقة التفعيل والاستخدام</summary><p class="order-note">' +
                 esc(i.activation_instructions) +
                 '</p></details>'
               : '') +
             '</div>',
         )
         .join('') +
       '</section>'
     : ''
 }
 <section class="panel"><h2>الأكواد ونتيجة الشحن</h2><div id="delivery"><p class="helper">${test ? 'لا توجد منتجات حقيقية لتسليمها في هذا الاختبار.' : o.payment_status !== 'paid' ? 'تفاصيل التسليم متاحة بعد تأكيد الدفع وتنفيذ المنتج.' : 'جاري جلب تفاصيل التسليم…'}</p></div></section>
 ${o.customer_update ? `<section class="panel"><h2>تحديث من ريفو</h2><p class="order-note">${esc(o.customer_update)}</p></section>` : ''}</div>
 <aside><section class="panel"><h2>بيانات الطلب</h2><dl class="order-facts"><div><dt>تاريخ الطلب</dt><dd>${esc(date(o.created_at))}</dd></div><div><dt>آخر تحديث</dt><dd>${esc(date(o.updated_at))}</dd></div><div><dt>طريقة الدفع</dt><dd>${o.payment_method === 'gateway' ? 'Payunit' : 'واتساب'}</dd></div>${o.player_id ? `<div><dt>معرّف اللاعب</dt><dd><bdi>${esc(o.player_id)}</bdi></dd></div>` : ''}</dl>${o.customer_note ? `<h3>ملاحظتك</h3><p class="order-note">${esc(o.customer_note)}</p>` : ''}<div class="order-actions">${o.payment_method === 'gateway' ? `<a class="primary" href="/payment.html?order=${encodeURIComponent(o.id)}">مراجعة حالة الدفع</a>` : ''}<a class="secondary" href="/account">كل طلباتي</a></div></section>
 <section class="panel"><h2>بحاجة لمساعدة؟</h2><p class="helper">احتفظ برقم الطلب حتى نقدر نتابع معك.</p>${support_url ? `<a class="secondary" href="${esc(support_url)}" target="_blank" rel="noopener noreferrer">تواصل عبر واتساب ↗</a>` : '<p class="helper">رقم الدعم غير متاح حاليًا. راجع قنوات التواصل في المتجر.</p>'}</section></aside></div>`;
  $('copy-id').onclick = () => copy(o.id);
  $('details').querySelector('.order-summary').insertAdjacentHTML('beforeend', progressHTML(o));
  const help = $('details').querySelector('aside .panel:last-child');
  const chat = document.createElement('button');
  chat.className = 'secondary';
  chat.type = 'button';
  chat.textContent = 'فتح مساعد ريفو';
  chat.onclick = () => {
    const launcher = document.querySelector('.rivo-chat-launch');
    if (launcher) launcher.click();
    else
      $('notice').textContent =
        'تعذّر فتح الشات الآن. جرّب بعد لحظة أو استخدم واتساب إن كان متاحًا.';
  };
  help.append(chat);
  mountOrderExtras($('details'), o);
  return !test && o.payment_status === 'paid';
}
async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    $('notice').textContent = 'تم النسخ.';
  } catch {
    $('notice').textContent = 'تعذّر النسخ التلقائي؛ حدّد النص وانسخه يدويًا.';
  }
}
function renderDelivery(items) {
  const statuses = {
    completed: 'تم التنفيذ',
    failed: 'تعذّر التنفيذ؛ تواصل مع الدعم',
    pending: 'بانتظار التنفيذ',
    processing: 'قيد التنفيذ',
    created: 'قيد التنفيذ',
  };
  $('delivery').innerHTML = items.length
    ? items
        .map(
          (item, index) =>
            `<div class="order-delivery"><h3>${esc(item.name)}</h3><p class="helper">${esc(statuses[item.status] || 'قيد المتابعة')}</p>${item.codes.length ? `<details><summary>إظهار الأكواد (${item.codes.length})</summary>${item.codes.map((code, k) => `<div class="code-row"><pre dir="ltr">${esc(code)}</pre><button class="secondary" type="button" data-item="${index}" data-code="${k}" aria-label="نسخ الكود ${k + 1}">نسخ</button></div>`).join('')}</details>` : item.status === 'completed' ? '<p>اكتمل تنفيذ هذا المنتج، ولا توجد أكواد نصية مرفقة.</p>' : ''}</div>`,
        )
        .join('')
    : '<p class="helper">لا توجد تفاصيل تسليم إلكترونية متاحة بعد. راجع تحديث ريفو أو تواصل مع الدعم.</p>';
  $('delivery')
    .querySelectorAll('[data-code]')
    .forEach(
      (b) => (b.onclick = () => copy(items[Number(b.dataset.item)].codes[Number(b.dataset.code)])),
    );
}
async function load() {
  if (busy) return;
  busy = true;
  $('refresh').disabled = true;
  $('error').textContent = '';
  $('notice').textContent = 'جاري تحديث الطلب…';
  try {
    if (!/^[a-f0-9-]{36}$/.test(id || ''))
      throw new Error('رابط الطلب غير صالح. افتحه من صفحة طلباتي.');
    const data = await api('/api/orders/' + id);
    const delivery = render(data);
    if (delivery) {
      try {
        const d = await api('/api/orders/' + id + '/delivery');
        renderDelivery(d.items);
      } catch (e) {
        $('delivery').textContent = 'تعذّر تحميل تفاصيل التسليم. اضغط تحديث الطلب للمحاولة مجددًا.';
      }
    }
    $('notice').textContent =
      'آخر فحص: ' + new Intl.DateTimeFormat('ar-PS', { timeStyle: 'short' }).format(new Date());
  } catch (e) {
    $('details').replaceChildren();
    $('notice').textContent = '';
    $('error').textContent = e.message;
    if (e.status === 401) {
      const a = document.createElement('a');
      a.href = '/login';
      a.textContent = 'سجّل الدخول ثم افتح الطلب من حسابك';
      a.className = 'primary';
      $('details').append(a);
    }
  } finally {
    busy = false;
    $('refresh').disabled = false;
  }
}
$('refresh').onclick = load;
load();
