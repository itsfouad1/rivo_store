import { createChatTools, queueFilters, eligibleEmployee } from './chat-tools.mjs';
const manager = (u) => ['owner', 'admin'].includes(u.role),
  staff = (u) => manager(u) || u.role === 'support';
const now = () => new Date().toISOString(),
  uuid = (v) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
export function createChat({ db, fail, json, body, log }) {
  const first = (q, ...p) =>
      db
        .prepare(q)
        .bind(...p)
        .first(),
    run = (q, ...p) =>
      db
        .prepare(q)
        .bind(...p)
        .run(),
    all = async (q, ...p) =>
      (
        await db
          .prepare(q)
          .bind(...p)
          .all()
      ).results;
  const tools = createChatTools({ db, fail, json, body, log });
  const changes = (r) => Number(r.meta?.changes ?? r.changes);
  function text(v, max) {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max)
      fail(400, 'تحقق من النص وطوله');
    return v.trim();
  }
  async function conversation(id, user) {
    if (!uuid(id)) fail(400, 'رقم المحادثة غير صالح');
    const c = await first('SELECT * FROM chat_conversations WHERE id=?', id);
    if (
      !c ||
      (!staff(user) && c.customer_id !== user.id) ||
      (staff(user) && !manager(user) && c.assignee !== user.id)
    )
      fail(404, 'المحادثة غير متاحة لهذا الحساب');
    return c;
  }
  function guard(u) {
    return manager(u)
      ? '1'
      : staff(u)
        ? "assignee=? AND status IN ('assigned','waiting_customer')"
        : "customer_id=? AND status<>'closed'";
  }
  const args = (u) => (manager(u) ? [] : [u.id]);

  function unreadSql(user, alias = 'c') {
    return `(SELECT count(*) FROM chat_messages um WHERE um.conversation_id=${alias}.id AND um.sender_id<>? ${staff(user) ? '' : "AND um.visibility='public'"} AND um.seq>coalesce((SELECT cr.last_seq FROM chat_reads cr WHERE cr.conversation_id=${alias}.id AND cr.user_id=?),0))`;
  }
  function scope(user) {
    return manager(user)
      ? { where: '1', params: [] }
      : staff(user)
        ? {
            where:
              "((c.status='waiting' AND c.assignee IS NULL) OR (c.assignee=? AND c.status IN ('assigned','waiting_customer','closed')))",
            params: [user.id],
          }
        : { where: 'c.customer_id=?', params: [user.id] };
  }
  async function summary(user) {
    const allowed = scope(user),
      row = await first(
        `SELECT coalesce(sum(unread_count),0) AS unread_messages,coalesce(sum(CASE WHEN unread_count>0 THEN 1 ELSE 0 END),0) AS unread_conversations FROM (SELECT ${unreadSql(user)} AS unread_count FROM chat_conversations c WHERE ${allowed.where})`,
        user.id,
        user.id,
        ...allowed.params,
      );
    return { ...row, checked_at: now() };
  }
  async function markRead(id, user, b) {
    await conversation(id, user);
    const last = b?.last_seq;
    if (!Number.isSafeInteger(last) || last < 1) fail(400, 'مؤشر قراءة غير صالح');
    const visible = await first(
      'SELECT seq FROM chat_messages WHERE conversation_id=? AND seq=?' +
        (staff(user) ? '' : " AND visibility='public'"),
      id,
      last,
    );
    if (!visible) fail(400, 'الرسالة ليست ضمن سجل المحادثة المتاح');
    const condition = manager(user) ? '1' : staff(user) ? 'assignee=?' : 'customer_id=?',
      params = manager(user) ? [] : [user.id];
    const r = await run(
      `INSERT INTO chat_reads(conversation_id,user_id,last_seq,updated_at) SELECT id,?,?,? FROM chat_conversations WHERE id=? AND (${condition}) ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_seq=max(chat_reads.last_seq,excluded.last_seq),updated_at=excluded.updated_at`,
      user.id,
      last,
      now(),
      id,
      ...params,
    );
    if (changes(r) !== 1) fail(409, 'لم تعد المحادثة متاحة لهذا الحساب');
    return {
      ok: true,
      last_seq: (
        await first(
          'SELECT last_seq FROM chat_reads WHERE conversation_id=? AND user_id=?',
          id,
          user.id,
        )
      ).last_seq,
    };
  }
  async function send(id, user, b) {
    const c = await conversation(id, user),
      message = text(b.message, 4000),
      visibility = b.internal === true ? 'internal' : 'public';
    if (c.status === 'closed') fail(409, 'المحادثة مغلقة؛ افتح محادثة جديدة');
    if (visibility === 'internal' && !staff(user)) fail(403, 'الملاحظات الداخلية للفريق فقط');
    if (!uuid(b.client_id)) fail(400, 'معرّف الرسالة غير صالح');
    const old = await first(
      'SELECT seq,body,visibility FROM chat_messages WHERE conversation_id=? AND sender_id=? AND client_id=?',
      id,
      user.id,
      b.client_id,
    );
    if (old) {
      if (old.body !== message || old.visibility !== visibility)
        fail(409, 'معرّف الرسالة مستخدم لنص آخر');
      return { seq: old.seq };
    }
    const minute = Math.floor(Date.now() / 60000),
      rate = await first(
        'INSERT INTO chat_limits(actor,window,hits) VALUES (?,?,1) ON CONFLICT(actor) DO UPDATE SET hits=CASE WHEN window=excluded.window THEN hits+1 ELSE 1 END,window=excluded.window RETURNING hits',
        user.id,
        minute,
      );
    if (rate.hits > 30) fail(429, 'رسائل كثيرة؛ انتظر قليلًا قبل المحاولة مجددًا');
    const permitted = guard(user),
      p = args(user),
      stamp = now();
    const inserted = await run(
      `INSERT OR IGNORE INTO chat_messages(conversation_id,sender_id,sender_kind,visibility,body,client_id,created_at) SELECT id,?,?,?,?,?,? FROM chat_conversations WHERE id=? AND status<>'closed' AND (${permitted})`,
      user.id,
      staff(user) ? 'staff' : 'customer',
      visibility,
      message,
      b.client_id,
      stamp,
      id,
      ...p,
    );
    const saved = await first(
      'SELECT seq,body,visibility FROM chat_messages WHERE conversation_id=? AND sender_id=? AND client_id=?',
      id,
      user.id,
      b.client_id,
    );
    if (!saved) fail(409, 'تغيّر إسناد المحادثة أو أُغلقت؛ حدّث الصفحة');
    if (saved.body !== message || saved.visibility !== visibility)
      fail(409, 'معرّف الرسالة مستخدم');
    if (changes(inserted))
      await run(
        "UPDATE chat_conversations SET updated_at=?,status=CASE WHEN ?='customer' AND status='waiting_customer' THEN 'assigned' ELSE status END WHERE id=?",
        stamp,
        staff(user) ? 'staff' : 'customer',
        id,
      );
    return { seq: saved.seq };
  }
  async function create(user, b) {
    if (user.role !== 'customer') fail(403, 'إنشاء المحادثة مخصص لحساب الزبون');
    text(b.message, 4000);
    if (!uuid(b.client_id)) fail(400, 'معرّف الرسالة غير صالح');
    const order = b.order_id || null;
    if (
      order &&
      (!uuid(order) ||
        !(await first('SELECT id FROM orders WHERE id=? AND user_id=?', order, user.id)))
    )
      fail(404, 'الطلب لا يتبع حسابك');
    const previous = await first(
      'SELECT m.body,c.id,c.order_id FROM chat_messages m JOIN chat_conversations c ON c.id=m.conversation_id WHERE m.sender_id=? AND m.client_id=?',
      user.id,
      b.client_id,
    );
    if (previous) {
      if (previous.body !== b.message.trim() || previous.order_id !== order)
        fail(409, 'معرّف الرسالة مستخدم');
      return { id: previous.id };
    }
    const id = crypto.randomUUID(),
      stamp = now(),
      subject = b.subject ? text(b.subject, 120) : 'مساعدة من فريق ريفو';
    await run(
      'INSERT OR IGNORE INTO chat_conversations(id,customer_id,order_id,subject,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      id,
      user.id,
      order,
      subject,
      stamp,
      stamp,
    );
    const c = await first(
      "SELECT * FROM chat_conversations WHERE customer_id=? AND status<>'closed'",
      user.id,
    );
    if (c.order_id !== order)
      fail(409, 'لديك محادثة مفتوحة؛ تابعها أولًا أو أغلقها قبل اختيار طلب آخر');
    await send(c.id, user, b);
    return { id: c.id };
  }
  async function action(id, user, b) {
    if (!staff(user)) fail(403, 'هذه العملية للفريق فقط');
    if (!b || typeof b !== 'object') fail(400, 'بيانات غير صالحة');
    const c = await first('SELECT * FROM chat_conversations WHERE id=?', id);
    if (!c) fail(404, 'المحادثة غير موجودة');
    if (!Number.isSafeInteger(b.revision) || b.revision !== c.revision)
      fail(409, 'تغيّرت المحادثة؛ حدّثها');
    let condition = '1',
      p = [],
      status = c.status,
      assignee = c.assignee,
      priority = c.priority;
    if (b.action === 'assign') {
      if (!manager(user)) fail(403, 'تعيين موظف للإدارة فقط');
      if (c.status === 'closed') fail(409, 'لا يمكن تعيين محادثة مغلقة');
      if (typeof b.assignee !== 'string' || b.assignee.length > 200)
        fail(400, 'معرّف موظف غير صالح');
      if (!(await first('SELECT 1 AS ok WHERE ' + eligibleEmployee, b.assignee)))
        fail(400, 'الموظف غير موجود أو وصوله معطل');
      condition = eligibleEmployee;
      p = [b.assignee];
      assignee = b.assignee;
      status = 'assigned';
    } else if (b.action === 'claim') {
      if (!manager(user)) {
        condition = "status='waiting' AND assignee IS NULL";
      } else if (c.status === 'closed') fail(409, 'المحادثة مغلقة');
      status = 'assigned';
      assignee = user.id;
    } else {
      if (!manager(user)) {
        condition = "assignee=? AND status IN ('assigned','waiting_customer')";
        p = [user.id];
      }
      if (c.status === 'closed') fail(409, 'المحادثة مغلقة');
      if (b.action === 'priority') {
        if (!['normal', 'urgent'].includes(b.priority)) fail(400, 'أولوية غير صالحة');
        priority = b.priority;
      } else if (b.action === 'escalate') {
        text(b.reason, 2000);
        status = 'escalated';
        assignee = null;
      } else if (b.action === 'close') status = 'closed';
      else if (b.action === 'wait') status = 'waiting_customer';
      else if (b.action === 'release' && manager(user)) {
        status = 'waiting';
        assignee = null;
      } else fail(400, 'عملية غير مسموحة');
    }
    const result = await run(
      `UPDATE chat_conversations SET status=?,assignee=?,priority=?,escalation_reason=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (${condition})`,
      status,
      assignee,
      priority,
      b.action === 'escalate' ? b.reason.trim() : c.escalation_reason,
      now(),
      id,
      b.revision,
      ...p,
    );
    if (changes(result) !== 1) fail(409, 'استلم موظف آخر المحادثة أو لم تعد متاحة');
    if (b.action === 'escalate')
      await run(
        "INSERT INTO chat_messages(conversation_id,sender_id,sender_kind,visibility,body,client_id,created_at) VALUES (?,?,'staff','internal',?,?,?)",
        id,
        user.id,
        'سبب التصعيد: ' + b.reason.trim(),
        crypto.randomUUID(),
        now(),
      );
    await log(
      user.id,
      'chat_' + b.action,
      ['assign', 'priority'].includes(b.action)
        ? JSON.stringify({ conversation_id: id, assignee, priority })
        : id,
    );
    return { ok: true };
  }
  async function handle(req, user) {
    const url = new URL(req.url),
      path = url.pathname,
      method = req.method;
    if (!path.startsWith('/api/chat')) return null;
    const toolResponse = await tools.handle(req, user);
    if (toolResponse) return toolResponse;
    if (path === '/api/chat/summary' && method === 'GET') return json(await summary(user));
    if (path === '/api/chat' && method === 'POST')
      return json(await create(user, await body(req)), 201);
    if (path === '/api/chat' && method === 'GET') {
      if (user.role !== 'customer') fail(403, 'هذه القائمة للزبون');
      return json({
        conversations: await all(
          `SELECT id,order_id,subject,status,created_at,updated_at,${unreadSql(user)} AS unread_count FROM chat_conversations c WHERE customer_id=? ORDER BY (unread_count>0) DESC,updated_at DESC,id DESC LIMIT 30`,
          user.id,
          user.id,
          user.id,
        ),
      });
    }
    if (path === '/api/chat/queue' && method === 'GET') {
      if (!staff(user)) fail(403, 'قائمة الانتظار للفريق فقط');
      const page = Number(url.searchParams.get('page') || 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000) fail(400, 'رقم الصفحة غير صالح');
      const mode = url.searchParams.get('mode') || 'open';
      if (!['open', 'closed', 'escalated', 'all'].includes(mode)) fail(400, 'فلتر غير صالح');
      let where = mode === 'all' ? '1' : mode === 'open' ? "c.status<>'closed'" : 'c.status=?',
        params = ['open', 'all'].includes(mode) ? [] : [mode];
      if (!manager(user)) {
        where +=
          " AND ((c.status='waiting' AND c.assignee IS NULL) OR (c.assignee=? AND c.status IN ('assigned','waiting_customer','closed')))";
        params.push(user.id);
      }
      const filters = queueFilters(url.searchParams, user, fail);
      where += filters.sql;
      params.push(...filters.values);
      const total = (
        await first('SELECT count(*) AS n FROM chat_conversations c WHERE ' + where, ...params)
      ).n;
      const conversations = await all(
        'SELECT c.*,u.name AS customer_name,u.email AS customer_email,a.name AS assignee_name,' +
          unreadSql(user) +
          ' AS unread_count FROM chat_conversations c JOIN users u ON u.id=c.customer_id LEFT JOIN users a ON a.id=c.assignee WHERE ' +
          where +
          ` ORDER BY CASE WHEN c.priority='urgent' THEN 0 ELSE 1 END,c.updated_at DESC,c.id DESC LIMIT 30 OFFSET ?`,
        user.id,
        user.id,
        ...params,
        (page - 1) * 30,
      );
      return json({
        conversations,
        total,
        page,
        pages: Math.ceil(total / 30),
        manager: manager(user),
        notifications: await summary(user),
      });
    }
    const match = path.match(/^\/api\/chat\/([a-f0-9-]{36})(\/messages|\/action|\/close|\/read)?$/);
    if (!match) fail(404, 'المسار غير موجود');
    const id = match[1];
    if (match[2] === '/read' && method === 'POST')
      return json(await markRead(id, user, await body(req)));
    if (match[2] === '/close' && method === 'POST') {
      const c = await conversation(id, user);
      if (user.role !== 'customer') fail(403, 'هذه العملية لصاحب المحادثة');
      await run(
        "UPDATE chat_conversations SET status='closed',revision=revision+1,updated_at=? WHERE id=? AND customer_id=?",
        now(),
        c.id,
        user.id,
      );
      return json({ ok: true });
    }
    if (match[2] === '/messages' && method === 'POST')
      return json(await send(id, user, await body(req)), 201);
    if (match[2] === '/action' && method === 'POST')
      return json(await action(id, user, await body(req)));
    if (!match[2] && method === 'GET') {
      const c = await conversation(id, user),
        before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) fail(400, 'مؤشر الرسائل غير صالح');
      const rows = await all(
        'SELECT m.seq,m.body,m.visibility,m.sender_kind,m.created_at,u.name AS sender_name FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? AND m.seq<?' +
          (staff(user) ? '' : " AND m.visibility='public'") +
          ' ORDER BY m.seq DESC LIMIT 101',
        id,
        before,
      );
      const has_more = rows.length > 100,
        messages = rows.slice(0, 100).reverse();
      const safe = staff(user)
        ? c
        : {
            id: c.id,
            order_id: c.order_id,
            subject: c.subject,
            status: c.status,
            updated_at: c.updated_at,
          };
      let linked_order = null;
      if (staff(user) && c.order_id) {
        linked_order = await first(
          'SELECT id,total_cents,currency,payment_status,status,player_id,customer_update,customer_note FROM orders WHERE id=? AND user_id=?',
          c.order_id,
          c.customer_id,
        );
        if (linked_order)
          linked_order.items = await all(
            "SELECT i.name,i.quantity,i.region,coalesce(a.player_id,o.player_id,'') AS player_id,CASE WHEN a.item_id IS NULL THEN 'legacy' ELSE 'item' END AS input_source FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN order_item_accounts a ON a.item_id=i.id WHERE i.order_id=?",
            c.order_id,
          );
      }
      return json({ conversation: safe, messages, has_more, linked_order });
    }
    fail(405, 'طريقة غير مسموحة');
  }
  return { handle };
}
