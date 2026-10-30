export function steamLogin(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^[A-Za-z0-9_]{1,64}$/.test(value))
    throw Error(
      'اكتب اسم دخول Steam بالحروف الإنجليزية والأرقام أو الشرطة السفلية، وليس اسم العرض أو رابط الحساب.',
    );
  return value;
}
export async function steamKey(user, product, login) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([user, product, login])),
  );
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}
export async function steamVerified(db, user, product, login) {
  return !!(await db
    .prepare('SELECT check_key FROM steam_checks WHERE check_key=? AND expires_at>?')
    .bind(await steamKey(user, product, login), Date.now())
    .first());
}
export function steamService(p) {
  return (
    p.delivery_type === 'direct_topup' &&
    JSON.stringify(JSON.parse(p.note_schema).required) === JSON.stringify(['login']) &&
    (!JSON.parse(p.note_schema).types.login || JSON.parse(p.note_schema).types.login === 'string')
  );
}
// Keep the supplier decimal intact until multiplying the complete denomination.
// Only then round UP to our internal 1/10000 USD cost ceiling, using integers.
export function steamCost(value, quantity = 1) {
  const s = String(value);
  if (
    s.length > 40 ||
    !/^\d+(\.\d{1,12})?$/.test(s) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 500
  )
    throw Error('تكلفة خدمة Steam غير صالحة');
  const [whole, fraction = ''] = s.split('.'),
    scale = 10n ** BigInt(fraction.length);
  const numerator = (BigInt(whole) * scale + BigInt(fraction || '0')) * BigInt(quantity) * 10000n;
  const ceiling = (numerator + scale - 1n) / scale;
  if (ceiling > 1000000000000n) throw Error('تكلفة خدمة Steam خارج الحد');
  return Number(ceiling);
}
export function steamDenomination(p, amount) {
  if (!steamService(p)) throw Error('اختر خدمة شحن مباشر تتطلب login فقط.');
  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 500 ||
    amount < p.min_qty ||
    (p.max_qty !== null && amount > p.max_qty)
  )
    throw Error('مبلغ الفئة لا يطابق حدود خدمة المورد.');
  const cost =
    p.cost_decimal === undefined ? p.cost_units * amount : steamCost(p.cost_decimal, amount);
  if (!Number.isSafeInteger(cost) || cost > 1e12) throw Error('تكلفة الفئة خارج الحد.');
  return { ...p, cost_units: cost, stock: p.stock >= amount ? 1 : 0, min_qty: 1, max_qty: 1 };
}
