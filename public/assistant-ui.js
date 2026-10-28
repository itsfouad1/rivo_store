export function mountAssistant(root, { request, onHuman, onClose }) {
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  let busy = false,
    history = [],
    records = [],
    started = false,
    context = null;
  root.innerHTML = `<div class="chat-shell customer-chat"><div class="chat-header"><span class="chat-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 13v-2a8 8 0 0 1 16 0v2M4 12H3v6h4v-6H4Zm16 0h1v6h-4v-6h3ZM19 18c0 3-3 3-6 3"/></svg></span><div class="chat-heading"><h2>مساعد ريفو</h2><p>مساعد آلي · للمنتجات والطلبات</p></div><button class="chat-icon-button" data-close-bot type="button" aria-label="إغلاق نافذة الدعم">×</button></div><div class="chat-bot-options"><details><summary>كيف نقدر نساعدك؟</summary><div class="chat-controls" data-topics></div><p class="chat-help">مساعد آلي من بيانات المتجر، وليس موظفًا. لا يوافق على دفعات أو استرجاع. لا ترسل كلمات مرور أو بيانات دفع.</p></details><button class="chat-handoff" type="button" data-human>التحدث مع موظف</button></div><div class="chat-messages" data-bot-log role="log" aria-label="حديث المساعد" aria-live="polite"></div><form data-bot-form class="chat-compose"><label class="chat-visually-hidden" for="ra-question">سؤالك أو اسم اللعبة</label><div class="chat-input-row"><input id="ra-question" name="question" maxlength="500" required autocomplete="off" placeholder="اكتب سؤالك…"><button class="primary chat-send-icon" type="submit" aria-label="إرسال السؤال"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3"/></svg></button></div><p class="chat-error" data-bot-error role="alert"></p></form></div>`;
  const find = (s) => root.querySelector(s),
    log = find('[data-bot-log]'),
    form = find('[data-bot-form]'),
    error = find('[data-bot-error]');
  find('.chat-heading h2').textContent = 'ريفو';
  find('.chat-heading p').textContent = 'مساعدك الآلي في المتجر';
  find('.chat-help').textContent =
    'ريفو مساعد آلي، وقد يستخدم Cloudflare AI لفهم بعض الأسئلة. لا ترسل كلمات مرور أو بيانات دفع أو أكواد كاملة. حالة الطلب والسعر من بيانات المتجر؛ الاسترجاع والتعويض للفريق.';
  find('.chat-avatar').innerHTML = '<img src="/rivo-mascot.png" alt="" width="48" height="48">';
  const thinking = document.createElement('div');
  thinking.className = 'rivo-thinking';
  thinking.setAttribute('role', 'status');
  thinking.textContent = 'ريفو عم يجهّز الرد…';
  thinking.hidden = true;
  form.before(thinking);
  const topics = [
    ['start', 'كيف أساعدك؟'],
    ['search', 'البحث عن منتج'],
    ['orders', 'طلباتي'],
    ['payment', 'طرق الطلب والدفع'],
    ['region', 'منطقة التفعيل'],
    ['refunds', 'الاسترجاع'],
    ['policies', 'السياسات'],
  ];
  find('[data-topics]').innerHTML = topics
    .map(
      ([intent, title]) =>
        `<button class="secondary" type="button" data-intent="${intent}">${title}</button>`,
    )
    .join('');
  function summary() {
    return records
      .slice(-3)
      .map((r) => 'سؤال الزبون: ' + r.q + '\nإجابة المساعد الآلي: ' + r.a)
      .join('\n\n')
      .slice(0, 2800);
  }
  function paint() {
    log.innerHTML = history
      .map((h, index) =>
        h.kind === 'customer'
          ? `<article class="chat-message"><strong>سؤالك</strong><p>${esc(h.text)}</p></article>`
          : `<article class="chat-message staff"><strong>المساعد الآلي</strong><p>${esc(h.answer.reply)}</p>${h.answer.products.map((p) => `<section class="assistant-product"><b>${esc(p.name)}</b><p>${esc(new Intl.NumberFormat('ar-PS', { style: 'currency', currency: p.currency }).format(p.price_cents / 100))} · ${esc(p.region)}</p><p>${p.available ? 'متاح للطلب' : 'غير متاح للطلب حاليًا'}</p>${p.description ? '<p>' + esc(p.description) + '</p>' : ''}${p.delivery_estimate ? '<p><b>وقت التنفيذ المتوقع:</b> ' + esc(p.delivery_estimate) + '</p>' : ''}${p.purchase_notice ? '<p><b>قبل الشراء:</b> ' + esc(p.purchase_notice) + '</p>' : ''}${p.activation_instructions ? '<details><summary>تعليمات التفعيل</summary><p>' + esc(p.activation_instructions) + '</p></details>' : ''}<div class="chat-controls"><button class="secondary" type="button" data-product="${p.id}" data-name="${esc(p.name)}">تفاصيل وتعليمات</button><a class="secondary" href="${esc(p.url)}" target="_blank" rel="noopener">فتح المنتج ↗</a></div></section>`).join('')}${h.answer.orders.map((o) => `<section class="assistant-product"><b>#${esc(o.id.slice(0, 8))}</b><p>${esc(o.status)} · ${esc(o.payment)}</p>${o.update ? '<p>' + esc(o.update) + '</p>' : ''}<div class="chat-controls"><button class="secondary" type="button" data-order="${o.id}">حالة هذا الطلب</button><a class="secondary" href="${esc(o.url)}" target="_blank" rel="noopener">تفاصيل الطلب ↗</a></div></section>`).join('')}<div class="policy-links">${h.answer.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)} ↗</a>`).join('')}</div>${h.answer.handoff ? '<p>اضغط «التحدث مع موظف» بالأسفل للمتابعة.</p>' : ''}</article>`,
      )
      .join('');
    log.scrollTop = log.scrollHeight;
    const articles = log.querySelectorAll('.chat-message.staff');
    history
      .filter((h) => h.kind === 'assistant')
      .forEach((h, i) => {
        const article = articles[i];
        article.querySelector('strong').textContent = 'ريفو · مساعد آلي';
        if (!Array.isArray(h.answer.suggestions)) return;
        const choices = document.createElement('div');
        choices.className = 'chat-controls rivo-suggestions';
        for (const s of h.answer.suggestions.slice(0, 3)) {
          if (!['search', 'orders', 'human'].includes(s.intent)) continue;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary';
          button.textContent = s.label;
          button.onclick = () => {
            if (s.intent === 'search') {
              form.elements.question.focus();
              error.textContent = 'اكتب اسم اللعبة أو المنصة، وخلّي الباقي عليّ.';
            } else if (s.intent === 'human') {
              if (busy) return;
              onHuman(summary()).catch((e) => (error.textContent = e.message));
            } else ask({ intent: s.intent }, s.label);
          };
          choices.append(button);
        }
        article.append(choices);
      });
    log
      .querySelectorAll('[data-product]')
      .forEach(
        (b) =>
          (b.onclick = () =>
            ask({ intent: 'product', product_id: b.dataset.product }, 'تفاصيل ' + b.dataset.name)),
      );
    log
      .querySelectorAll('[data-order]')
      .forEach(
        (b) =>
          (b.onclick = () =>
            ask(
              { intent: 'order', order_id: b.dataset.order },
              'حالة الطلب #' + b.dataset.order.slice(0, 8),
            )),
      );
    log.scrollTop = log.scrollHeight;
  }
  async function ask(data, label) {
    if (busy) return false;
    busy = true;
    thinking.hidden = false;
    error.textContent = '';
    form.setAttribute('aria-busy', 'true');
    form.elements.question.disabled = true;
    form.querySelector('button[type=submit]').disabled = true;
    try {
      let currency = 'ILS';
      try {
        currency = localStorage.getItem('rivo-currency') || 'ILS';
      } catch {}
      const answer = await request({ ...data, currency, context });
      context = answer.context || null;
      if (data.intent !== 'start') {
        history.push({ kind: 'customer', text: label });
        records.push({ q: label, a: answer.reply });
        records = records.slice(-10);
      }
      history.push({ kind: 'assistant', answer });
      history = history.slice(-20);
      paint();
      if (data.question !== undefined) form.elements.question.value = '';
      return true;
    } catch (e) {
      error.textContent = e.message;
      return false;
    } finally {
      busy = false;
      thinking.hidden = true;
      form.setAttribute('aria-busy', 'false');
      form.elements.question.disabled = false;
      form.querySelector('button[type=submit]').disabled = false;
    }
  }
  find('[data-topics]')
    .querySelectorAll('button')
    .forEach(
      (b) =>
        (b.onclick = () => {
          find('[data-topics]').closest('details').open = false;
          if (b.dataset.intent === 'search') {
            form.elements.question.focus();
            error.textContent = 'اكتب اسم اللعبة أو المنصة في الحقل.';
          } else ask({ intent: b.dataset.intent }, b.textContent);
        }),
    );
  form.onsubmit = (e) => {
    e.preventDefault();
    ask({ question: form.elements.question.value }, form.elements.question.value);
  };
  find('[data-human]').onclick = () => {
    if (busy) {
      error.textContent = 'انتظر انتهاء الرد ثم انتقل للموظف.';
      return;
    }
    onHuman(summary()).catch((e) => (error.textContent = e.message));
  };
  find('[data-close-bot]').onclick = onClose;
  return {
    setUnread(count) {
      find('[data-human]').textContent = count
        ? 'عرض ردود الفريق (' + count + ' جديدة)'
        : 'التحدث مع موظف';
    },
    start() {
      if (!started) {
        started = true;
        ask({ intent: 'start' }, 'بداية المساعدة').then((ok) => {
          if (!ok) started = false;
        });
      }
    },
  };
}
