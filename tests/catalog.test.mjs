import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterProducts,
  availability,
  catalogPage,
  featuredProducts,
} from '../public/js/catalog.js';
const products = [
  {
    id: 'a',
    name: 'بِطاقة ألعاب Steam',
    description: 'رصيد للالعاب',
    category: 'بطاقات',
    region: 'US',
    price_cents: 1000,
    payment_mode: 'both',
  },
  {
    id: 'b',
    name: 'Steam Europe',
    category: 'بطاقات',
    region: 'EU',
    price_cents: 2000,
    payment_mode: 'gateway',
  },
  {
    id: 'c',
    name: 'شحن ألعاب',
    category: 'شحن',
    region: 'US',
    price_cents: 500,
    payment_mode: 'whatsapp',
    available: false,
  },
];
test('catalog combines Arabic-normalized multiword search, region and inclusive price limits', () => {
  assert.deepEqual(filterProducts(products, { term: 'ستيم' }), []);
  assert.deepEqual(
    filterProducts(products, { term: 'العاب بطاقة', region: 'US', min: 10, max: 10 }).map(
      (p) => p.id,
    ),
    ['a'],
  );
  assert.deepEqual(filterProducts(products, { category: 'بطاقات', region: 'EU', max: 10 }), []);
});
test('catalog availability respects inventory and configured payment methods', () => {
  assert.equal(availability(products[0], {}).available, false);
  assert.equal(availability(products[2], { whatsapp: '970599123456' }).available, false);
  assert.deepEqual(
    filterProducts(products, { onlyAvailable: true }, { whatsapp: '970599123456' }).map(
      (p) => p.id,
    ),
    ['a'],
  );
  assert.deepEqual(
    filterProducts(products, { onlyAvailable: true }, { gatewayReady: true }).map((p) => p.id),
    ['a', 'b'],
  );
});
test('sorting does not mutate the source catalog and empty price bounds do not become zero', () => {
  assert.deepEqual(
    filterProducts(products, { sort: 'high', min: '', max: '' }).map((p) => p.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    products.map((p) => p.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(filterProducts(products, { min: 20, max: 10 }), []);
});

test('pagination applies after global filtering and sorting, clamps stale pages', () => {
  const items = Array.from({ length: 31 }, (_, i) => ({
    ...products[0],
    id: String(i),
    price_cents: i * 100,
  }));
  const filtered = filterProducts(items, { min: 10, sort: 'high' });
  const page = catalogPage(filtered, 2, 12);
  assert.equal(page.totalPages, 2);
  assert.equal(page.items[0].price_cents, 1800);
  assert.equal(page.items.at(-1).price_cents, 1000);
  assert.equal(catalogPage(filtered, 100, 12).page, 2);
  assert.deepEqual(catalogPage([], 5).items, []);
  assert.equal(catalogPage([], 5).page, 1);
});

test('home selection is bounded, diverse and leaves the shared cart catalog intact', () => {
  const items = Array.from({ length: 24 }, (_, i) => ({
    ...products[0],
    id: String(i),
    category: i < 20 ? 'ألعاب' : 'بطاقات',
  }));
  const original = [...items];
  const selected = featuredProducts(items, 8, { gatewayReady: true });
  assert.equal(selected.length, 8);
  assert.equal(new Set(selected.map((p) => p.id)).size, 8);
  assert.equal(new Set(selected.map((p) => p.category)).size, 2);
  assert.deepEqual(items, original);
  assert.equal(items.length, 24);
});
