import { mountProductExtras } from './customer-growth-ui.js';
import { groupProducts, resolveGroup, groupUrl, kindLabels } from './product-groups.js';
import { availability } from './catalog.js';
import { regionNotice } from './purchase-ui.js';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function createProductPage({ getState, art, money, add, toast }) {
  const root = document.getElementById('product-page');
  let selectedId = new URLSearchParams(location.search).get('id') || '',
    region = new URLSearchParams(location.search).get('region') || '',
    quantity = 1;
  const payment = (state) => ({
    gatewayReady: state.gatewayReady,
    whatsapp: state.config.whatsapp,
  });
  function render() {
    if (!root) return;
    const state = getState(),
      groups = groupProducts(state.products, state.definitions, payment(state));
    const group = resolveGroup(groups, new URLSearchParams(location.search));
    if (!group) {
      root.innerHTML =
        '<div class="empty"><h1>المنتج غير متاح حاليًا</h1><p>قد يكون الرابط قديمًا أو المنتج غير منشور.</p><a class="primary" href="/products.html">ارجع للمنتجات</a></div>';
      return;
    }
    if (!group.regions.includes(region)) region = '';
    const variants = group.variants.filter((p) => !region || p.region === region);
    const selected = variants.find((p) => p.id === selectedId);
    const cover = selected || group.representative;
    const available = selected && availability(selected, payment(state)).available;
    const min = selected?.min_quantity ?? 1,
      max = Math.min(99, selected?.max_quantity ?? 99);
    quantity = Math.max(min, Math.min(quantity, max || min));
    document.title = (selected?.name || group.title) + ' — RIVO | ريفو';
    const description = document.querySelector('meta[name="description"]');
    if (description)
      description.content =
        selected?.description ||
        'تصفح فئات ' + group.title + ' في ريفو، وراجع المنطقة وتعليمات الاستخدام قبل الطلب.';
    root.innerHTML = `<div class="product-breadcrumb"><a href="/">الرئيسية</a><span>/</span><a href="/products.html">المنتجات</a><span>/</span><span>${esc(group.title)}</span></div>
      <div class="product-page-heading"><div><span class="kicker">${esc(kindLabels[group.kind])}</span><h1>${esc(group.title)}</h1><p>${group.variants.length} فئة متاحة للتصفح · اختار المنطقة والفئة المناسبة لحسابك</p></div><a class="browse-all" href="/products.html">كل المنتجات ←</a></div>
      <div class="product-layout"><section class="variant-panel" aria-label="اختيار الفئة"><div class="variant-heading"><h2><span>01</span> اختار فئتك</h2><label>منطقة التفعيل<select id="variant-region"><option value="">كل المناطق</option>${group.regions.map((r) => `<option value="${esc(r)}" ${r === region ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label></div><p class="variant-help">منطقة التفعيل تخص حسابك، وتغيير عملة العرض لا يغيّرها.</p>
      <fieldset class="variant-options"><legend class="sr-only">فئات ${esc(group.title)}</legend>${
        variants
          .map((p) => {
            const a = availability(p, payment(state));
            return `<label class="variant-option ${p.id === selected?.id ? 'selected' : ''}"><input type="radio" name="variant" value="${esc(p.id)}" ${p.id === selected?.id ? 'checked' : ''}><span><strong>${esc(p.name)}</strong><small>${esc(p.region || 'المنطقة غير محددة')} · ${esc(a.label)}</small></span><b>${esc(money(p.price_cents, p.currency))}</b></label>`;
          })
          .join('') || '<p>لا توجد فئات لهذه المنطقة.</p>'
      }</fieldset>
      <div class="product-guidance"><h2><span>02</span> راجع التفاصيل</h2>${selected ? `<h3>${esc(selected.name)}</h3><p>${esc(selected.description || 'لم تُضف تفاصيل إضافية لهذه الفئة.')}</p><div class="product-facts"><div><small>المنطقة</small><strong>${esc(selected.region || 'غير محددة')}</strong></div><div><small>وقت التنفيذ المتوقع</small><strong>${esc(selected.delivery_estimate || 'غير محدد — اسأل الدعم')}</strong></div><div><small>طريقة الطلب</small><strong>${esc({ whatsapp: 'عبر واتساب', gateway: 'بوابة الدفع', both: 'واتساب أو بوابة الدفع' }[selected.payment_mode])}</strong></div><div><small>بيانات الحساب</small><strong>${selected.account_type === 'steam' ? 'اسم حساب Steam — يُتحقق منه عند الطلب' : selected.player_id_required ? 'معرّف اللاعب / الحساب عند الطلب' : 'لا يتطلب معرّف حساب'}</strong></div></div><p class="region-advice">${esc(regionNotice(selected.region))}</p>${selected.purchase_notice ? `<div class="purchase-warning"><strong>انتبه قبل الشراء</strong><p>${esc(selected.purchase_notice)}</p></div>` : ''}<h3>التفعيل والاستخدام</h3><p>${esc(selected.activation_instructions || 'تعليمات الاستخدام غير مضافة. تواصل مع الدعم قبل الشراء إذا احتجت توضيحًا.')}</p>` : '<p>اختار فئة بالأعلى لعرض وصفها وتعليماتها ووقت تنفيذها. التفاصيل تختلف من فئة لثانية.</p>'}</div></section>
      <aside class="product-buy-panel"><div class="product-page-art">${art(selected ? cover : { ...cover, name: group.title })}</div><div class="product-buy-content"><span class="kicker">${selected ? 'فئتك المختارة' : 'خطوتك الجاية'}</span><h2>${esc(selected?.name || 'اختار الفئة المناسبة')}</h2><div class="product-buy-price">${selected ? esc(money(selected.price_cents, selected.currency)) : '<small>السعر يظهر بعد اختيار الفئة</small>'}</div>${selected ? `<span class="stock-label ${available ? '' : 'unavailable'}">${esc(availability(selected, payment(state)).label)}</span>` : ''}<label class="product-quantity">الكمية<input id="variant-quantity" type="number" inputmode="numeric" min="${min}" max="${max}" value="${quantity}" step="1" ${selected && available ? '' : 'disabled'}></label><button class="primary" id="variant-add" ${available ? '' : 'disabled'}>أضف للسلة <span>＋</span></button><p class="variant-help">${selected?.player_id_required ? 'بيانات اللاعب أو الحساب تُدخل عند متابعة الطلب. لا ترسل كلمة المرور.' : 'راجع فئتك ومنطقتها قبل متابعة الطلب.'}</p><button class="product-share" id="product-share">نسخ رابط ${selected ? 'الفئة' : 'المنتج'} ↗</button><p class="variant-help">لا يتم إنشاء طلب أو خصم مبلغ عند الإضافة للسلة.</p></div></aside></div>`;
    mountProductExtras(root, selected, group.variants);
    root.querySelector('#variant-region').onchange = (e) => {
      region = e.target.value;
      if (!group.variants.some((p) => p.id === selectedId && (!region || p.region === region)))
        selectedId = '';
      quantity = 1;
      render();
    };
    root.querySelectorAll('[name="variant"]').forEach(
      (input) =>
        (input.onchange = () => {
          selectedId = input.value;
          quantity = 1;
          const url = new URL(location.href);
          url.searchParams.set('group', group.id);
          url.searchParams.set('id', selectedId);
          history.replaceState(null, '', url);
          render();
          root.querySelector('[name="variant"]:checked')?.focus();
        }),
    );
    root.querySelector('#variant-quantity').oninput = (e) => {
      quantity = Number(e.target.value);
    };
    root.querySelector('#variant-add').onclick = () => {
      if (!selected || !available) return;
      if (!Number.isInteger(quantity) || quantity < min || quantity > max) {
        toast('راجع الكمية المتاحة لهذه الفئة');
        return;
      }
      try {
        add(selected.id, quantity);
      } catch (e) {
        toast(e.message);
      }
    };
    root.querySelector('#product-share').onclick = async () => {
      const path = selected
        ? '/product.html?id=' + encodeURIComponent(selected.id)
        : groupUrl(group);
      try {
        await navigator.clipboard.writeText(location.origin + path);
        toast('تم نسخ الرابط');
      } catch {
        toast('انسخ رابط الصفحة من شريط العنوان');
      }
    };
  }
  return { render };
}
