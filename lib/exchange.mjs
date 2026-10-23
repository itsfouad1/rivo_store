export const currencies = Object.freeze(['ILS', 'JOD', 'EGP', 'SAR', 'AED', 'USD', 'TRY']);
export const countries = Object.freeze([
  { country: 'PS', label: 'فلسطين', currency: 'ILS' },
  { country: 'JO', label: 'الأردن', currency: 'JOD' },
  { country: 'EG', label: 'مصر', currency: 'EGP' },
  { country: 'SA', label: 'السعودية', currency: 'SAR' },
  { country: 'AE', label: 'الإمارات', currency: 'AED' },
  { country: 'US', label: 'أمريكا', currency: 'USD' },
  { country: 'TR', label: 'تركيا', currency: 'TRY' },
]);

const SCALE = 1000000n;
const now = () => new Date().toISOString();
export const validCurrency = (value) => currencies.includes(value);

export async function rateMap(db) {
  const rows = (await db.prepare('SELECT currency,rate_units,updated_at FROM exchange_rates').all())
    .results;
  const map = Object.fromEntries(
    rows.map((row) => [row.currency, { units: row.rate_units, updatedAt: row.updated_at }]),
  );
  if (!map.USD) map.USD = { units: 1000000, updatedAt: '1970-01-01T00:00:00.000Z' };
  return map;
}

export function convertCents(amount, from, to, rates) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid money amount');
  if (!validCurrency(from) || !validCurrency(to)) throw new Error('Unsupported currency');
  const fromRate = rates[from]?.units,
    toRate = rates[to]?.units;
  if (
    !Number.isSafeInteger(fromRate) ||
    fromRate <= 0 ||
    !Number.isSafeInteger(toRate) ||
    toRate <= 0
  )
    throw new Error('Exchange rate unavailable');
  const numerator = BigInt(amount) * BigInt(toRate);
  const result = (numerator + BigInt(fromRate) / 2n) / BigInt(fromRate);
  if (result > 100000000n) throw new Error('Converted price is too large');
  return Number(result);
}

function normalizeRate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000)
    throw new Error('Invalid exchange rate');
  const units = Math.round(value * Number(SCALE));
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error('Invalid exchange rate');
  return units;
}

export async function refreshRates(db, fetcher = fetch) {
  let response;
  try {
    response = await fetcher('https://open.er-api.com/v6/latest/USD', {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new Error('تعذّر الاتصال بخدمة أسعار الصرف');
  }
  if (response.status >= 300 && response.status < 400)
    throw new Error('خدمة أسعار الصرف أعادت توجيهًا غير مسموح');
  if (!response.ok) throw new Error('خدمة أسعار الصرف غير متاحة حاليًا');
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('رد أسعار الصرف غير صالح');
  }
  if (payload.result !== 'success' || payload.base_code !== 'USD' || !payload.rates)
    throw new Error('رد أسعار الصرف غير صالح');
  const stamp = now(),
    statements = [];
  for (const currency of currencies) {
    const units = currency === 'USD' ? 1000000 : normalizeRate(payload.rates[currency]);
    statements.push(
      db
        .prepare(
          'INSERT INTO exchange_rates(currency,rate_units,updated_at) VALUES (?,?,?) ON CONFLICT(currency) DO UPDATE SET rate_units=excluded.rate_units,updated_at=excluded.updated_at',
        )
        .bind(currency, units, stamp),
    );
  }
  await db.batch(statements);
  return rateMap(db);
}

export async function ensureRates(db, fetcher = fetch, maxAgeMs = 26 * 60 * 60 * 1000) {
  const latest = await db
    .prepare(
      "SELECT MIN(updated_at) AS updated_at,COUNT(*) AS count FROM exchange_rates WHERE currency IN ('ILS','JOD','EGP','SAR','AED','USD','TRY')",
    )
    .first();
  if (latest?.count === currencies.length && Date.now() - Date.parse(latest.updated_at) <= maxAgeMs)
    return rateMap(db);
  try {
    return await refreshRates(db, fetcher);
  } catch (error) {
    const cached = await rateMap(db);
    if (currencies.every((code) => cached[code]?.units > 0)) return cached;
    throw error;
  }
}

export function publicRates(rates) {
  return Object.fromEntries(
    currencies
      .map((code) => [code, rates[code]?.units])
      .filter(([, units]) => Number.isSafeInteger(units) && units > 0),
  );
}
