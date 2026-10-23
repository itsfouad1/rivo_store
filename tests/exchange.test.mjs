import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { convertCents, refreshRates, ensureRates } from '../lib/exchange.mjs';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(
    'CREATE TABLE exchange_rates(currency TEXT PRIMARY KEY,rate_units INTEGER NOT NULL,updated_at TEXT NOT NULL)',
  );
  function prepare(q, args = []) {
    return {
      q,
      args,
      bind(...p) {
        return prepare(q, p);
      },
      async first() {
        return sql.prepare(q).get(...args) || null;
      },
      async all() {
        return { results: sql.prepare(q).all(...args) };
      },
      async run() {
        return sql.prepare(q).run(...args);
      },
    };
  }
  return {
    sql,
    db: {
      prepare,
      async batch(ss) {
        sql.exec('BEGIN');
        try {
          for (const s of ss) sql.prepare(s.q).run(...s.args);
          sql.exec('COMMIT');
        } catch (e) {
          sql.exec('ROLLBACK');
          throw e;
        }
      },
    },
  };
}

test('integer conversion is reversible within currency rounding', () => {
  const rates = { USD: { units: 1000000 }, ILS: { units: 3700000 }, JOD: { units: 710000 } };
  assert.equal(convertCents(1000, 'USD', 'ILS', rates), 3700);
  assert.equal(convertCents(3700, 'ILS', 'USD', rates), 1000);
  assert.equal(convertCents(1000, 'USD', 'JOD', rates), 710);
});

test('rates refresh validates and caches every supported currency', async () => {
  const { sql, db } = database();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return Response.json({
      result: 'success',
      base_code: 'USD',
      rates: { ILS: 3.7, JOD: 0.71, EGP: 50, SAR: 3.75, AED: 3.67, TRY: 34 },
    });
  };
  const rates = await refreshRates(db, fetcher);
  assert.equal(rates.ILS.units, 3700000);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM exchange_rates').get().n, 7);
  await ensureRates(db, fetcher);
  assert.equal(calls, 1);
});
