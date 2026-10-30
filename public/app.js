import { groupProducts, groupUrl, kindLabels } from './product-groups.js';
import { createProductPage } from './product-page.js';
import { homeDefaults, selectHomeGroups, renderHomeContent } from './home-content.js';
import { filterProducts, availability, catalogPage, featuredProducts } from './catalog.js';
import { createPurchaseUI } from './purchase-ui.js';
const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
const supportedCurrencies = ['ILS', 'JOD', 'EGP', 'SAR', 'AED', 'USD', 'TRY'];
const fullCatalog = document.body.dataset.catalog === 'full';
const productPage = document.body.dataset.catalog === 'product';
let definitions = [], productType = '';
let homeContent = homeDefaults();
const favoritesOnly = fullCatalog && new URLSearchParams(location.search).get('favorites') === '1';
let favoriteIds = [];
const groups = () => groupProducts(products, definitions, paymentOptions());
let currentPage = 1;
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
let publishedPolicies = [];
const policyLinks = () =>
  publishedPolicies
    .map(
      (p) =>
        '<a href="/policy.html?type=' +
        p.type +
        '" target="_blank" rel="noopener noreferrer">' +
        esc(p.title) +
        '</a>',
    )
    .join('');
async function loadPolicies() {
  try {
    const r = await api('/api/policies');
    publishedPolicies = r.pages;
    $('store-policy-links').innerHTML = policyLinks();
  } catch {}
}
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
    if (res.status === 401) {
      const error = new Error('سجّل الدخول أولًا من حسابي لإكمال الطلب');
      error.status = 401;
      throw error;
    }
    const error = new Error(d.error || 'تعذّر إكمال العملية');
    error.status = res.status;
    throw error;
  }
  return d;
}
const purchase = createPurchaseUI({
  api,
  getState: () => ({
    products,
    config,
    user,
    gatewayReady,
    gatewayMode,
    currency: selectedCurrency,
    cart,
  }),
  art,
  policyLinks,
  refresh: async () => {
    await loadStore();
    filters();
    render();
    renderCart();
  },
  session: async () => {
    user = (await api('/api/session')).user;
    return user;
  },
  add: addToCart,
  complete: (submitted) => {
    cart = cart
      .map((row) => ({
        ...row,
        quantity: row.quantity - (submitted.find((x) => x.id === row.id)?.quantity || 0),
      }))
      .filter((row) => row.quantity > 0);
    pendingToken = null;
    renderCart();
  },
});
function addToCart(id, quantity) {
    const p = products.find((p) => p.id === id);
    if (!p || !productState(p).available) throw Error('المنتج غير متاح.');
    if (!Number.isInteger(quantity) || quantity < (p.min_quantity ?? 1)) throw Error('راجع كمية المنتج');
    const row = cart.find((x) => x.id === id),
      total = (row?.quantity || 0) + quantity;
    if (total > Math.min(99, p.max_quantity ?? 99))
      throw Error('الكمية الإجمالية تتجاوز الحد المتاح.');
    if (row) row.quantity = total;
    else cart.push({ id, quantity });
    pendingToken = null;
    renderCart();
    toast('تمت الإضافة للسلة');
  }
const productDetail = productPage ? createProductPage({getState: () => ({products, definitions, config, gatewayReady}), art, money, add: addToCart, toast}) : null;
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
  return `<${button ? 'button' : 'div'} class="product-cover cover-${skin}" ${button ? `data-view="${p.id}" aria-label="تفاصيل ${esc(p.name)}"` : ''}>${p.image_url ? `<img src="${esc(p.image_url)}" class="product-img" loading="lazy" decoding="async" alt="${esc(p.name)}">` : `<span class="art-icon">✦</span><strong>${esc(p.name)}</strong><small>RIVO DIGITAL</small>`}</${button ? 'button' : 'div'}>`;
}
function filters() {
  if (!$('filters')) return;
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
  if (productPage) { productDetail.render(); return; }
  const min = $('price-min')?.value ?? '',
    max = $('price-max')?.value ?? '';
  const invalid =
    (min !== '' && Number(min) < 0) ||
    (max !== '' && Number(max) < 0) ||
    (min !== '' && max !== '' && Number(min) > Number(max));
  if ($('filter-error')) $('filter-error').textContent = invalid
    ? 'أدخل حدود سعر صحيحة: من يجب أن يكون أقل من أو يساوي إلى.'
    : '';
  const list = invalid
    ? []
    : filterProducts(
        favoritesOnly ? products.filter(p=>favoriteIds.includes(p.id)) : products,
        { category, term, sort, region, onlyAvailable, min, max },
        paymentOptions(),
      );
  let grouped = groupProducts(list, definitions, paymentOptions()).filter(g=>!productType||g.kind===productType);
  if (sort === 'low') grouped.sort((a,b)=>a.price_cents-b.price_cents);
  if (sort === 'high') grouped.sort((a,b)=>b.price_cents-a.price_cents);
  if (sort === 'name') grouped.sort((a,b)=>a.title.localeCompare(b.title,'ar'));
  if (!fullCatalog) grouped.sort((a,b)=>Number(b.available)-Number(a.available));
  const selection = fullCatalog ? catalogPage(grouped, currentPage, 12) : { items: selectHomeGroups(grouped, homeContent.featured), page: 1, totalPages: 1 };
  currentPage = selection.page;
  const visible = selection.items;
  $('grid').setAttribute('aria-busy', 'false');
  $('grid').innerHTML = visible.map(g => {
    const p = {...g.representative, name:g.title};
    return `<article class="product ${g.available?'':'is-unavailable'}"><a class="group-cover" href="${esc(groupUrl(g)+(region?'&region='+encodeURIComponent(region):''))}" aria-label="تصفح فئات ${esc(g.title)}">${art(p)}</a><div class="product-body"><span class="stock-label ${g.available?'':'unavailable'}">${g.available?'فئات متاحة للطلب':'غير متاح للطلب حاليًا'}</span><a class="product-title" href="${esc(groupUrl(g)+(region?'&region='+encodeURIComponent(region):''))}">${esc(g.title)}</a><p class="product-sub">${esc(kindLabels[g.kind])} · ${g.variants.length} فئة${g.regions.length?' · '+g.regions.length+' منطقة':''}</p><div class="product-bottom"><div class="product-price"><small>يبدأ من</small><strong>${esc(money(g.price_cents,g.currency))}</strong></div><a class="details-btn" href="${esc(groupUrl(g)+(region?'&region='+encodeURIComponent(region):''))}">اختار الفئة ←</a></div></div></article>`;
  }).join('');
  $('empty').hidden = grouped.length > 0;
  $('results').textContent = fullCatalog
    ? (grouped.length ? `عرض ${(currentPage - 1) * 12 + 1}–${(currentPage - 1) * 12 + visible.length} من ${grouped.length} مجموعة` : 'لا توجد نتائج')
    : `عرض ${visible.length} من ${grouped.length} مجموعة`;
  renderPages(selection.totalPages);
  $('empty').querySelector('h3').textContent = 'ما لقينا منتجات';
  $('empty').querySelector('p').textContent = 'جرّب تخفيف الفلاتر أو البحث باسم آخر.';
  if(favoritesOnly&&!grouped.length)$('empty').querySelector('p').textContent='لا توجد فئات في مفضلتك تطابق هذه الفلاتر. أضف فئات من صفحات المنتجات أولًا.';
  if (!products.length) {
    $('empty').querySelector('h3').textContent = 'منتجات ريفو قريبًا';
    $('empty').querySelector('p').textContent = 'عم نجهّز الكتالوج. تابعنا لتعرف الجديد.';
  }
  if (!fullCatalog && products.length && !visible.length) {
    $('empty').hidden = false;
    $('empty').querySelector('h3').textContent = 'اختيارات جديدة قريبًا';
    $('empty').querySelector('p').textContent = 'تقدر تتصفح كل المنتجات من الرابط أدناه.';
  }
  document.querySelectorAll('[data-category]').forEach((b) => {
    b.classList.toggle('active', b.dataset.category === category);
    b.setAttribute('aria-pressed', b.dataset.category === category);
  });
}
function renderPages(total) {
  const target = $('catalog-pages');
  if (!target) return;
  target.hidden = total <= 1;
  const pages = [...new Set([1, currentPage - 1, currentPage, currentPage + 1, total])].filter(p => p > 0 && p <= total).sort((a,b) => a-b);
  let previous = 0;
  target.innerHTML = `<button data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>السابق</button>` + pages.map(p => {
    const gap = previous && p - previous > 1 ? '<span aria-hidden="true">…</span>' : '';
    previous = p;
    return gap + `<button data-page="${p}" ${p === currentPage ? 'aria-current="page"' : ''} aria-label="صفحة ${p}">${p}</button>`;
  }).join('') + `<button data-page="${currentPage + 1}" ${currentPage === total ? 'disabled' : ''}>التالي</button>`;
}
$('catalog-pages')?.addEventListener('click', e => {
  const button = e.target.closest('button[data-page]');
  if (!button || button.disabled) return;
  currentPage = Number(button.dataset.page);
  render();
  $('catalog').scrollIntoView({block: 'start'});
});
document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{productType=b.dataset.kind;currentPage=1;document.querySelectorAll('[data-kind]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b))});render()});
$('filters')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-category]');
  if (b) {
    category = b.dataset.category;
    currentPage = 1;
    render();
  }
});
$('search')?.addEventListener('input', (e) => {
  term = e.target.value.trim().toLowerCase();
  currentPage = 1;
  render();
});
$('sort')?.addEventListener('change', (e) => {
  sort = e.target.value;
  currentPage = 1;
  render();
});
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
    if ($('price-min')) $('price-min').value = '';
    if ($('price-max')) $('price-max').value = '';
    currentPage = 1;
    filters();
    render();
    toast(fullCatalog ? 'تم تغيير العملة ومسح حدود السعر' : 'تم تغيير عملة العرض');
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
  currentPage = 1;
  category = 'الكل';
  productType = '';
  document.querySelectorAll('[data-kind]').forEach(b=>{b.classList.toggle('active',b.dataset.kind==='');b.setAttribute('aria-pressed',String(b.dataset.kind===''))});
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
$('reset')?.addEventListener('click', resetFilters);
if(favoritesOnly){document.querySelector('.catalog .section-heading h2').textContent='مفضلتي';$('reset').textContent='تصفح كل المنتجات';$('reset').onclick=()=>location.assign('/products.html');}
$('clear-filters')?.addEventListener('click', resetFilters);
$('region')?.addEventListener('change', (e) => {
  region = e.target.value;
  currentPage = 1;
  render();
});
$('available-only')?.addEventListener('change', (e) => {
  onlyAvailable = e.target.checked;
  currentPage = 1;
  render();
});
['price-min', 'price-max'].forEach((id) => $(id)?.addEventListener('input', () => { currentPage = 1; render(); }));
if ($('grid')) $('grid').onclick = (e) => {
  const b = e.target.closest('[data-view]');
  if (b) view(b.dataset.view);
};
function view(id) {
  purchase.view(id);
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
  if (!changingCurrency) purchase.checkout();
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
    try { definitions = (await api('/api/collections')).groups; } catch { toast('تعذّر تحميل تنظيم المنتجات؛ يظهر التجميع التلقائي مؤقتًا'); }
    if (!fullCatalog && !productPage) {
      try { homeContent = await api('/api/homepage'); } catch { toast('تعذّر تحميل تخصيص الرئيسية؛ يظهر التصميم الأساسي مؤقتًا'); }
      renderHomeContent(homeContent, config);
    }
    await loadPolicies();
    if ($('hero-title') && !document.querySelector('.home-featured')) $('hero-title').innerHTML =
      esc(config.heroTitle) + '<br><span>' + esc(config.heroAccent) + '</span>';
    if ($('hero-description') && !document.querySelector('.home-featured')) $('hero-description').textContent = config.heroDescription;
    if ($('tagline')) $('tagline').textContent = config.tagline;
    if ($('announcement')) $('announcement').textContent = config.announcement;
    document.title = fullCatalog ? (favoritesOnly?'مفضلتي — ':'المنتجات — ') + config.storeName : config.storeName + ' — ' + config.tagline;
    filters();
    render();
    renderCart();
    const deepProduct = new URLSearchParams(location.search).get('product');
    if (!productPage && deepProduct && products.some((p) => p.id === deepProduct)) view(deepProduct);
    try {
      user = (await api('/api/session')).user;
      if(favoritesOnly){if(user){favoriteIds=(await api('/api/customer/favorites')).ids;render();}else{toast('سجّل الدخول لعرض المفضلة');$('empty').hidden=false;$('empty').querySelector('p').innerHTML='<a href="/login">سجّل الدخول لعرض مفضلتك</a>';}}
      const repeat=new URLSearchParams(location.search).get('reorder');
      if(repeat&&!user)toast('سجّل الدخول من حسابك ثم افتح إعادة الطلب');
      if(repeat&&user){const r=await api('/api/customer/reorder/'+encodeURIComponent(repeat));let added=0;for(const row of r.items){const p=products.find(p=>p.id===row.id);if(!p||!productState(p).available)continue;const existing=cart.find(x=>x.id===row.id)?.quantity||0,qty=Math.min(row.quantity,(p.max_quantity??99)-existing,99-existing);if(qty<(p.min_quantity??1)||(p.account_type==='steam'&&existing))continue;addToCart(p.id,p.account_type==='steam'?1:qty);added++;}toast(added?'تمت إضافة '+added+' منتج متاح للسلة؛ راجع الكميات وبيانات الحساب':'منتجات الطلب غير متاحة للطلب الآن');$('cart-dialog').showModal();const clean=new URL(location.href);clean.searchParams.delete('reorder');history.replaceState(null,'',clean);}
      if (user) {
        $('account-link').textContent = ['owner', 'admin', 'support'].includes(user.role)
          ? 'لوحة الإدارة'
          : 'حسابي';
        $('account-link').href = ['owner', 'admin', 'support'].includes(user.role)
          ? '/admin'
          : '/account';
      }
    } catch (e) { if(favoritesOnly||new URLSearchParams(location.search).has('reorder'))toast(e.message); }
  } catch (e) {
    if (productPage) { $('product-page').innerHTML = '<div class=empty><h1>تعذّر تحميل المنتج</h1><p>'+esc(e.message)+'</p><a class=primary href=/products.html>ارجع للمنتجات</a></div>'; toast(e.message); return; }
    $('grid').setAttribute('aria-busy', 'false');
    $('grid').innerHTML = '';
    $('empty').hidden = false;
    $('empty').querySelector('h3').textContent = 'تعذّر تحميل المنتجات';
    $('empty').querySelector('p').textContent = e.message;
    $('checkout-button').disabled = true;
    toast(e.message);
  }
}
boot();
