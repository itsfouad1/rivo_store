import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCart, regionNotice } from '../public/js/purchase-ui.js';
import { orderProgress } from '../public/js/order-progress.js';
const p = {
  id: 'card',
  name: 'Steam',
  price_cents: 1299,
  currency: 'ILS',
  payment_mode: 'both',
  region: 'US',
};
const options = {
  currency: 'ILS',
  method: 'gateway',
  gatewayReady: true,
  whatsapp: '970599123456',
};
test('review uses fresh prices and integer totals without mutating the cart or catalog', () => {
  const cart = [{ id: 'card', quantity: 3 }],
    products = [{ ...p, price_cents: 1500 }];
  const result = reviewCart(cart, products, options);
  assert.equal(result.total, 4500);
  assert.equal(result.items[0].region, 'US');
  assert.deepEqual(cart, [{ id: 'card', quantity: 3 }]);
  assert.equal(products[0].quantity, undefined);
});
test('review rejects removed products, stale stock limits, duplicates, fractional quantities and wrong currency', () => {
  for (const [rows, products] of [
    [[{ id: 'gone', quantity: 1 }], [p]],
    [[{ id: 'card', quantity: 1 }], [{ ...p, available: false }]],
    [[{ id: 'card', quantity: 3 }], [{ ...p, max_quantity: 2 }]],
    [[{ id: 'card', quantity: 1 }], [{ ...p, min_quantity: 2 }]],
    [[{ id: 'card', quantity: 1.5 }], [p]],
    [
      [
        { id: 'card', quantity: 1 },
        { id: 'card', quantity: 1 },
      ],
      [p],
    ],
    [[{ id: 'card', quantity: 1 }], [{ ...p, currency: 'USD' }]],
  ])
    assert.throws(() => reviewCart(rows, products, options));
});
test('review requires a common available payment method for every product', () => {
  const rows = [
      { id: 'card', quantity: 1 },
      { id: 'topup', quantity: 1 },
    ],
    products = [p, { ...p, id: 'topup', payment_mode: 'whatsapp' }];
  assert.throws(() => reviewCart(rows, products, options));
  assert.equal(reviewCart(rows, products, { ...options, method: 'whatsapp' }).total, 2598);
  assert.throws(() => reviewCart(rows, products, { ...options, method: 'whatsapp', whatsapp: '' }));
  assert.throws(() =>
    reviewCart([{ id: 'card', quantity: 1 }], [p], { ...options, gatewayReady: false }),
  );
});
test('player ID is required only for products that actually need it', () => {
  const rows = [{ id: 'card', quantity: 1 }];
  assert.equal(reviewCart(rows, [p], options).total, 1299);
  assert.throws(() => reviewCart(rows, [{ ...p, player_id_required: 1 }], options));
  assert.equal(
    reviewCart(
      [{ id: 'card', quantity: 1, player_id: 'player-42' }],
      [{ ...p, player_id_required: 1 }],
      options,
    ).total,
    1299,
  );
});
test('missing region never becomes a global activation claim', () => {
  assert.match(regionNotice(''), /غير محددة/);
  assert.match(regionNotice('US'), /US/);
  assert.match(regionNotice('US'), /لا يغيّر/);
});
test('order progress never marks an unpaid or trial order as paid or delivered', () => {
  const unpaid = orderProgress({ payment_status: 'unpaid', status: 'completed' });
  assert.equal(unpaid.steps[1].state, 'current');
  assert.equal(unpaid.steps[3].state, 'pending');
  assert.equal(
    orderProgress({ payment_status: 'paid', status: 'processing' }).steps[2].state,
    'current',
  );
  assert.ok(
    orderProgress({ payment_status: 'paid', status: 'completed' }).steps.every(
      (s) => s.state === 'done',
    ),
  );
  for (const payment_status of ['test_paid', 'refunded', 'partially_refunded'])
    assert.equal(orderProgress({ payment_status, status: 'completed' }).steps.length, 0);
  assert.equal(orderProgress({ payment_status: 'unpaid', status: 'cancelled' }).steps.length, 0);
});
