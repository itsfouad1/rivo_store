import { availability } from './catalog.js';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const money = (n, c) =>
  new Intl.NumberFormat('ar-PS', { style: 'currency', currency: c }).format(n / 100);
function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-' +
    h.slice(12, 16) +
    '-' +
    h.slice(16, 20) +
    '-' +
    h.slice(20)
  );
}
export function regionNotice(region) {
  return region?.trim()
    ? `تأكد أن منطقة حسابك متوافقة مع «${region.trim()}». تغيير عملة العرض لا يغيّر منطقة التفعيل.`
    : 'منطقة التفعيل غير محددة لهذا المنتج. اسأل الدعم قبل الشراء.';
}
export function reviewCart(rows, products, { currency, method, gatewayReady, whatsapp }) {
  if (!rows.length || rows.length > 20) throw Error('اختر من 1 إلى 20 منتجًا.');
  const seen = new Set();
  let total = 0;
  const items = rows.map((row) => {
    const p = products.find((p) => p.id === row.id);
    if (!p || !availability(p, { gatewayReady, whatsapp }).available)
      throw Error('أحد المنتجات لم يعد متاحًا. ارجع للسلة وعدّلها.');
    if (
      seen.has(row.id) ||
      !Number.isInteger(row.quantity) ||
      row.quantity < (p.min_quantity ?? 1) ||
      row.quantity > Math.min(99, p.max_quantity ?? 99)
    )
      throw Error('راجع كميات المنتجات في السلة.');
    seen.add(row.id);
    if (p.currency !== currency || !Number.isSafeInteger(p.price_cents) || p.price_cents < 0)
      throw Error('تعذّر التحقق من السعر. حدّث المتجر وحاول مجددًا.');
    if (
      !['gateway', 'whatsapp'].includes(method) ||
      !['both', method].includes(p.payment_mode) ||
      (method === 'gateway' && !gatewayReady) ||
      (method === 'whatsapp' && !whatsapp)
    )
      throw Error('طريقة الطلب المختارة غير متاحة لكل منتجات السلة.');
    if (
      row.player_id !== undefined &&
      (typeof row.player_id !== 'string' ||
        row.player_id.length > 150 ||
        /[\x00-\x1f\x7f]/.test(row.player_id))
    )
      throw Error('معرّف الحساب غير صالح: ' + p.name);
    const account = (row.player_id || '').trim();
    if (p.player_id_required && !account)
      throw Error('معرّف اللاعب / الحساب مطلوب للمنتج: ' + p.name);
    if (!p.player_id_required && account) throw Error('هذا المنتج لا يتطلب معرّف حساب.');
    total += p.price_cents * row.quantity;
    return { ...p, quantity: row.quantity, player_id: account };
  });
  if (!Number.isSafeInteger(total) || total > 100000000)
    throw Error('قيمة الطلب خارج الحد المسموح.');
  return { items, total, currency };
}
export function applyCouponReview(review, quote) {
  if (
    quote.currency !== review.currency ||
    quote.subtotal !== review.total ||
    !Array.isArray(quote.items) ||
    quote.items.length !== review.items.length
  )
    throw Error('تغيّر السعر؛ أعد مراجعة الطلب');
  const items = review.items.map((p) => {
    const q = quote.items.find((x) => x.id === p.id);
    if (
      !q ||
      q.quantity !== p.quantity ||
      !Number.isSafeInteger(q.unit_cents) ||
      q.unit_cents < 1 ||
      q.unit_cents > p.price_cents
    )
      throw Error('تسعير خصم غير صالح');
    return { ...p, price_cents: q.unit_cents };
  });
  const total = items.reduce((s, p) => s + p.price_cents * p.quantity, 0);
  if (total !== quote.total || review.total - total !== quote.discount || quote.discount <= 0)
    throw Error('تسعير خصم غير متطابق');
  return {
    ...review,
    items,
    total,
    coupon: { code: quote.code, discount: quote.discount, subtotal: quote.subtotal },
  };
}
export function createPurchaseUI({
  api,
  getState,
  refresh,
  session,
  add,
  complete,
  policyLinks,
  art,
}) {
  const dialog = document.getElementById('product-dialog'),
    root = document.getElementById('product-content');
  let busy = false,
    draft = null,
    review = null,
    attempt = null,
    uncertain = false;
  const steamPassed = new Map();
  const show = () => {
    dialog.classList.add('purchase-dialog');
    if (!dialog.open) dialog.showModal();
  };
  const titleFocus = () => root.querySelector('h2')?.focus();
  const error = (message) => {
    const box = root.querySelector('[data-purchase-error]');
    if (box) box.textContent = message;
  };
  const buttonLock = (locked) =>
    dialog.querySelectorAll('button').forEach((b) => (b.disabled = locked));
  const unlockClose = () =>
    dialog.querySelectorAll('[data-close]').forEach((b) => (b.disabled = false));
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  dialog.addEventListener(
    'click',
    (e) => {
      if (busy) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  const region = (p) =>
    `<div class="purchase-region"><span>منطقة التفعيل</span><strong>${esc(p.region || 'غير محددة')}</strong><p>${esc(regionNotice(p.region))}</p></div>`;
  const guide = (p) =>
    `<section class="purchase-guide"><h3>${esc(p.name)}</h3><p><strong>وقت التنفيذ المتوقع:</strong> ${esc(p.delivery_estimate || 'غير محدد حاليًا — اسأل الدعم قبل الطلب.')}</p>${p.purchase_notice ? '<p class="purchase-notice">' + esc(p.purchase_notice) + '</p>' : ''}${region(p)}</section>`;
  function view(id) {
    if (busy) return;
    const s = getState(),
      p = s.products.find((p) => p.id === id);
    if (!p) return;
    const stock = availability(p, { gatewayReady: s.gatewayReady, whatsapp: s.config.whatsapp });
    root.innerHTML = `<div class="purchase-product"><div class="purchase-visual">${art(p)}<span class="purchase-label">${esc(p.category)}</span></div><div><p class="purchase-eyebrow">RIVO / تفاصيل المنتج</p><h2 tabindex="-1">${esc(p.name)}</h2><span class="purchase-stock ${stock.available ? '' : 'is-off'}">${esc(stock.label)}</span><p class="purchase-description">${esc(p.description || 'راجع منطقة التفعيل وبيانات المنتج قبل الطلب.')}</p><div class="purchase-price">${esc(money(p.price_cents, p.currency))}<small>للوحدة الواحدة</small></div>${region(p)}<dl class="purchase-facts"><div><dt>وقت التنفيذ المتوقع</dt><dd>${esc(p.delivery_estimate || 'غير محدد — تواصل مع الدعم')}</dd></div><div><dt>طريقة الاستلام</dt><dd>${p.account_type === 'steam' ? 'شحن مباشر لمحفظة Steam' : p.player_id_required ? 'شحن على معرّف اللاعب' : 'راجع تعليمات المنتج ونتيجة التسليم في طلباتك'}</dd></div><div><dt>بيانات مطلوبة</dt><dd>${p.account_type === 'steam' ? 'اسم دخول Steam فقط، بدون كلمة المرور' : p.player_id_required ? 'معرّف اللاعب فقط، بدون كلمة المرور' : 'لا يُطلب معرّف لاعب لهذا المنتج'}</dd></div></dl>${p.purchase_notice ? '<section class="purchase-alert"><h3>قبل ما تشتري</h3><p>' + esc(p.purchase_notice) + '</p></section>' : ''}<details class="purchase-instructions"><summary>طريقة التفعيل والاستخدام</summary><p>${esc(p.activation_instructions || 'تعليمات هذا المنتج غير مضافة بعد. اسأل الدعم قبل الشراء إذا لم تكن متأكدًا من الاستخدام.')}</p></details><form data-add-form><label class="purchase-quantity">الكمية<input name="quantity" type="number" value="${p.min_quantity ?? 1}" min="${p.min_quantity ?? 1}" max="${Math.min(99, p.max_quantity ?? 99)}" step="1" required></label><p data-purchase-error class="form-error" role="alert"></p><button class="primary" type="submit" ${stock.available ? '' : 'disabled'}>${stock.available ? 'أضف للسلة' : esc(stock.label)}</button></form></div></div>`;
    root.querySelector('[data-add-form]').onsubmit = (e) => {
      e.preventDefault();
      const qty = Number(e.target.elements.quantity.value);
      if (
        !Number.isInteger(qty) ||
        qty < (p.min_quantity ?? 1) ||
        qty > Math.min(99, p.max_quantity ?? 99)
      )
        return error('راجع الكمية المطلوبة.');
      try {
        add(id, qty);
        dialog.close();
      } catch (e) {
        error(e.message);
      }
    };
    show();
    titleFocus();
  }
  function editor() {
    const s = getState(),
      selected = draft.items.map((x) => s.products.find((p) => p.id === x.id)).filter(Boolean);
    const canPay =
      s.gatewayReady && selected.every((p) => ['gateway', 'both'].includes(p.payment_mode));
    const canWA =
      !!s.config.whatsapp && selected.every((p) => ['whatsapp', 'both'].includes(p.payment_mode));
    const players = selected.filter((p) => p.player_id_required);
    if (
      !draft.method ||
      (draft.method === 'gateway' && !canPay) ||
      (draft.method === 'whatsapp' && !canWA)
    )
      draft.method = canPay ? 'gateway' : canWA ? 'whatsapp' : '';
    root.innerHTML = `<div class="purchase-checkout"><p class="purchase-eyebrow">01 / بيانات الطلب</p><h2 tabindex="-1">خلّينا نجهّز طلبك</h2><p class="purchase-muted">لسه ما أنشأنا طلب. راجع البيانات، وبعدها بنعرضلك الملخص للتأكيد.</p><form data-checkout><fieldset class="purchase-methods"><legend>كيف بدك تكمل الطلب؟</legend><label><input type="radio" name="method" value="gateway" ${canPay ? '' : 'disabled'} ${draft.method === 'gateway' ? 'checked' : ''}> <span><b>Payunit</b><small>${canPay ? 'التحصيل بالدولار، بعد مراجعة المبلغ النهائي' : 'غير متاح لهذه السلة حاليًا'}</small></span></label><label><input type="radio" name="method" value="whatsapp" ${canWA ? '' : 'disabled'} ${draft.method === 'whatsapp' ? 'checked' : ''}> <span><b>التواصل عبر واتساب</b><small>${canWA ? 'يتحفظ الطلب، وتتابع الدفع مع المتجر' : 'غير متاح لهذه السلة حاليًا'}</small></span></label></fieldset>${s.gatewayMode === 'test' && canPay ? '<p class="purchase-alert">وضع تجريبي للإدارة؛ لا تحصيل أو تسليم حقيقي.</p>' : ''}${!canPay && !canWA ? '<p class="form-error">لا توجد طريقة طلب مشتركة. اطلب المنتجات بشكل منفصل أو عدّل السلة.</p>' : ''}${players.map((p) => '<fieldset class="purchase-account"><legend>' + esc(p.name) + '</legend><label class="field">' + (p.account_type === 'steam' ? 'اسم دخول Steam (Account name)' : 'معرّف اللاعب / الحساب') + '<input name="player:' + esc(p.id) + '" value="' + esc(draft.items.find((x) => x.id === p.id)?.player_id || '') + '" maxlength="150" required autocomplete="off" dir="auto"></label>' + (p.account_type === 'steam' ? '<p class="purchase-muted">شحن ' + p.topup_amount + ' USD. أدخل اسم الدخول، وليس اسم العرض أو الرابط. بدون كلمة مرور أو رمز تحقق.</p><button class="secondary" type="button" data-steam-check="' + esc(p.id) + '">افحص حساب Steam</button><p role="status" data-steam-result="' + esc(p.id) + '">' + (steamPassed.has(p.id) && steamPassed.get(p.id).login === draft.items.find((x) => x.id === p.id)?.player_id ? 'تم فحص هذا الاسم؛ يُعاد التحقق عند إنشاء الطلب.' : 'افحص الاسم قبل متابعة الطلب.') + '</p>' : '') + '<p class="purchase-muted">هذا المعرّف خاص بهذا المنتج ويُستخدم لكامل كميته (' + draft.items.find((x) => x.id === p.id).quantity + '). لا تكتب كلمة مرور أو رمز تحقق. لشحن نفس المنتج لحساب آخر، اعمل طلبًا منفصلًا حاليًا.</p></fieldset>').join('')}<label class="field">كود خصم <small>(اختياري)</small><input name="coupon_code" maxlength="32" value="${esc(draft.coupon || '')}" placeholder="مثال: RIVO10" autocomplete="off" dir="ltr"></label><label class="field">ملاحظة للمتجر <small>(اختياري)</small><textarea name="customer_note" maxlength="600">${esc(draft.note)}</textarea></label><p data-purchase-error class="form-error" role="alert"></p><div class="purchase-footer"><button type="button" class="secondary" data-cart-back>رجوع للسلة</button><button class="primary" type="submit" ${canPay || canWA ? '' : 'disabled'}>راجع الطلب ←</button></div></form></div>`;
    root.querySelectorAll('[data-steam-check]').forEach((button) => {
      const id = button.dataset.steamCheck,
        input = root.querySelector('[name="player:' + id + '"]'),
        status = root.querySelector('[data-steam-result="' + id + '"]');
      input.oninput = () => {
        steamPassed.delete(id);
        status.textContent = 'تغيّر الاسم؛ افحصه مجددًا.';
      };
      button.onclick = async () => {
        if (busy) return;
        const login = input.value.trim();
        if (!login) return (status.textContent = 'اكتب اسم دخول Steam أولًا.');
        busy = true;
        error('');
        buttonLock(true);
        input.readOnly = true;
        status.textContent = 'جاري فحص إمكانية الشحن…';
        try {
          const result = await api('/api/steam/check-login', {
            method: 'POST',
            body: JSON.stringify({ product_id: id, login }),
          });
          if (result.isValid && result.login === login) {
            steamPassed.set(id, { login, at: Date.now() });
            status.textContent = 'الاسم متاح مبدئيًا للشحن. تأكد أيضًا من منطقة الحساب.';
          } else {
            steamPassed.delete(id);
            status.textContent = 'الحساب غير متاح للشحن عبر هذه الخدمة.';
          }
        } catch (e) {
          steamPassed.delete(id);
          status.textContent = e.message;
        } finally {
          busy = false;
          input.readOnly = false;
          buttonLock(false);
        }
      };
    });
    root.querySelector('[data-cart-back]').onclick = () => {
      dialog.close();
      document.getElementById('cart-dialog').showModal();
    };
    root.querySelector('[data-checkout]').onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const f = new FormData(e.target);
      draft.method = f.get('method');
      draft.items = draft.items.map((x) => ({
        ...x,
        player_id: String(f.get('player:' + x.id) || '').trim(),
      }));
      draft.note = String(f.get('customer_note') || '').trim();
      draft.coupon = String(f.get('coupon_code') || '')
        .trim()
        .toUpperCase();
      for (const p of selected.filter((p) => p.account_type === 'steam')) {
        const checked = steamPassed.get(p.id),
          login = draft.items.find((x) => x.id === p.id).player_id;
        if (!checked || checked.login !== login || Date.now() - checked.at > 600000)
          return error('افحص اسم حساب Steam قبل مراجعة الطلب.');
      }
      busy = true;
      buttonLock(true);
      try {
        await refresh();
        const fresh = getState();
        review = reviewCart(draft.items, fresh.products, {
          currency: fresh.currency,
          method: draft.method,
          gatewayReady: fresh.gatewayReady,
          whatsapp: fresh.config.whatsapp,
        });
        if (draft.coupon) {
          const q = await api('/api/coupons/quote', {
            method: 'POST',
            body: JSON.stringify({
              code: draft.coupon,
              items: draft.items.map((x) => ({ id: x.id, quantity: x.quantity })),
              currency: review.currency,
            }),
          });
          review = applyCouponReview(review, q);
        }
        attempt = null;
        uncertain = false;
        confirmation();
      } catch (e) {
        error(e.message);
      } finally {
        busy = false;
        unlockClose();
        if (root.querySelector('[data-checkout]')) buttonLock(false);
      }
    };
    titleFocus();
  }
  function confirmation() {
    const links = policyLinks();
    root.innerHTML = `<div class="purchase-checkout"><p class="purchase-eyebrow">02 / مراجعة الطلب</p><h2 tabindex="-1">كل شي صحيح؟</h2><p class="purchase-muted">راجع المنتجات والمنطقة ومعرّف اللاعب قبل تأكيد إنشاء الطلب.</p><div class="purchase-review-items">${review.items.map((p) => '<div class="purchase-review-item"><div><strong>' + esc(p.name) + '</strong><small>' + esc(p.region || 'منطقة غير محددة') + ' · الكمية: ' + p.quantity + '</small>' + (p.player_id ? '<small>معرّف الحساب: <bdi>' + esc(p.player_id) + '</bdi></small>' : '') + '</div><b>' + esc(money(p.price_cents * p.quantity, review.currency)) + '</b></div>').join('')}</div><dl class="purchase-facts"><div><dt>طريقة الطلب</dt><dd>${draft.method === 'gateway' ? 'Payunit — التحصيل بالدولار' : 'التواصل عبر واتساب'}</dd></div></dl>${draft.note ? '<div class="purchase-guide"><b>ملاحظتك</b><p>' + esc(draft.note) + '</p></div>' : ''}${review.coupon ? '<p class="growth-discount">الكوبون ' + esc(review.coupon.code) + ' · وفّرت ' + esc(money(review.coupon.discount, review.currency)) + ' من ' + esc(money(review.coupon.subtotal, review.currency)) + '</p>' : ''}<div class="purchase-review-total"><span>إجمالي المنتجات بعد أي خصم</span><strong>${esc(money(review.total, review.currency))}</strong></div><p class="purchase-muted">${draft.method === 'gateway' ? 'بعد إنشاء الطلب، ستراجع مبلغ فاتورة Payunit النهائي بالدولار قبل الانتقال للدفع.' : 'فتح واتساب لا يؤكد الدفع؛ تابع الطلب مع المتجر.'} يُعاد التحقق من السعر والتوفّر عند الإنشاء.</p><details class="purchase-review-guides"><summary>المناطق والتنبيهات ووقت التنفيذ</summary>${review.items.map(guide).join('')}</details>${links ? '<div class="purchase-policy-links">' + links + '</div>' : ''}<form data-confirm><label class="purchase-check"><input name="reviewed" type="checkbox" required> <span>راجعت منطقة التفعيل وبيانات الطلب، وتأكدت من معرّف اللاعب إن كان مطلوبًا.</span></label><p data-purchase-error class="form-error" role="alert"></p><div class="purchase-footer"><button class="secondary" data-edit type="button">تعديل البيانات</button><button class="primary" type="submit">${draft.method === 'gateway' ? 'أنشئ الطلب وراجع فاتورة الدفع' : 'أنشئ الطلب وتابع على واتساب'}</button></div></form></div>`;
    const edit = root.querySelector('[data-edit]');
    edit.disabled = uncertain;
    edit.onclick = () => {
      attempt = null;
      editor();
    };
    root.querySelector('[data-confirm]').onsubmit = submit;
    titleFocus();
  }
  async function submit(e) {
    e.preventDefault();
    if (busy || !e.target.reportValidity()) return;
    busy = true;
    buttonLock(true);
    error('');
    try {
      attempt ??= {
        items: draft.items.map((x) => ({ ...x })),
        payment_method: draft.method,
        display_currency: review.currency,
        customer_note: draft.note,
        coupon_code: draft.coupon || '',
        expected_total_cents: review.total,
        idempotency_key: requestId(),
      };
      const r = await api('/api/orders', { method: 'POST', body: JSON.stringify(attempt) });
      complete(attempt.items);
      attempt = null;
      uncertain = false;
      if (draft.method === 'gateway') {
        location.assign('/payment.html?order=' + encodeURIComponent(r.order_id));
        return;
      }
      root.innerHTML = `<div class="purchase-checkout purchase-success"><span class="purchase-success-mark">✓</span><h2 tabindex="-1">طلبك محفوظ</h2><p>رقم الطلب: <bdi>#${esc(r.order_id.slice(0, 8))}</bdi></p><p class="purchase-muted">لسه ما تأكد الدفع. افتح واتساب وأرسل الرسالة للمتابعة.</p><a class="primary" target="_blank" rel="noopener noreferrer" href="${esc(r.whatsapp_url)}">افتح واتساب ↗</a><a class="secondary" href="/order.html?order=${encodeURIComponent(r.order_id)}">تفاصيل الطلب والدعم</a></div>`;
      draft = null;
      titleFocus();
    } catch (e) {
      uncertain = !e.status || e.status >= 500;
      if (!uncertain) attempt = null;
      error(
        uncertain
          ? 'تعذّر استلام نتيجة الطلب. ممكن يكون محفوظًا؛ أعد المحاولة من الزر نفسه حتى نتابع نفس الطلب بدون إنشاء نسخة ثانية.'
          : e.message,
      );
      buttonLock(false);
      root.querySelector('[data-edit]').disabled = uncertain;
    } finally {
      busy = false;
      unlockClose();
    }
  }
  async function checkout() {
    if (busy) return;
    document.getElementById('cart-dialog').close();
    if (uncertain && attempt && review) {
      confirmation();
      show();
      return;
    }
    const rows = getState().cart.map((x) => ({ ...x }));
    if (!rows.length) return;
    busy = true;
    try {
      const user = await session();
      if (!user) {
        root.innerHTML =
          '<div class="purchase-checkout"><h2>سجّل الدخول لإكمال الطلب</h2><p>سلتك محفوظة. ارجع للمتجر بعد تسجيل الدخول.</p><a class="primary" href="/login">تسجيل الدخول</a></div>';
        show();
        return;
      }
      draft = { items: rows, method: '', note: '' };
      editor();
      show();
      titleFocus();
    } catch (e) {
      root.innerHTML = '<h2>تعذّر فتح الطلب</h2><p>' + esc(e.message) + '</p>';
      show();
    } finally {
      busy = false;
    }
  }
  return { view, checkout };
}
