import { createOperations } from './lib/operations.mjs';
import { publicDiscovery } from './lib/public-discovery.mjs';
import { createCollections } from './lib/collections.mjs';
import { createHomepage } from './lib/homepage.mjs';
import { createFoxreload } from './lib/foxreload.mjs';
import { createStoreHandler } from './lib/store-api.mjs';
import { authService } from './lib/auth.mjs';
import { ensureRates } from './lib/exchange.mjs';
import { createPayunit, payunitMode } from './lib/payunit.mjs';
export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url),
        auth = authService(env.DB, env);
      const discovery = await publicDiscovery(req, env.DB);
      if (discovery) return discovery;
      const collections = await createCollections(env.DB, auth.identity)(req);
      if (collections) return auth.finish(collections);
      const homepage = await createHomepage(env.DB, auth.identity)(req);
      if (homepage) return auth.finish(homepage);
      const operations = createOperations(env.DB, auth.identity);
      const operationResponse = await operations.handle(req);
      if (operationResponse) return auth.finish(operationResponse);
      const payment = createPayunit(env, auth.identity);
      const paymentResponse = await payment.handle(req);
      if (paymentResponse) return auth.finish(paymentResponse);
      const supplierResponse = await createFoxreload(
        { ...env, RIVO_OPERATIONS_ENABLED: true },
        auth.identity,
      ).handle(req);
      if (supplierResponse) return auth.finish(supplierResponse);
      const response = await auth.handle(req);
      if (response) return auth.finish(response);
      if (
        url.pathname === '/api/store' ||
        (url.pathname === '/api/orders' && req.method === 'POST') ||
        (/^\/api\/admin\/products\/[^/]+$/.test(url.pathname) && req.method === 'PUT')
      )
        await ensureRates(env.DB);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/'))
        return auth.finish(
          await createStoreHandler({
            db: env.DB,
            bucket: env.BUCKET,
            resolveIdentity: auth.identity,
            foxEnabled: true,
            operationsEnabled: true,
            gatewayReady: payment.configured(),
            gatewayMode: payunitMode(env),
            ai: env.AI,
            assistantAIEnabled: env.RIVO_AI_ENABLED !== 'false',
            assistantAIDailyLimit: env.RIVO_AI_DAILY_LIMIT ?? 80,
          })(req),
        );
      if (
        ['/login', '/register', '/recover', '/confirm', '/admin', '/account'].includes(url.pathname)
      ) {
        const assetUrl = new URL('/dashboard.html', url);
        const r = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
        const headers = new Headers(r.headers);
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'same-origin');
        headers.set('Content-Security-Policy', "frame-ancestors 'none'");
        headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
        return new Response(r.body, { status: r.status, headers });
      }
      if (
        [
          '/dashboard.html',
          '/order.html',
          '/payment.html',
          '/operations.html',
          '/chat.html',
        ].includes(url.pathname)
      ) {
        const r = await env.ASSETS.fetch(req),
          headers = new Headers(r.headers);
        headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
        headers.set('Cache-Control', 'no-store');
        return new Response(r.body, { status: r.status, headers });
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error('Request failed', e?.name);
      return Response.json(
        { error: 'تعذّر تنفيذ العملية، حاول مجددًا' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
  async scheduled(event, env) {
    if (event.cron === '*/15 * * * *') {
      const results = await Promise.allSettled([
        ensureRates(env.DB),
        createFoxreload({ ...env, RIVO_OPERATIONS_ENABLED: true }).scheduled(),
        createOperations(env.DB).reconcile(),
      ]);
      for (const result of results)
        if (result.status === 'rejected')
          console.error('Scheduled task failed', result.reason?.message);
      return;
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM chat_limits WHERE window<?').bind(
        Math.floor(Date.now() / 60000) - 1440,
      ),
      env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at<?').bind(Date.now()),
      env.DB.prepare('DELETE FROM auth_limits WHERE window<?').bind(
        Math.floor(Date.now() / 900000) - 2,
      ),
    ]);
  },
};
