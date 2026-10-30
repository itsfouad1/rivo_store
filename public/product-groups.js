import { availability, searchText } from './catalog.js';
export const kindLabels = { topup: 'شحن الألعاب', cards: 'البطاقات الرقمية', subscriptions: 'الاشتراكات', other: 'منتجات أخرى' };
export function productKind(p) {
  if (p.account_type === 'steam' || p.player_id_required) return 'topup';
  const name = searchText(p.name + ' ' + p.category);
  if (/subscription|اشتراك|game pass|plus|membership/.test(name)) return 'subscriptions';
  if (/card|gift|بطاق|كود|code|steam|playstation|xbox/.test(name)) return 'cards';
  return 'other';
}
const brands = [
  ['pubg-mobile','PUBG Mobile',/pubg\s*mobile|ببجي\s*موبايل|بوبجي/],
  ['pubg','PUBG',/\bpubg\b|ببجي/],
  ['free-fire','Free Fire',/free\s*fire|فري\s*فاير/],
  ['steam','Steam',/\bsteam\b|ستيم/],
  ['playstation','PlayStation',/playstation|play\s*station|بلايستيشن|بلاي\s*ستيشن|\bpsn\b/],
  ['xbox','Xbox',/\bxbox\b|اكس\s*بوكس/],
  ['roblox','Roblox',/\broblox\b|روبلوكس/],
  ['valorant','VALORANT',/\bvalorant\b|فالورانت/],
  ['genshin','Genshin Impact',/genshin\s*impact|جينشن/],
  ['mobile-legends','Mobile Legends',/mobile\s*legends|موبايل\s*ليجند/],
];
export function groupProducts(products, definitions = [], payment = {}) {
  const grouped = new Map(), overrides = new Map();
  for (const d of definitions) for (const id of d.product_ids) overrides.set(id,d);
  for (const p of products) {
    const manual = overrides.get(p.id), kind = manual?.kind || productKind(p);
    const brand = brands.find(([, , re]) => re.test(searchText(p.name)));
    const id = manual ? 'custom:' + manual.id : brand ? brand[0] + ':' + kind : 'product:' + p.id;
    const title = manual?.title || (brand ? brand[1] : p.name);
    if (!grouped.has(id)) grouped.set(id, {id, title, kind, variants: [], category: p.category});
    grouped.get(id).variants.push(p);
  }
  return [...grouped.values()].map(g => {
    const available = g.variants.filter(p => availability(p,payment).available);
    const priced = available.length ? available : g.variants;
    const representative = priced.find(p => p.image_url) || priced[0];
    return {...g, representative, available: !!available.length,
      price_cents: Math.min(...priced.map(p => p.price_cents)), currency: representative.currency,
      regions: [...new Set(g.variants.map(p=>p.region).filter(Boolean))]};
  });
}
export const groupUrl = g => '/product.html?group=' + encodeURIComponent(g.id);
export function resolveGroup(groups, params) {
  const id = params.get('id');
  return id ? groups.find(g=>g.variants.some(p=>p.id===id)) : groups.find(g=>g.id===params.get('group'));
}
