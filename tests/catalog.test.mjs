import test from 'node:test';
import assert from 'node:assert/strict';
import { filterProducts, availability } from '../public/catalog.js';
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
