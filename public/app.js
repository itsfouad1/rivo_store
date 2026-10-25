import { filterProducts, availability } from './catalog.js';
const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
const supportedCurrencies = ['ILS', 'JOD', 'EGP', 'SAR', 'AED', 'USD', 'TRY'];
let gatewayReady = false,
  gatewayMode = 'test',
  region = '',
  onlyAvailable = false,
  changingCurrency = false;
const paymentOptions = () => ({ gatewayReady, whatsapp: config.whatsapp });
const productState = (p) => availability(p, paymentOptions());
let products = [],
  config = {},
  market = {},
  user = null,
  category = 'الكل',
  term = '',
  sort = 'default',
  cart = [],
  pendingToken = null,
  selectedCurrency = supportedCurrencies.includes(localStorage.getItem('rivo-currency'))
    ? localStorage.getItem('rivo-currency')
    : 'ILS';
const labels = { whatsapp: 'طلب واتساب', gateway: 'بوابة الدفع', both: 'واتساب / بوابة الدفع' };
const money = (n, c = 'USD') =>
  new Intl.NumberFormat('ar', { style: 'currency', currency: c }).format(n / 100);
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  let d;
  try {
    d = await res.json();
  } catch {
    throw new Error('تعذّر الاتصال؛ حاول مجددًا');
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('سجّل الدخول أولًا من حسابي لإكمال الطلب');
    throw new Error(d.error || 'تعذّر إكمال العملية');
  }
  return d;
}
try {
  const old = JSON.parse(localStorage.getItem('rivo-cart-v3') || '[]');
  if (Array.isArray(old))
    cart = old.filter(
      (x) =>
        typeof x.id === 'string' &&
        Number.isInteger(x.quantity) &&
        x.quantity > 0 &&
        x.quantity <= 99,
    );
} catch {}
function art(p, button = false) {
  const name = p.name.toLowerCase();
  const skin = name.includes('pubg')
    ? 'pubg'
    : name.includes('free fire')
      ? 'fire'
      : name.includes('playstation')
        ? 'ps'
        : name.includes('steam')
          ? 'steam'
          : name.includes('xbox')
            ? 'xbox'
            : 'pass';
  return `<${button ? 'button' : 'div'} class="product-cover cover-${skin}" ${button ? `data-view="${p.id}" aria-label="تفاصيل ${esc(p.name)}"` : ''}>${p.image_url ? `<img src="${esc(p.image_url)}" class="product-img" alt="${esc(p.name)}">` : `<span class="art-icon">✦</span><strong>${esc(p.name.slice(0, 24))}</strong><small>RIVO DIGITAL</small>`}</${button ? 'button' : 'div'}>`;
}
function filters() {
  const regions = [...new Set(products.map((p) => p.region).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'ar'),
  );
  if (!regions.includes(region)) region = '';
  $('region').innerHTML =
    '<option value="">كل المناطق</option>' +
    regions.map((r) => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
  $('region').value = region;
  document.querySelectorAll('.price-currency').forEach((x) => (x.textContent = selectedCurrency));
  const cats = ['الكل', ...new Set(products.map((p) => p.category))];
  if (!cats.includes(category)) category = 'الكل';
  $('filters').innerHTML = cats
    .map(
      (c) =>
        `<button data-category="${esc(c)}" class="${category === c ? 'active' : ''}" aria-pressed="${category === c}">${esc(c)}</button>`,
    )
    .join('');
}
function render() {
  const min = $('price-min').value,
    max = $('price-max').value;
  const invalid =
    (min !== '' && Number(min) < 0) ||
    (max !== '' && Number(max) < 0) ||
    (min !== '' && max !== '' && Number(min) > Number(max));
  $('filter-error').textContent = invalid
    ? 'أدخل حدود سعر صحيحة: من يجب أن يكون أقل من أو يساوي إلى.'
    : '';
  const list = invalid
    ? []
    : filterProducts(
        products,
        { category, term, sort, region, onlyAvailable, min, max },
        paymentOptions(),
      );
  $('grid').innerHTML = list
    .map(
      (p) =>
        `<article class="product ${productState(p).available ? '' : 'is-unavailable'}">${art(p, true)}<div class="product-body"><span class="stock-label ${productState(p).available ? '' : 'unavailable'}">${productState(p).label}</span><button class="product-title" data-view="${p.id}">${esc(p.name)}</button><p class="product-sub">${esc(p.region || p.category)} · ${labels[p.payment_mode]}</p><div class="product-bottom"><div class="product-price"><small>${esc(p.category)}</small><strong>${esc(money(p.price_cents, p.currency))}</strong></div><button class="details-btn" data-view="${p.id}">التفاصيل</button></div></div></article>`,
    )
    .join('');
  $('empty').hidden = list.length > 0;
  $('results').textContent = `المنتجات المعروضة: ${list.length}`;
  $('empty').querySelector('h3').textContent = 'ما لقينا منتجات';
  $('empty').querySelector('p').textContent = 'جرّب تخفيف الفلاتر أو البحث باسم آخر.';
  if (!products.length) {
    $('empty').querySelector('h3').textContent = 'منتجات ريفو قريبًا';
    $('empty').querySelector('p').textContent = 'عم نجهّز الكتالوج. تابعنا لتعرف الجديد.';
  }
  document.querySelectorAll('[data-category]').forEach((b) => {
    b.classList.toggle('active', b.dataset.category === category);
    b.setAttribute('aria-pressed', b.dataset.category === category);
  });
}
$('filters').onclick = (e) => {
  const b = e.target.closest('[data-category]');
  if (b) {
    category = b.dataset.category;
    render();
  }
};
$('search').oninput = (e) => {
  term = e.target.value.trim().toLowerCase();
  render();
};
$('sort').onchange = (e) => {
  sort = e.target.value;
  render();
};
$('market').onchange = async (e) => {
  if (changingCurrency) return;
  changingCurrency = true;
  const previous = selectedCurrency;
  selectedCurrency = e.target.value;
  $('market').disabled = true;
  $('checkout-button').disabled = true;
  pendingToken = null;
  try {
    await loadStore();
    localStorage.setItem('rivo-currency', selectedCurrency);
    $('price-min').value = '';
    $('price-max').value = '';
    filters();
    render();
    toast('تم تغيير العملة ومسح حدود السعر');
  } catch (err) {
    selectedCurrency = previous;
    $('market').value = previous;
    toast(err.message);
  } finally {
    changingCurrency = false;
    $('market').disabled = false;
    renderCart();
  }
};
function resetFilters() {
  category = 'الكل';
  term = '';
  sort = 'default';
  region = '';
  onlyAvailable = false;
  $('search').value = '';
  $('sort').value = 'default';
  $('region').value = '';
  $('available-only').checked = false;
  $('price-min').value = '';
  $('price-max').value = '';
  render();
}
$('reset').onclick = resetFilters;
$('clear-filters').onclick = resetFilters;
$('region').onchange = (e) => {
  region = e.target.value;
  render();
};
$('available-only').onchange = (e) => {
  onlyAvailable = e.target.checked;
  render();
};
['price-min', 'price-max'].forEach((id) => ($(id).oninput = render));
$('grid').onclick = (e) => {
  const b = e.target.closest('[data-view]');
  if (b) view(b.dataset.view);
};
function view(id) {
  const p = products.find((p) => p.id === id);
  if (!p) return;
  $('product-content').innerHTML =
    `${art(p)}<span class="kicker">${esc(p.category)}</span><h2>${esc(p.name)}</h2><p style="white-space:pre-wrap">${esc(p.description || 'راجع المنطقة والفئة قبل الطلب.')}</p><div class="product-spec"><span>السعر</span><strong>${esc(money(p.price_cents, p.currency))}</strong></div><div class="product-spec"><span>المنطقة / الدولة</span><strong>${esc(p.region || 'راجع تفاصيل المنتج')}</strong></div><div class="product-spec"><span>طريقة الطلب</span><strong>${labels[p.payment_mode]}</strong></div>${p.payment_mode !== 'whatsapp' && !gatewayReady ? '<p class="action-note">بوابة الدفع غير مربوطة بعد. ' + (p.payment_mode === 'both' ? 'يمكنك متابعة الطلب عبر واتساب.' : 'الطلب بهذا المنتج غير متاح حتى ربط البوابة.') + '</p>' : ''}${p.min_quantity > 1 ? '<p class="action-note">الحد الأدنى للطلب: ' + p.min_quantity + ' وحدة</p>' : ''}${p.player_id_required ? '<p class="action-note">يتطلب معرّف اللاعب، بدون كلمة المرور.</p>' : ''}<button class="primary" id="add-product" ${!productState(p).available ? 'disabled' : ''}>${!productState(p).available ? productState(p).label : 'أضف للسلة + '}</button>`;
  $('add-product').onclick = () => {
    if (!productState(p).available) return;
    const row = cart.find((x) => x.id === id);
    if (row) row.quantity = Math.min(p.max_quantity ?? 99, row.quantity + 1);
    else cart.push({ id, quantity: p.min_quantity ?? 1 });
    pendingToken = null;
    renderCart();
    $('product-dialog').close();
    toast('تمت الإضافة للسلة');
  };
  $('product-dialog').showModal();
}
function renderCart() {
  cart = cart.filter((x) => products.some((p) => p.id === x.id));
  const totalQty = cart.reduce((s, x) => s + x.quantity, 0);
  $('count').textContent = totalQty;
  $('cart-title-count').textContent = `(${totalQty})`;
  const total = cart.reduce((sum, x) => {
    const p = products.find((p) => p.id === x.id);
    return sum + p.price_cents * x.quantity;
  }, 0);
  $('total').textContent = money(total, selectedCurrency);
  $('cart-items').innerHTML = cart.length
    ? cart
        .map((x) => {
          const p = products.find((p) => p.id === x.id);
          return `<div class="cart-row"><div><h3>${esc(p.name)}</h3><small>${esc(money(p.price_cents * x.quantity, p.currency))}</small>${!productState(p).available ? '<span class="cart-stock-error">' + esc(productState(p).label) + ' — احذف المنتج للمتابعة</span>' : ''}<br><button class="remove" data-remove="${x.id}">حذف المنتج</button></div><div class="qty"><button data-qty="${x.id}" data-change="1" aria-label="زيادة ${esc(p.name)}">+</button><span>${x.quantity}</span><button data-qty="${x.id}" data-change="-1" aria-label="تقليل ${esc(p.name)}">−</button></div></div>`;
        })
        .join('')
    : '<div class="empty"><h3>سلتك لسه فاضية</h3><p>اختار منتج من المتجر.</p></div>';
  $('checkout-button').disabled =
    changingCurrency ||
    !cart.length ||
    cart.some((x) => !productState(products.find((p) => p.id === x.id)).available);
  try {
    localStorage.setItem('rivo-cart-v3', JSON.stringify(cart));
  } catch {}
}
$('cart-items').onclick = (e) => {
  const r = e.target.closest('[data-remove]'),
    q = e.target.closest('[data-qty]');
  if (r) cart = cart.filter((x) => x.id !== r.dataset.remove);
  if (q) {
    const row = cart.find((x) => x.id === q.dataset.qty);
    const p = products.find((p) => p.id === row.id);
    row.quantity = Math.min(p.max_quantity ?? 99, row.quantity + Number(q.dataset.change));
    if (row.quantity < (p.min_quantity ?? 1)) row.quantity = 0;
    cart = cart.filter((x) => x.quantity > 0);
  }
  if (r || q) {
    pendingToken = null;
    renderCart();
  }
};
$('cart-open').onclick = () => $('cart-dialog').showModal();
document
  .querySelectorAll('[data-close]')
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
document.querySelectorAll('dialog').forEach(
  (d) =>
    (d.onclick = (e) => {
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          d.close();
      }
    }),
);
$('checkout-button').onclick = () => {
  if (
    changingCurrency ||
    !cart.length ||
    cart.some((x) => !productState(products.find((p) => p.id === x.id)).available)
  )
    return;
  $('cart-dialog').close();
  if (!user) {
    $('product-content').innerHTML =
      '<h2>سجّل الدخول لإكمال الطلب</h2><a class="primary" href="/login">تسجيل الدخول ←</a>';
    $('product-dialog').showModal();
    return;
  }
  const selected = cart.map((x) => products.find((p) => p.id === x.id));
  const canWA =
    !!config.whatsapp && selected.every((p) => ['whatsapp', 'both'].includes(p.payment_mode));
  const canPay =
    gatewayReady && selected.every((p) => ['gateway', 'both'].includes(p.payment_mode));
  const required = selected.some((p) => p.player_id_required);
  $('product-content').innerHTML =
    `<h2>متابعة الطلب</h2><p>الدفع عبر Payunit بالدولار الأمريكي. سترى المبلغ النهائي وتؤكده قبل الانتقال للدفع.</p>
 ${gatewayMode === 'test' && canPay ? '<p class="action-note">وضع تجريبي للإدارة؛ لا يتم تحصيل أموال أو تسليم منتجات حقيقية.</p>' : ''}
 <form id="checkout-form"><div class="payment-choices">
 <label class="payment-choice"><input type="radio" name="method" value="gateway" ${canPay ? 'checked' : 'disabled'}> Payunit — الدفع بالدولار ${!gatewayReady ? '(غير متاح حاليًا)' : ''}</label>
 <label class="payment-choice"><input type="radio" name="method" value="whatsapp" ${canWA ? (!canPay ? 'checked' : '') : 'disabled'}> التواصل عبر واتساب</label></div>
 ${!canPay && !canWA ? '<p class="form-error">لا توجد طريقة طلب مشتركة متاحة لهذه المنتجات. عدّل السلة.</p>' : ''}
 <label class="field">معرّف اللاعب ${required ? '*' : '(اختياري)'}<input name="player_id" maxlength="150" ${required ? 'required' : ''}></label>
 <label class="field">ملاحظة للمتجر<textarea name="customer_note" maxlength="600"></textarea></label>
 <div id="checkout-error" class="form-error" role="alert"></div><button class="primary" type="submit" ${canPay || canWA ? '' : 'disabled'}>متابعة ومراجعة المبلغ</button></form>`;
  $('product-dialog').showModal();
  $('checkout-form').onchange = (e) => {
    if (e.target.name === 'method') pendingToken = null;
  };
  $('checkout-form').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('[type=submit]');
    button.disabled = true;
    try {
      pendingToken ??= crypto.randomUUID();
      const fd = new FormData(e.target);
      const r = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          items: cart,
          payment_method: fd.get('method'),
          display_currency: selectedCurrency,
          player_id: fd.get('player_id'),
          customer_note: fd.get('customer_note'),
          idempotency_key: pendingToken,
        }),
      });
      if (fd.get('method') === 'gateway') {
        // Keep the saved order reachable after refresh, without creating another order.
        cart = [];
        pendingToken = null;
        renderCart();
        location.assign('/payment.html?order=' + encodeURIComponent(r.order_id));
        return;
      }
      cart = [];
      pendingToken = null;
      renderCart();
      $('product-content').innerHTML =
        `<h2>تم حفظ طلبك 💜</h2><p>#${esc(r.order_id.slice(0, 8))}</p><a href="${esc(r.whatsapp_url)}" rel="noopener noreferrer" target="_blank" class="primary">افتح واتساب وأرسل الرسالة ↗</a><p>الطلب غير مدفوع حتى تؤكد الإدارة استلام المبلغ.</p><a href="/account">متابعة طلباتي</a>`;
    } catch (error) {
      $('checkout-error').textContent = error.message;
      button.disabled = false;
    }
  };
};

let timer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => $('toast').classList.remove('show'), 2500);
}
document.querySelectorAll('[data-hero]').forEach(
  (b) =>
    (b.onclick = () => {
      $('hero-game').textContent = b.dataset.hero;
      document.querySelectorAll('[data-hero]').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-pressed', x === b);
      });
      document.querySelector('.front-card').style.transform =
        b.dataset.hero === 'YOUR NEXT GIFT'
          ? 'rotate(-3deg)'
          : b.dataset.hero === 'MORE TO_EXPLORE'
            ? 'rotate(3deg)'
            : 'rotate(10deg)';
    }),
);
$('year').textContent = new Date().getFullYear();
async function loadStore() {
  const r = await api('/api/store?currency=' + encodeURIComponent(selectedCurrency));
  products = r.products;
  config = r.settings;
  market = r.market;
  gatewayReady = r.gatewayReady;
  gatewayMode = r.gatewayMode;
  $('market').innerHTML = market.countries
    .map((x) => `<option value="${x.currency}">${esc(x.label)} — ${x.currency}</option>`)
    .join('');
  $('market').value = selectedCurrency;
}
async function boot() {
  try {
    await loadStore();
    $('hero-title').innerHTML =
      esc(config.heroTitle) + '<br><span>' + esc(config.heroAccent) + '</span>';
    $('hero-description').textContent = config.heroDescription;
    $('tagline').textContent = config.tagline;
    $('announcement').textContent = config.announcement;
    document.title = config.storeName + ' — ' + config.tagline;
    filters();
    render();
    renderCart();
    try {
      user = (await api('/api/session')).user;
      if (user) {
        $('account-link').textContent = user.role === 'admin' ? 'لوحة الإدارة' : 'حسابي';
        $('account-link').href = user.role === 'admin' ? '/admin' : '/account';
      }
    } catch {}
  } catch (e) {
    $('empty').hidden = false;
    $('empty').querySelector('h3').textContent = 'تعذّر تحميل المنتجات';
    $('empty').querySelector('p').textContent = e.message;
    $('checkout-button').disabled = true;
    toast(e.message);
  }
}
boot();
