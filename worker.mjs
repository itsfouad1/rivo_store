import {createStoreHandler} from './lib/store-api.mjs';
import {authService} from './lib/auth.mjs';
export default {
 async fetch(req,env){
  try{
   const url=new URL(req.url),auth=authService(env.DB);
   const response=await auth.handle(req);if(response)return response;
   if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/'))return createStoreHandler({db:env.DB,bucket:env.BUCKET,resolveIdentity:auth.identity})(req);
   if(['/login','/register','/recover','/admin','/account'].includes(url.pathname)){
    const assetUrl=new URL('/dashboard.html',url);const r=await env.ASSETS.fetch(new Request(assetUrl,{method:'GET'}));
    const headers=new Headers(r.headers);headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('Content-Security-Policy',"frame-ancestors 'none'");return new Response(r.body,{status:r.status,headers});
   }
   return env.ASSETS.fetch(req);
  }catch(e){console.error('Request failed',e?.name);return Response.json({error:'تعذّر تنفيذ العملية، حاول مجددًا'},{status:500,headers:{'Cache-Control':'no-store'}});}
 },
 async scheduled(event,env){await env.DB.batch([env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at<?').bind(Date.now()),env.DB.prepare('DELETE FROM auth_limits WHERE window<?').bind(Math.floor(Date.now()/900000)-2)]);}
};
