import { staffIdentity, isManager } from './staff.mjs';

// Supabase owns password hashing. No password/hash is persisted in Cloudflare.
import { createHash, randomBytes } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const ACCESS = '__Host-rivo_access';
const REFRESH = '__Host-rivo_refresh';
const OAUTH = '__Host-rivo_oauth';

const cookie = (name, value, age) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function authService(db, env = {}, fetcher = fetch) {
  const cookies = [];
  const first = (sql, ...args) =>
    db
      .prepare(sql)
      .bind(...args)
      .first();
  const run = (sql, ...args) =>
    db
      .prepare(sql)
      .bind(...args)
      .run();

  // تنظيف رابط Supabase من المسافات أو الشرطة المائلة الأخيرة
  const supabaseUrl = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');

  function read(req, name) {
    try {
      return decodeURIComponent(
        (req.headers.get('cookie') || '')
          .split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith(name + '='))
          ?.slice(name.length + 1) || '',
      );
    } catch {
      return '';
    }
  }

  function clear() {
    cookies.push(cookie(ACCESS, '', 0), cookie(REFRESH, '', 0));
  }

  function save(s) {
    if (!s.access_token || !s.refresh_token) {
      throw new AuthError(502, 'تعذّر إنشاء جلسة الدخول');
    }
    cookies.push(
      cookie(ACCESS, s.access_token, Math.max(60, Math.min(s.expires_in || 3600, 86400))),
      cookie(REFRESH, s.refresh_token, 2592000),
    );
  }

  function finish(r) {
    if (!cookies.length) return r;
    const h = new Headers(r.headers);
    for (const c of cookies) h.append('Set-Cookie', c);
    h.set('Cache-Control', 'no-store');
    return new Response(r.body, { status: r.status, headers: h });
  }

  async function remote(path, body, access, method) {
    if (
      !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) ||
      !env.SUPABASE_PUBLISHABLE_KEY
    ) {
      throw new AuthError(503, 'تسجيل الحسابات قيد التجهيز، حاول لاحقًا');
    }

    let r;
    try {
      r = await fetcher(supabaseUrl + '/auth/v1' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
          ...(access ? { Authorization: 'Bearer ' + access } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000), // مهلة 15 ثانية
        redirect: 'follow', // السماح بإعادة التوجيه بدلاً من الخطأ الفوري
      });
    } catch (err) {
      console.error('[Supabase Fetch Error]:', err?.message || err);
      throw new AuthError(503, 'خدمة الحسابات غير متاحة مؤقتًا');
    }

    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  function check(r, message) {
    if (!r.ok) {
      throw new AuthError(
        r.status === 429 ? 429 : r.status >= 500 ? 503 : 400,
        r.status === 429 ? 'محاولات كثيرة، حاول لاحقًا' : message,
      );
    }
    return r.data;
  }

  async function localUser(u) {
    if (!u?.id || !u.email || !u.email_confirmed_at) {
      throw new AuthError(403, 'أكّد إيميلك أولًا');
    }
    const id = 'supabase:' + u.id;
    const name =
      typeof u.user_metadata?.name === 'string' ? u.user_metadata.name.slice(0, 100) : u.email;

    await run(
      'INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name',
      id,
      u.email,
      name,
      new Date().toISOString(),
    );
    await run(
      'INSERT INTO auth_roles (user_id,role) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING',
      id,
      'customer',
    );
    const role = await first('SELECT role FROM auth_roles WHERE user_id=?', id);
    return staffIdentity(db, {
      id,
      email: u.email,
      name,
      role: role?.role === 'admin' ? 'admin' : 'customer',
    });
  }

  async function identity(req) {
    let access = read(req, ACCESS);
    const refresh = read(req, REFRESH);
    if (!access && !refresh) return null;

    let r = access ? await remote('/user', null, access) : { ok: false, status: 401 };

    if (!r.ok && [401, 403].includes(r.status) && refresh) {
      const renewed = await remote('/token?grant_type=refresh_token', { refresh_token: refresh });
      if (!renewed.ok) {
        if (renewed.status >= 500 || renewed.status === 429) {
          throw new AuthError(503, 'خدمة الحسابات غير متاحة مؤقتًا');
        }
        clear();
        return null;
      }
      save(renewed.data);
      access = renewed.data.access_token;
      r = await remote('/user', null, access);
    }

    if (!r.ok) {
      if (r.status >= 500 || r.status === 429) {
        throw new AuthError(503, 'خدمة الحسابات غير متاحة مؤقتًا');
      }
      clear();
      return null;
    }

    if (!r.data.email_confirmed_at) return null;
    return localUser(r.data);
  }

  async function limit(key, max) {
    const window = Math.floor(Date.now() / 900000);
    const row = await first(
      'INSERT INTO auth_limits (key,window,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count',
      hash(key),
      window,
    );
    return row.count <= max;
  }

  async function callback(req) {
    const url = new URL(req.url);
    cookies.push(cookie(OAUTH, '', 0));
    try {
      const flow = JSON.parse(read(req, OAUTH) || '{}');
      if (
        req.method !== 'GET' ||
        url.searchParams.has('error') ||
        !/^[-_a-zA-Z0-9]{43,128}$/.test(flow.verifier || '') ||
        !Number.isFinite(flow.expires) ||
        !flow.state ||
        flow.state !== url.searchParams.get('state') ||
        flow.expires < Date.now() ||
        !url.searchParams.get('code')
      ) {
        throw new Error('Invalid OAuth callback');
      }

      const s = check(
        await remote('/token?grant_type=pkce', {
          auth_code: url.searchParams.get('code'),
          code_verifier: flow.verifier,
        }),
        'تعذّر الدخول',
      );
      const u = check(await remote('/user', null, s.access_token), 'تعذّر التحقق');
      const user = await localUser(u);
      save(s);

      return new Response(null, {
        status: 303,
        headers: {
          Location: ['owner', 'admin', 'support'].includes(user.role) ? '/admin' : '/account',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    } catch {
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/login?oauth_error=1',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }
  }

  async function handle(req) {
    try {
      const url = new URL(req.url);
      if (!url.pathname.startsWith('/api/auth/')) return null;
      const action = url.pathname.replace('/api/auth/', '');

      if (action === 'callback') return callback(req);
      if (req.method !== 'POST') return reply({ error: 'طريقة غير مسموحة' }, 405);
      if (req.headers.get('origin') !== url.origin) return reply({ error: 'مصدر غير مسموح' }, 403);

      if (action === 'logout') {
        let access = read(req, ACCESS);
        const refresh = read(req, REFRESH);
        if (!access && refresh) {
          const r = await remote('/token?grant_type=refresh_token', { refresh_token: refresh });
          if (r.ok) access = r.data.access_token;
        }
        if (access) {
          const r = await remote('/logout?scope=local', null, access, 'POST');
          if (!r.ok && ![401, 403, 404].includes(r.status)) {
            throw new AuthError(503, 'تعذّر تسجيل الخروج، حاول مجددًا');
          }
        }
        clear();
        return reply({ ok: true });
      }

      if (
        !['register', 'login', 'forgot', 'reset', 'confirm', 'resend', 'google'].includes(action)
      ) {
        return reply({ error: 'غير موجود' }, 404);
      }

      const clientIp = req.headers.get('cf-connecting-ip') || 'local';
      if (!(await limit('ip:' + clientIp, 30))) {
        return reply({ error: 'محاولات كثيرة، جرّب بعد 15 دقيقة' }, 429);
      }

      if (action === 'google') {
        const settings = check(await remote('/settings'), 'تعذّر التحقق من إعدادات الدخول');
        if (!settings.external?.google) {
          throw new AuthError(503, 'الدخول باستخدام Google قيد التجهيز، استخدم الإيميل مؤقتًا');
        }
        const flow = {
          verifier: randomBytes(32).toString('base64url'),
          state: randomBytes(24).toString('hex'),
          expires: Date.now() + 600000,
        };
        cookies.push(cookie(OAUTH, JSON.stringify(flow), 600));

        const callbackUrl = new URL('/api/auth/callback', req.url);
        callbackUrl.searchParams.set('state', flow.state);

        const target = new URL(supabaseUrl + '/auth/v1/authorize');
        target.searchParams.set('provider', 'google');
        target.searchParams.set('redirect_to', callbackUrl.href);
        target.searchParams.set(
          'code_challenge',
          createHash('sha256').update(flow.verifier).digest('base64url'),
        );
        target.searchParams.set('code_challenge_method', 's256');
        target.searchParams.set('prompt', 'select_account');

        return reply({ url: target.href });
      }

      if (Number(req.headers.get('content-length') || 0) > 5000) {
        return reply({ error: 'بيانات كبيرة' }, 413);
      }

      let b;
      try {
        const text = await req.text();
        if (text.length > 5000) return reply({ error: 'بيانات كبيرة' }, 413);
        b = JSON.parse(text);
      } catch {
        return reply({ error: 'بيانات غير صالحة' }, 400);
      }

      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return reply({ error: 'بيانات غير صالحة' }, 400);
      }

      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return reply({ error: 'أدخل إيميلًا صحيحًا' }, 400);
      }

      if (!(await limit('email:' + email, 10))) {
        return reply({ error: 'محاولات كثيرة، جرّب بعد 15 دقيقة' }, 429);
      }

      if (
        ['register', 'login', 'reset'].includes(action) &&
        (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128)
      ) {
        return reply({ error: 'كلمة المرور من 12 إلى 128 حرفًا' }, 400);
      }

      if (['confirm', 'reset'].includes(action) && !/^\d{6,10}$/.test(b.code || '')) {
        return reply({ error: 'أدخل رمز التحقق من الرسالة' }, 400);
      }

      if (action === 'register') {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) {
          return reply({ error: 'أدخل اسمك (حتى 100 حرف)' }, 400);
        }
        const r = await remote('/signup', {
          email,
          password: b.password,
          data: { name: b.name.trim() },
        });
        check(r, 'تعذّر التسجيل؛ جرّب الدخول إذا كان عندك حساب، أو حاول لاحقًا');

        // Always require email confirmation, even if the provider is misconfigured.
        if (r.data.access_token) {
          throw new AuthError(503, 'تسجيل الحسابات قيد التجهيز: تأكيد الإيميل غير مفعّل');
        }
        return reply({ confirmationRequired: true }, 201);
      }

      if (action === 'forgot' || action === 'resend') {
        const r = await remote(
          action === 'forgot' ? '/recover' : '/resend',
          action === 'forgot' ? { email } : { email, type: 'signup' },
        );
        if (!r.ok && (r.status >= 500 || r.status === 429)) {
          check(r, 'تعذّر إرسال الرسالة، حاول لاحقًا');
        }
        return reply({
          ok: true,
          message: 'إذا كان الإيميل مؤهلًا، ستصلك رسالة بالرمز. افحص البريد غير المرغوب فيه أيضًا.',
        });
      }

      if (action === 'reset') {
        const s = check(
          await remote('/verify', { email, token: b.code, type: 'recovery' }),
          'الرمز غير صحيح أو انتهت صلاحيته',
        );
        if (!s.access_token) throw new AuthError(400, 'تعذّر التحقق من الرمز');

        const changed = await remote('/user', { password: b.password }, s.access_token, 'PUT');
        // Do not persist recovery tokens in cookies or the response.
        await remote('/logout?scope=global', null, s.access_token, 'POST');
        check(changed, 'تعذّر تغيير كلمة المرور؛ اطلب رمزًا جديدًا وحاول بكلمة مختلفة');
        clear();
        return reply({ ok: true });
      }

      const s = check(
        await remote(
          action === 'login' ? '/token?grant_type=password' : '/verify',
          action === 'login'
            ? { email, password: b.password }
            : { email, token: b.code, type: 'signup' },
        ),
        action === 'login'
          ? 'تعذّر الدخول؛ تحقّق من الإيميل وكلمة المرور وتأكيد الإيميل'
          : 'الرمز غير صحيح أو انتهت صلاحيته',
      );

      const verified = check(await remote('/user', null, s.access_token), 'تعذّر التحقق من الحساب');
      const user = await localUser(verified);
      save(s);
      return reply({ user });
    } catch (e) {
      if (e instanceof AuthError) return reply({ error: e.message }, e.status);
      throw e;
    }
  }

  return { identity, handle, finish };
}
