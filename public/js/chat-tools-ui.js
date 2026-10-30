export async function mountChatTools(
  root,
  {
    api,
    manager,
    getConversation,
    getText,
    setText,
    onAction,
    isBusy = () => false,
    onStaffList = () => {},
  },
) {
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  let templates = [],
    employees = [],
    current = null,
    shownKey = '',
    editorRecord = null;
  root.innerHTML = `<section class="chat-tools"><h3>أدوات المتابعة</h3><div class="chat-controls"><label>الأولوية <select data-priority><option value="normal">عادية</option><option value="urgent">عاجلة</option></select></label><button type="button" class="secondary" data-save-priority>حفظ الأولوية</button></div>${manager ? '<div class="chat-controls"><label>تعيين موظف <select data-assignee><option value="">اختر الموظف</option></select></label><button class="secondary" type="button" data-assign>تعيين المحادثة</button><button class="text-btn" type="button" data-staff-refresh>تحديث الموظفين</button></div><p data-assignee-current class="chat-meta"></p>' : ''}<h3>الردود الجاهزة</h3><div class="chat-controls"><label>اختر ردًا <select data-template><option value="">اختر ردًا جاهزًا</option></select></label><button class="text-btn" type="button" data-refresh-templates>تحديث الردود</button>${manager ? '<button class="secondary" type="button" data-new-template>إضافة رد</button><button class="secondary" type="button" data-edit-template>تعديل / إيقاف الرد</button>' : ''}</div><p data-template-state class="chat-meta"></p><pre data-preview class="chat-template-preview" hidden></pre><div class="chat-controls" data-use hidden><button class="secondary" type="button" data-replace>وضع الرد في المسودة</button><button class="secondary" type="button" data-append>إضافة إلى المسودة</button></div><p class="chat-help">الرد يُنسخ كنص قابل للتعديل. راجعه قبل إرسال الرسالة، وانتبه لاختيار الرد العام أو الملاحظة الداخلية.</p><p data-error class="chat-error" role="alert"></p></section>`;
  const find = (s) => root.querySelector(s),
    error = find('[data-error]');
  function preview() {
    const t = templates.find((t) => t.id === find('[data-template]').value);
    find('[data-preview]').hidden = !t;
    find('[data-preview]').textContent = t?.body || '';
    find('[data-use]').hidden = !t || !t.active;
    find('[data-template-state]').textContent =
      t && !t.active ? 'هذا الرد موقوف؛ يمكن للإدارة تعديله أو إعادة تفعيله.' : '';
  }
  async function loadTemplates() {
    try {
      const selected = find('[data-template]').value;
      const r = await api('/chat/templates');
      templates = r.templates;
      find('[data-template]').innerHTML =
        '<option value="">اختر ردًا جاهزًا</option>' +
        templates
          .map(
            (t) => `<option value="${t.id}">${esc(t.title)}${t.active ? '' : ' (موقوف)'}</option>`,
          )
          .join('');
      find('[data-template]').value = templates.some((t) => t.id === selected) ? selected : '';
      preview();
      error.textContent = '';
    } catch (e) {
      error.textContent = e.message;
    }
  }
  async function loadStaff() {
    if (!manager) return;
    try {
      const r = await api('/chat/staff');
      employees = r.staff;
      onStaffList(employees);
      shownKey = '';
      update(getConversation());
    } catch (e) {
      error.textContent = e.message;
    }
  }
  async function act(kind, extra) {
    error.textContent = '';
    try {
      if (isBusy()) throw new Error('انتظر انتهاء العملية الحالية');
      const c = getConversation();
      if (!c || c.status === 'closed') throw new Error('افتح محادثة غير مغلقة أولًا');
      await onAction(kind, extra);
    } catch (e) {
      error.textContent = e.message;
    }
  }
  function update(c) {
    current = c;
    const editable = !!c && c.status !== 'closed';
    find('[data-save-priority]').disabled = !editable;
    find('[data-priority]').disabled = !editable;
    if (manager) find('[data-assign]').disabled = !editable;
    const key = c ? c.id + ':' + c.revision : '';
    if (key === shownKey) return;
    shownKey = key;
    find('[data-priority]').value = c?.priority || 'normal';
    if (manager) {
      find('[data-assignee]').innerHTML =
        '<option value="">اختر الموظف</option>' +
        employees
          .map(
            (u) =>
              `<option value="${esc(u.id)}">${esc(u.name)} · ${esc(u.email)} · ${esc(u.role)}</option>`,
          )
          .join('');
      find('[data-assignee]').value = employees.some((u) => u.id === c?.assignee) ? c.assignee : '';
      const assigned = employees.find((u) => u.id === c?.assignee);
      find('[data-assignee-current]').textContent = c?.assignee
        ? 'الموظف الحالي: ' +
          (assigned
            ? assigned.name + ' · ' + assigned.email
            : c.assignee + ' (غير موجود بقائمة الموظفين المتاحين)')
        : 'المحادثة غير مسندة';
    }
  }
  function useTemplate(append) {
    if (isBusy()) {
      error.textContent = 'انتظر انتهاء الإرسال قبل تعديل المسودة';
      return;
    }
    const t = templates.find((t) => t.id === find('[data-template]').value);
    if (!t || !t.active) return;
    const c = getConversation();
    if (!c || c.status === 'closed') {
      error.textContent = 'افتح محادثة غير مغلقة أولًا';
      return;
    }
    const value = append && getText().trim() ? getText() + '\n\n' + t.body : t.body;
    if (value.length > 4000) {
      error.textContent = 'المسودة ستتجاوز 4000 حرف. عدّل النص أو اختر وضع الرد بدل إضافته.';
      return;
    }
    setText(value);
    error.textContent = 'تم وضع النص في المسودة فقط. راجعه ثم اضغط إرسال.';
  }
  find('[data-template]').onchange = preview;
  find('[data-refresh-templates]').onclick = loadTemplates;
  find('[data-replace]').onclick = () => useTemplate(false);
  find('[data-append]').onclick = () => useTemplate(true);
  find('[data-save-priority]').onclick = () =>
    act('priority', { priority: find('[data-priority]').value });
  if (manager) {
    find('[data-staff-refresh]').onclick = loadStaff;
    find('[data-assign]').onclick = () => {
      const target = find('[data-assignee]').value;
      if (!target) {
        error.textContent = 'اختر الموظف أولًا';
        return;
      }
      act('assign', { assignee: target });
    };
    const dialog = document.createElement('dialog');
    dialog.className = 'chat-template-dialog';
    dialog.innerHTML = `<form><h2 data-heading>رد جاهز</h2><label>العنوان<input name="title" maxlength="120" required></label><label>النص<textarea name="body" maxlength="3000" required></textarea></label><label data-active-row><input type="checkbox" name="active">رد مفعّل للموظفين</label><p class="chat-help">نص عادي فقط، بدون متغيرات تلقائية. لا تضع أكوادًا أو أسرارًا أو وعودًا غير معتمدة.</p><p data-form-error class="chat-error" role="alert"></p><div class="chat-controls"><button class="primary" type="submit">حفظ الرد</button><button class="secondary" type="button" data-cancel>إلغاء</button></div></form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    function edit(t) {
      editorRecord = t || null;
      form.elements.title.value = t?.title || '';
      form.elements.body.value = t?.body || '';
      form.elements.active.checked = t ? !!t.active : true;
      dialog.querySelector('[data-active-row]').hidden = !t;
      dialog.querySelector('[data-heading]').textContent = t
        ? 'تعديل الرد الجاهز'
        : 'إضافة رد جاهز';
      dialog.querySelector('[data-form-error]').textContent = '';
      dialog.showModal();
    }
    find('[data-new-template]').onclick = () => edit(null);
    find('[data-edit-template]').onclick = () => {
      const t = templates.find((t) => t.id === find('[data-template]').value);
      if (!t) {
        error.textContent = 'اختر ردًا لتعديله';
        return;
      }
      edit(t);
    };
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const record = editorRecord,
        payload = {
          title: form.elements.title.value,
          body: form.elements.body.value,
          active: form.elements.active.checked,
          ...(record ? { revision: record.revision } : {}),
        };
      form.querySelectorAll('button,input,textarea').forEach((e) => (e.disabled = true));
      try {
        await api(
          '/chat/templates' + (record ? '/' + record.id : ''),
          record ? 'PUT' : 'POST',
          payload,
        );
        dialog.close();
        await loadTemplates();
      } catch (e) {
        dialog.querySelector('[data-form-error]').textContent = e.message;
      } finally {
        form.querySelectorAll('button,input,textarea').forEach((e) => (e.disabled = false));
      }
    };
  }
  update(null);
  await Promise.all([loadTemplates(), loadStaff()]);
  return { update };
}
