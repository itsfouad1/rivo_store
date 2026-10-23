// Uses the dashboard's existing escaped templates and authenticated API helper.
let foxState = null,
  foxCatalog = [],
  foxCursor = null,
  foxCategory = '';
async function foxView() {
  $('dash-view').innerHTML =
    '<section class="panel"><h3>FoxReload</h3><p>جاري تحميل الربط…</p></section>';
  try {
    foxState = await api('/api/admin/foxreload/status');
    if (current !== 'foxreload') return;
    $('dash-view').innerHTML =
      `<div class="page-head"><div><h2>FoxReload</h2><p>استورد المنتجات كمسودات، وحدد نسبة الزيادة على التكلفة.</p></div><button class="secondary" id="fox-balance-button">عرض الرصيد</button></div>
  <div class="info-box">المفتاح: ${foxState.configured ? 'مضاف' : 'غير مضاف'} · التنفيذ الحقيقي: ${foxState.liveEnabled ? 'مفعّل' : 'متوقف — التجربة فقط'} · Webhook: ${foxState.webhookConfigured ? 'السر مضاف؛ تحقّق من تسجيل الرابط عند المورد' : 'السر غير مضاف'}<br><span dir="ltr">${esc(foxState.webhookUrl)}</span></div>
  <p id="fox-balance" class="helper"></p><section class="panel"><h3>كتالوج المورد</h3><div class="toolbar"><input id="fox-category" placeholder="معرّف أو slug التصنيف (اختياري)" aria-label="تصنيف المورد"><button class="primary" id="fox-load">عرض المنتجات</button></div><p class="helper">الدولار USD. ندعم الأكواد والشحن المباشر. راجع المنطقة والوصف قبل نشر أي منتج.</p><div id="fox-catalog"></div><button class="secondary" id="fox-next" hidden>الصفحة التالية</button></section>
  <section class="panel"><h3>المنتجات المربوطة (${foxState.links.length})</h3><p class="helper">تُحدّث أقدم 10 منتجات كل 15 دقيقة. إذا زاد العدد، يستغرق المرور على الجميع عدة دفعات. تحديث السعر التلقائي يستبدل سعر البيع بالدولار حسب نسبة الزيادة.</p><div class="table-wrap"><table><thead><tr><th>المنتج</th><th>التكلفة USD</th><th>المخزون</th><th>آخر تحديث</th><th></th></tr></thead><tbody>${foxState.links.map((p) => `<tr><td>${esc(p.name)}</td><td>${(p.cost_units / 10000).toFixed(4)}</td><td>${p.stock}</td><td>${date(p.checked_at)}</td><td><button class="text-btn" onclick="foxPricing('${p.product_id}')">الربح والتحديث</button></td></tr>`).join('')}</tbody></table></div></section>`;
    $('fox-load').onclick = () => {
      foxCategory = $('fox-category').value.trim();
      loadFoxCatalog(null);
    };
    $('fox-next').onclick = () => loadFoxCatalog(foxCursor);
    $('fox-balance-button').onclick = async () => {
      const b = $('fox-balance-button');
      b.disabled = true;
      try {
        const r = await api('/api/admin/foxreload/balance');
        $('fox-balance').textContent =
          'رصيد المورد: ' +
          r.balances.map((x) => `${x.available ?? '—'} ${x.currency}`).join(' / ');
      } catch (e) {
        toast(e.message);
      } finally {
        b.disabled = false;
      }
    };
  } catch (e) {
    $('dash-view').innerHTML = empty('تعذّر تحميل FoxReload', esc(e.message));
  }
}
async function loadFoxCatalog(cursor) {
  const button = $('fox-load');
  button.disabled = true;
  $('fox-next').disabled = true;
  try {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    if (foxCategory) q.set('categoryId', foxCategory);
    const r = await api('/api/admin/foxreload/catalog?' + q);
    foxCatalog = r.items;
    foxCursor = r.nextCursor;
    $('fox-catalog').innerHTML =
      `<div class="table-wrap"><table><thead><tr><th>المنتج</th><th>نوع التسليم</th><th>تكلفة USD</th><th>الكمية المتاحة</th><th></th></tr></thead><tbody>${r.items
        .map((p, index) => {
          const exists = foxState.links.some((l) => l.remote_id === p.id),
            supported =
              ['code', 'direct_topup'].includes(p.deliveryType) &&
              p.currency === 'usd' &&
              p.price !== null &&
              (p.orderMinQuantity ?? 1) <= 99;
          return `<tr><td><b>${esc(p.name)}</b><br><small>${esc(p.id)}</small></td><td>${esc(p.deliveryType)}</td><td>${esc(p.price ?? '—')}</td><td>${Number(p.quantity) || 0}</td><td><button class="text-btn" onclick="foxImport(${index})" ${exists || !supported ? 'disabled' : ''}>${exists ? 'مستورد' : supported ? 'استيراد كمسودة' : 'غير مدعوم'}</button></td></tr>`;
        })
        .join('')}</tbody></table></div>`;
    $('fox-next').hidden = !foxCursor;
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
    $('fox-next').disabled = false;
  }
}
function foxImport(index) {
  const p = foxCatalog[index];
  openEditor(
    `${editorHead('استيراد من FoxReload')}<p>${esc(p.name)}</p><p class="helper">التكلفة: ${esc(p.price)} USD. سيُحفظ كمسودة وبطريقة طلب واتساب. عدّل الاسم والوصف والمنطقة والصورة من المنتجات قبل نشره.</p><form id="fox-import-form">${field('نسبة الزيادة على التكلفة (%)', 'markup', 10, { type: 'number', min: 0, step: '0.01', required: true })}${formEnd('استيراد المنتج')}</form>`,
  );
  bindForm('fox-import-form', async (fd) => {
    await send('/api/admin/foxreload/import', 'POST', {
      remote_id: p.id,
      markup_bps: Math.round(Number(fd.get('markup')) * 100),
    });
    closeEditor();
    await refresh();
    toast('تم استيراد المنتج كمسودة');
  });
}
function foxPricing(id) {
  const p = foxState.links.find((l) => l.product_id === id);
  openEditor(
    `${editorHead('تسعير ' + esc(p.name))}<form id="fox-pricing-form">${field('نسبة الزيادة على تكلفة المورد (%)', 'markup', p.markup_bps / 100, { type: 'number', min: 0, step: '0.01', required: true })}<label class="check-field"><input type="checkbox" name="auto" ${p.auto_price ? 'checked' : ''}> تحديث سعر البيع بالدولار تلقائيًا</label><p class="helper">إلغاء الخيار يُبقي سعر البيع الذي تحدده من صفحة المنتجات، مع استمرار تحديث التكلفة والمخزون.</p>${formEnd('حفظ وتحديث من المورد')}</form>`,
  );
  bindForm('fox-pricing-form', async (fd) => {
    await send('/api/admin/foxreload/products/' + id, 'PUT', {
      markup_bps: Math.round(Number(fd.get('markup')) * 100),
      auto_price: fd.has('auto'),
    });
    closeEditor();
    await refresh();
    toast('تم تحديث المنتج');
  });
}
async function foxOrder(id) {
  try {
    const r = await api('/api/admin/foxreload/orders/' + id);
    openEditor(
      `${editorHead('تنفيذ FoxReload')}<div class="warning-box">التجربة لا تسلّم منتجات حقيقية ولا تظهر في مشتريات الزبون. التنفيذ الحقيقي يخصم من رصيد المورد ويحتاج تأكيد استلام دفع الزبون. بوابة الدفع لم تُربط بعد.</div><div id="fox-job-list"></div>`,
    );
    $('fox-job-list').innerHTML = r.items.length
      ? r.items
          .map((p, index) => {
            const schema = JSON.parse(p.note_schema),
              jobs = r.jobs.filter((j) => j.item_id === p.item_id);
            return `<section class="panel"><h3>${esc(p.name)} × ${p.quantity}</h3><p class="helper">أقصى تكلفة محفوظة: ${((p.cost_units * p.quantity) / 10000).toFixed(4)} USD</p>${jobs.map((j) => `<p>${j.is_mock ? 'تجريبي' : 'حقيقي'} · ${esc(j.status)}<br>${esc(j.error)}${j.pay_started && j.status === 'active' ? '<br>بدأت محاولة الدفع؛ تحديث الحالة فقط. لا تعِد شراء الطلب من حساب المورد قبل مراجعة النتيجة.' : ''}</p>${j.is_mock && j.status === 'completed' ? '<pre dir="ltr">' + esc(JSON.parse(j.result_json).join('\n')) + '</pre>' : ''}<button type="button" class="secondary fox-refresh" data-job="${esc(j.id)}">تحديث حالة العملية</button>`).join('')}<form id="fox-execute-${index}">${schema.required.length ? `<p class="helper">بيانات الشحن المطلوبة: ${esc(schema.required.join('، '))}. تأكد منها مع الزبون.</p>` : ''}<label class="field">بيانات الشحن JSON<textarea name="note" dir="ltr" required>${esc(JSON.stringify(Object.fromEntries(schema.required.map((k) => [k, ''])), null, 2))}</textarea></label><details><summary>خيارات الحقول لدى المورد</summary><pre dir="ltr">${esc(JSON.stringify(schema, null, 2))}</pre></details>${select('نوع التنفيذ', 'mode', 'mock', [['mock', 'طلب تجريبي'], ...(r.liveEnabled ? [['live', 'شراء حقيقي من رصيد المورد']] : [])])}<label class="check-field"><input name="confirm" type="checkbox"> أؤكد استلام الدفع وأوافق على الخصم من رصيد المورد عند اختيار التنفيذ الحقيقي.</label>${formEnd('تنفيذ / استعادة نفس العملية')}</form></section>`;
          })
          .join('')
      : '<p class="helper">هذا الطلب لا يحتوي منتجات FoxReload مستوردة بعد تثبيت الربط. الطلبات القديمة تبقى للمعالجة اليدوية.</p>';
    r.items.forEach((p, index) =>
      bindForm('fox-execute-' + index, async (fd) => {
        let note;
        try {
          note = JSON.parse(fd.get('note'));
        } catch {
          throw Error('بيانات الشحن يجب أن تكون JSON صالحًا');
        }
        const mock = fd.get('mode') === 'mock';
        if (!mock && !fd.has('confirm')) throw Error('أكد استلام الدفع والموافقة على الخصم');
        await send('/api/admin/foxreload/execute', 'POST', {
          item_id: p.item_id,
          mock,
          confirm: fd.has('confirm'),
          note,
        });
        await refresh();
        await foxOrder(id);
        toast('تم إرسال العملية؛ راجع الحالة');
      }),
    );
    document.querySelectorAll('.fox-refresh').forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            await send('/api/admin/foxreload/refresh', 'POST', { job_id: b.dataset.job });
            await refresh();
            await foxOrder(id);
          } catch (e) {
            toast(e.message);
            b.disabled = false;
          }
        }),
    );
  } catch (e) {
    toast(e.message);
  }
}
async function showDelivery(id) {
  try {
    const r = await api('/api/orders/' + id + '/delivery');
    openEditor(
      `${editorHead('تفاصيل التسليم')} ${r.items.length ? r.items.map((i) => `<section class="panel"><h3>${esc(i.name)}</h3><p>${esc({ completed: 'تم التنفيذ', processing: 'قيد التنفيذ', paid: 'قيد التنفيذ', failed: 'تحتاج متابعة مع المتجر', refunded: 'تحتاج متابعة مع المتجر' }[i.status] || 'قيد المتابعة')}</p>${i.codes.length ? '<pre dir="ltr" style="white-space:pre-wrap;overflow-wrap:anywhere;user-select:all">' + esc(i.codes.join('\n\n')) + '</pre>' : ''}</section>`).join('') : '<p>لا توجد تفاصيل تسليم حتى الآن. تظهر بعد تأكيد الدفع وتنفيذ الطلب.</p>'}`,
    );
  } catch (e) {
    toast(e.message);
  }
}
