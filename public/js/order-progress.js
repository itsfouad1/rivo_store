export function orderProgress(order) {
  if (order.payment_status.startsWith('test_'))
    return { special: 'تجربة فقط — هذه المراحل لا تعني دفعًا أو تسليمًا حقيقيًا.', steps: [] };
  if (order.payment_status.includes('refunded'))
    return { special: 'يوجد استرجاع مسجل؛ راجع حالة الدفع وتحديث المتجر.', steps: [] };
  if (order.status === 'cancelled')
    return { special: 'الطلب ملغي؛ لا توجد مراحل تنفيذ تالية لهذا الطلب.', steps: [] };
  const paid = order.payment_status === 'paid',
    completed = paid && order.status === 'completed',
    current = completed ? 4 : paid ? 2 : 1;
  return {
    special: '',
    steps: ['تسجيل الطلب', 'تأكيد الدفع', 'تنفيذ الطلب', 'التسليم'].map((label, index) => ({
      label,
      state: current === 4 || index < current ? 'done' : index === current ? 'current' : 'pending',
    })),
  };
}
export function progressHTML(order) {
  const p = orderProgress(order);
  if (p.special) return '<p class="order-progress-note">' + p.special + '</p>';
  return (
    '<ol class="order-progress" aria-label="مراحل الطلب">' +
    p.steps
      .map(
        (s, i) =>
          '<li class="' +
          s.state +
          '"' +
          (s.state === 'current' ? ' aria-current="step"' : '') +
          '><span aria-hidden="true">' +
          (s.state === 'done' ? '✓' : i + 1) +
          '</span><b>' +
          s.label +
          '</b><small>' +
          { done: 'مكتملة', current: 'المرحلة الحالية', pending: 'لاحقًا' }[s.state] +
          '</small></li>',
      )
      .join('') +
    '</ol>'
  );
}
