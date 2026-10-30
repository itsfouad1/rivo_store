export const homeDefaults = () => ({
  version: 0,
  hero: {
    enabled: true,
    title: '',
    accent: '',
    description: '',
    button: 'اختار لعبتك',
    link: '/products.html',
  },
  featured: {
    enabled: true,
    mode: 'auto',
    title: 'اختيارات من عالم ريفو',
    description: 'شحن وبطاقات رقمية، اختار اللي بناسبك.',
    limit: 8,
    product_ids: [],
  },
  banners: [],
});
export function selectHomeGroups(groups, config) {
  if (!config.enabled) return [];
  if (config.mode === 'manual') {
    const selected = [];
    for (const id of config.product_ids) {
      const g = groups.find((g) => g.variants.some((p) => p.id === id));
      if (g && !selected.includes(g)) selected.push(g);
    }
    return selected.slice(0, config.limit);
  }
  return [...groups]
    .sort((a, b) => Number(b.available) - Number(a.available))
    .slice(0, config.limit);
}
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function renderHomeContent(home, store) {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  hero.hidden = !home.hero.enabled;
  document.getElementById('hero-title').innerHTML =
    esc(home.hero.title || store.heroTitle) +
    '<br><span>' +
    esc(home.hero.accent || store.heroAccent) +
    '</span>';
  document.getElementById('hero-description').textContent =
    home.hero.description || store.heroDescription;
  const button = hero.querySelector('.hero-copy .primary');
  button.href = home.hero.link;
  button.innerHTML = esc(home.hero.button) + ' <span>←</span>';
  const featured = document.querySelector('.home-featured');
  featured.hidden = !home.featured.enabled;
  featured.querySelector('h2').textContent = home.featured.title;
  featured.querySelector('.featured-intro').textContent = home.featured.description;
  const banners = document.getElementById('home-banners');
  banners.innerHTML = home.banners
    .filter((b) => b.enabled)
    .map(
      (b) =>
        `<article class="home-promo promo-${b.theme}">${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" decoding="async">` : ''}<div class="home-promo-copy"><span class="kicker">من عالم ريفو</span><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p><a href="${esc(b.link)}">${esc(b.button)} <span>←</span></a></div></article>`,
    )
    .join('');
  banners.hidden = !banners.childElementCount;
}
