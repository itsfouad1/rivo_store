const $ = (id) => document.getElementById(id),
  order = new URLSearchParams(location.search).get('order');
if (/^[a-f0-9-]{36}$/.test(order || ''))
  $('order-details').href = '/order.html?order=' + encodeURIComponent(order);
const states = {
  creating: 'راجع مبلغ الطلب قبل الانتقال للدفع.',
  pending: 'بانتظار الدفع أو تأكيد البوابة.',
  processing: 'جاري معالجة الدفعة لدى البوابة.',
  paid: 'تم تأكيد الدفع.',
  expired: 'انتهت صلاحية الفاتورة. تواصل مع المتجر.',
  cancelled: 'الفاتورة ملغاة.',
  refunded: 'تم استرجاع الدفعة.',
  partially_refunded: 'تم استرجاع جزء من الدفعة؛ تواصل مع المتجر.',
};
async function api(path, method = 'GET', body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    location.assign('/login');
    throw Error('سجّل الدخول ثم افتح الطلب من حسابك');
  }
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'تعذّر تحديث الدفع');
  return d;
}
function render(d) {
  $('payment-state').textContent = states[d.status] || d.status;
  $('payment-mode').textContent =
    d.environment === 'test'
      ? 'تجربة للإدارة فقط — لا أموال أو منتجات حقيقية.'
      : 'دفع آمن عبر Payunit';
  $('payment-amount').textContent = (d.amount_usd_cents / 100).toFixed(2) + ' USD';
  $('payment-go').hidden =
    d.payment_status !== 'unpaid' ||
    d.order_status !== 'awaiting_payment' ||
    !['creating', 'pending', 'processing'].includes(d.status);
  $('payment-refresh').hidden = d.status === 'creating';
}
async function load(refresh = false) {
  $('payment-error').textContent = '';
  try {
    if (!/^[a-f0-9-]{36}$/.test(order || '')) throw Error('رابط طلب غير صالح');
    render(
      await api(
        '/api/payments/payunit/' + order + (refresh ? '/refresh' : ''),
        refresh ? 'POST' : 'GET',
      ),
    );
  } catch (e) {
    $('payment-error').textContent = e.message;
  }
}
$('payment-go').onclick = async () => {
  $('payment-go').disabled = true;
  $('payment-error').textContent = '';
  try {
    const d = await api('/api/payments/payunit', 'POST', { order_id: order });
    render(d);
    if (d.checkout_url) {
      const u = new URL(d.checkout_url);
      if (u.origin !== 'https://payunit.co') throw Error('رابط دفع غير صالح');
      location.assign(u.href);
    }
  } catch (e) {
    $('payment-error').textContent = e.message;
  } finally {
    $('payment-go').disabled = false;
  }
};
$('payment-refresh').onclick = async () => {
  $('payment-refresh').disabled = true;
  await load(true);
  $('payment-refresh').disabled = false;
};
load();
