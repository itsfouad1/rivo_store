export function searchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}
export function availability(product, { gatewayReady = false, whatsapp = '' } = {}) {
  if (product.available === false) return { available: false, label: 'غير متوفر حاليًا' };
  const wa = !!whatsapp && ['whatsapp', 'both'].includes(product.payment_mode);
  const pay = gatewayReady && ['gateway', 'both'].includes(product.payment_mode);
  return wa || pay
    ? { available: true, label: 'متاح للطلب' }
    : { available: false, label: 'طريقة الدفع غير متاحة' };
}
export function filterProducts(products, options = {}, payment = {}) {
  const words = searchText(options.term).split(' ').filter(Boolean);
  const min = options.min === '' || options.min == null ? null : Number(options.min);
  const max = options.max === '' || options.max == null ? null : Number(options.max);
  const list = products.filter(
    (p) =>
      (!options.category || options.category === 'الكل' || p.category === options.category) &&
      (!options.region || p.region === options.region) &&
      (!options.onlyAvailable || availability(p, payment).available) &&
      (min === null || p.price_cents >= Math.round(min * 100)) &&
      (max === null || p.price_cents <= Math.round(max * 100)) &&
      words.every((w) =>
        searchText([p.name, p.description, p.category, p.region].join(' ')).includes(w),
      ),
  );
  if (options.sort === 'low') list.sort((a, b) => a.price_cents - b.price_cents);
  if (options.sort === 'high') list.sort((a, b) => b.price_cents - a.price_cents);
  if (options.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return list;
}
