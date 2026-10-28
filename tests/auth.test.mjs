import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { authService } from '../lib/auth.mjs';
import worker from '../worker.mjs';
const env = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
};
const person = {
  id: 'test-user-id',
  email: 'customer@gmail.com',
  email_confirmed_at: '2026-10-22T00:00:00Z',
  user_metadata: { name: 'Fouad', role: 'admin' },
};
const creds = { email: person.email, password: 'A-strong-password-2026', name: 'Fouad' };
const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  user: person,
};
function setup(route) {
  const sql = new DatabaseSync(':memory:');
  for (const n of ['0001_store', '0002_auth', '0003_supabase_roles', '0009_staff'])
    sql.exec(readFileSync(new URL('../migrations/' + n + '.sql', import.meta.url), 'utf8'));
  function p(s, args = []) {
    return {
      bind(...a) {
        return p(s, a);
      },
      async first() {
        return sql.prepare(s).get(...args) || null;
      },
      async run() {
        return sql.prepare(s).run(...args);
      },
      async all() {
        return { results: sql.prepare(s).all(...args) };
      },
      s,
      args,
    };
  }
  const db = {
    prepare: p,
    async batch(stmts) {
      sql.exec('BEGIN');
      try {
        const result = stmts.map((s) => sql.prepare(s.s).run(...s.args));
        sql.exec('COMMIT');
        return result;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const calls = [];
  const remote = async (url, options) => {
    assert.equal(new URL(url).origin, env.SUPABASE_URL);
    assert.equal(options.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    const result = route?.(url, options, body) || {
      data: url.endsWith('/user') ? person : url.endsWith('/signup') ? { user: person } : session,
      status: 200,
    };
    return Response.json(result.data || {}, { status: result.status || 200 });
  };
  return { sql, db, calls, make: (config = env) => authService(db, config, remote) };
}
const request = (action, body = {}, cookie = '', origin = 'https://rivo.test') =>
  new Request('https://rivo.test/api/auth/' + action, {
    method: 'POST',
    headers: {
      origin,
      cookie,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1',
    },
    body: JSON.stringify(body),
  });
const withCookies = (c) => new Request('https://rivo.test/api/session', { headers: { cookie: c } });
test('signup delegates hashing, ignores requested role, requires confirmation and saves no passwords', async () => {
  const t = setup(),
    auth = t.make(),
    r = await auth.handle(request('register', { ...creds, role: 'admin' }));
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { confirmationRequired: true });
  assert.equal(t.calls[0].body.data.role, undefined);
  assert.equal(t.sql.prepare('SELECT count(*) n FROM auth_accounts').get().n, 0);
  assert.equal(t.sql.prepare('SELECT count(*) n FROM users').get().n, 0);
  assert.equal(auth.finish(r).headers.get('set-cookie'), null);
});
test('reject disabled email confirmation instead of creating an unverified session', async () => {
  const t = setup(() => ({ data: session }));
  const r = await t.make().handle(request('register', creds));
  assert.equal(r.status, 503);
});
test('login verifies with Auth server, roles are local and cookies are HttpOnly', async () => {
  const t = setup(),
    auth = t.make();
  const r = auth.finish(await auth.handle(request('login', creds)));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.user.role, 'customer');
  assert.equal(data.access_token, undefined);
  assert.equal(data.user.id, 'supabase:test-user-id');
  const cs = r.headers.getSetCookie();
  assert.equal(cs.length, 2);
  assert.ok(cs.every((c) => c.includes('HttpOnly; Secure; SameSite=Lax')));
  assert.ok(
    t.calls.some(
      (c) => c.url.endsWith('/user') && c.options.headers.Authorization === 'Bearer access-token',
    ),
  );
  t.sql.exec("UPDATE auth_roles SET role='admin'");
  const user = await t.make().identity(withCookies('__Host-rivo_access=access-token'));
  assert.equal(user.role, 'admin');
});
test('unverified user and forged old identity/session cannot access admin', async () => {
  const t = setup(() => ({ data: { ...person, email_confirmed_at: null } }));
  assert.equal(await t.make().identity(withCookies('__Host-rivo_access=bad')), null);
  const r = await worker.fetch(
    new Request('https://rivo.test/api/admin/overview', {
      headers: {
        'oai-authenticated-user-id': 'owner',
        'oai-authenticated-user-email': 'owner@gmail.com',
        cookie: '__Host-rivo_session=legacy',
      },
    }),
    { DB: t.db, ...env },
  );
  assert.equal(r.status, 401);
});
test('expired access refreshed and validated; transient provider errors do not clear cookies', async () => {
  const t = setup((url, opt) =>
    url.endsWith('/user') && opt.headers.Authorization === 'Bearer expired'
      ? { status: 401 }
      : null,
  );
  const auth = t.make();
  assert.equal(
    (
      await auth.identity(
        withCookies('__Host-rivo_access=expired; __Host-rivo_refresh=refresh-token'),
      )
    ).role,
    'customer',
  );
  assert.equal(auth.finish(Response.json({})).headers.getSetCookie().length, 2);
  const unavailable = setup(() => ({ status: 503 }));
  const a = unavailable.make();
  await assert.rejects(() => a.identity(withCookies('__Host-rivo_access=access-token')));
  assert.equal(a.finish(Response.json({})).headers.get('set-cookie'), null);
});
test('invalid refresh clears cookies and cannot create a session', async () => {
  const t = setup(() => ({ status: 401 })),
    a = t.make();
  assert.equal(await a.identity(withCookies('__Host-rivo_refresh=invalid')), null);
  assert.ok(
    a
      .finish(Response.json({}))
      .headers.getSetCookie()
      .every((c) => c.includes('Max-Age=0')),
  );
});
test('CSRF and malformed input rejected without contacting provider', async () => {
  const t = setup(),
    a = t.make();
  assert.equal((await a.handle(request('login', creds, '', 'https://evil.test'))).status, 403);
  assert.equal((await a.handle(request('register', { ...creds, password: 'short' }))).status, 400);
  assert.equal((await a.handle(request('login', null))).status, 400);
  assert.equal(t.calls.length, 0);
});
test('confirmation and recovery use separate OTP types; reset never exposes recovery tokens', async () => {
  const t = setup();
  const a = t.make();
  assert.equal(
    (await a.handle(request('confirm', { email: person.email, code: '12345678' }))).status,
    200,
  );
  assert.equal(t.calls[0].body.type, 'signup');
  const a2 = t.make();
  const r = await a2.handle(request('reset', { ...creds, code: '87654321' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const verify = t.calls.find((c) => c.body?.type === 'recovery');
  assert.equal(verify.body.token, '87654321');
  assert.ok(t.calls.some((c) => c.options.method === 'PUT' && c.body?.password === creds.password));
  assert.ok(t.calls.some((c) => c.url.endsWith('/logout?scope=global')));
  assert.ok(
    a2
      .finish(Response.json({}))
      .headers.getSetCookie()
      .every((c) => c.includes('Max-Age=0')),
  );
});
test('invalid recovery code cannot change password', async () => {
  const t = setup((url) => (url.endsWith('/verify') ? { status: 403 } : null));
  assert.equal((await t.make().handle(request('reset', { ...creds, code: '123456' }))).status, 400);
  assert.equal(
    t.calls.some((c) => c.options.method === 'PUT'),
    false,
  );
});
test('forgot response does not disclose unknown email; logout clears both cookies', async () => {
  const t = setup((url) => (url.endsWith('/recover') ? { status: 400 } : null));
  assert.equal((await t.make().handle(request('forgot', { email: person.email }))).status, 200);
  const a = t.make();
  const r = a.finish(await a.handle(request('logout', {}, '__Host-rivo_access=access-token')));
  assert.equal(r.status, 200);
  assert.equal(r.headers.getSetCookie().length, 2);
  assert.ok(t.calls.some((c) => c.url.endsWith('/logout?scope=local')));
});
test('configuration errors fail closed and retries are limited', async () => {
  const t = setup();
  assert.equal((await t.make({}).handle(request('login', creds))).status, 503);
  let r;
  for (let i = 0; i < 12; i++)
    r = await t.make().handle(request('forgot', { email: person.email }));
  assert.equal(r.status, 429);
});
test('Google uses PKCE and browser-bound state; callback returns role-based session', async () => {
  const t = setup((url) =>
    url.endsWith('/settings') ? { data: { external: { google: true } } } : null,
  );
  const a = t.make();
  const start = a.finish(await a.handle(request('google')));
  assert.equal(start.status, 200);
  const { url } = await start.json(),
    target = new URL(url);
  assert.equal(target.origin, env.SUPABASE_URL);
  assert.equal(target.searchParams.get('provider'), 'google');
  assert.equal(target.searchParams.get('code_challenge_method'), 's256');
  const c = start.headers.getSetCookie()[0],
    flow = JSON.parse(decodeURIComponent(c.split(';')[0].split('=')[1]));
  assert.notEqual(target.searchParams.get('code_challenge'), flow.verifier);
  const callback = new URL(target.searchParams.get('redirect_to'));
  assert.equal(callback.origin, 'https://rivo.test');
  assert.equal(callback.searchParams.get('state'), flow.state);
  callback.searchParams.set('code', 'valid-auth-code');
  const second = t.make();
  const result = second.finish(
    await second.handle(new Request(callback, { headers: { cookie: c } })),
  );
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/account');
  assert.equal(result.headers.getSetCookie().length, 3);
  assert.ok(
    t.calls.some(
      (c) => c.body?.auth_code === 'valid-auth-code' && c.body?.code_verifier === flow.verifier,
    ),
  );
});
test('Google callback rejects missing or mismatched state before contacting Auth', async () => {
  const t = setup();
  const r = await t
    .make()
    .handle(new Request('https://rivo.test/api/auth/callback?code=attacker&state=fake'));
  assert.equal(r.headers.get('location'), '/login?oauth_error=1');
  assert.equal(t.calls.length, 0);
  const flow = { state: 'expected', verifier: 'a'.repeat(43), expires: Date.now() + 60000 };
  const bad = await t.make().handle(
    new Request('https://rivo.test/api/auth/callback?code=attacker&state=other', {
      headers: { cookie: '__Host-rivo_oauth=' + encodeURIComponent(JSON.stringify(flow)) },
    }),
  );
  assert.equal(bad.headers.get('location'), '/login?oauth_error=1');
  assert.equal(t.calls.length, 0);
});
test('disabled Google provider fails clearly without an OAuth cookie', async () => {
  const t = setup((url) =>
      url.endsWith('/settings') ? { data: { external: { google: false } } } : null,
    ),
    a = t.make();
  const r = a.finish(await a.handle(request('google')));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('set-cookie'), null);
});
