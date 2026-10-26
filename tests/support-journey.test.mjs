import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync,readdirSync} from 'node:fs';import worker from '../worker.mjs';

// Exercises actual Worker routing, Auth cookies, current D1 roles, assistant and chat.
// Only Supabase's external identity responses are mocked; no live accounts are used.
test('full local buyer/support/owner journey through Worker and verified Auth sessions',async()=>{
 const sql=new DatabaseSync(':memory:');const ownerUuid='9fe15a87-5c6a-4575-839d-5bf4905aef6e';
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort()){
  sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  if(name==='0001_store.sql')sql.prepare('INSERT INTO users VALUES (?,?,?,?)').run('supabase:'+ownerUuid,'owner@example.test','Owner','2026');
 }
 function p(q,args=[]){return {q,args,bind(...v){return p(q,v)},async first(){return sql.prepare(q).get(...args)||null},async all(){return {results:sql.prepare(q).all(...args)}},async run(){return sql.prepare(q).run(...args)}}}
 const db={prepare:p,async batch(ss){sql.exec('BEGIN');try{const r=ss.map(s=>sql.prepare(s.q).run(...s.args));sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 for(const [c,n] of [['USD',1000000],['ILS',4000000],['JOD',710000],['EGP',50000000],['SAR',3750000],['AED',3670000],['TRY',34000000]])sql.prepare('INSERT OR REPLACE INTO exchange_rates VALUES (?,?,?)').run(c,n,new Date().toISOString());
 const people=Object.fromEntries(['owner','buyer','support','other'].map(name=>[name,{id:name==='owner'?ownerUuid:crypto.randomUUID(),email:name+'@example.test',email_confirmed_at:'2026-01-01T00:00:00Z',user_metadata:{name,role:'owner'}}]));
 const env={DB:db,SUPABASE_URL:'https://journey.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',ASSETS:{fetch:async()=>new Response('Static asset')}};
 const originalFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,env.SUPABASE_URL,'No external provider or payment calls permitted');
  if(u.pathname.endsWith('/token')){const data=JSON.parse(options.body),name=data.email.split('@')[0];return Response.json({access_token:'test-'+name,refresh_token:'refresh-'+name,expires_in:3600,user:people[name]});}
  if(u.pathname.endsWith('/user')){const name=options.headers.Authorization?.replace('Bearer test-','');return people[name]?Response.json(people[name]):Response.json({error:'bad identity'},{status:401});}
  throw Error('Unexpected Auth request '+url);
 };
 const jars=new Map();
 async function request(who,path,method='GET',body,extra={}){
  const req=new Request('https://rivo.test'+path,{method,headers:{Origin:'https://rivo.test',Cookie:jars.get(who)||'',...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const r=await worker.fetch(req,env);const cookies=r.headers.getSetCookie();if(cookies.length)jars.set(who,cookies.map(c=>c.split(';')[0]).join('; '));return {status:r.status,headers:r.headers,data:await r.json()};
 }
 try{
  for(const name of Object.keys(people)){const r=await request(name,'/api/auth/login','POST',{email:name+'@example.test',password:'Test-password-123456'});assert.equal(r.status,200);assert.ok(r.headers.getSetCookie().every(c=>c.includes('HttpOnly')&&c.includes('Secure')));assert.equal(r.data.user.role,name==='owner'?'owner':'customer');}
  const supportId='supabase:'+people.support.id;
  assert.equal((await request('owner','/api/admin/team/'+encodeURIComponent(supportId),'PUT',{role:'support',active:true,permissions:[]})).status,200);
  assert.equal((await request('support','/api/session')).data.user.role,'support');
  assert.equal((await request('buyer','/api/admin/team')).status,403);
  assert.equal((await request('other','/api/admin/team', 'GET',undefined,{'oai-authenticated-user-id':'supabase:'+ownerUuid})).status,403);
  await request('owner','/api/admin/settings','PUT',{whatsapp:'970599123456'});
  const product=(await request('owner','/api/admin/products','POST',{name:'Steam journey card',slug:'journey-card',category:'Cards',price_cents:1000,currency:'USD',status:'active',payment_mode:'whatsapp',player_id_required:false})).data.product;
  const placed=await request('buyer','/api/orders','POST',{items:[{id:product.id,quantity:1}],payment_method:'whatsapp',display_currency:'ILS',idempotency_key:crypto.randomUUID()});assert.equal(placed.status,201);const orderId=placed.data.order_id;
  assert.equal((await request('buyer','/api/assistant','POST',{intent:'order',order_id:orderId})).data.orders[0].id,orderId);
  assert.equal((await request('other','/api/assistant','POST',{intent:'order',order_id:orderId})).data.orders.length,0);
  const chat=await request('buyer','/api/chat','POST',{order_id:orderId,message:'أحتاج مساعدة بطلبي',client_id:crypto.randomUUID()});assert.equal(chat.status,201);const id=chat.data.id;
  assert.equal((await request('support','/api/chat/summary')).data.unread_messages,1);
  assert.equal((await request('support','/api/chat/'+id+'/action','POST',{action:'claim',revision:0})).status,200);
  const view=(await request('support','/api/chat/'+id)).data;assert.equal(view.linked_order.id,orderId);assert.equal(view.linked_order.admin_note,undefined);
  assert.equal((await request('support','/api/chat/'+id+'/read','POST',{last_seq:view.messages.at(-1).seq})).status,200);
  assert.equal((await request('support','/api/chat/summary')).data.unread_messages,0);
  assert.equal((await request('support','/api/admin/orders/'+orderId,'PUT',{status:'completed',payment_status:'paid'})).status,403);
  assert.equal((await request('support','/api/admin/foxreload/execute','POST',{confirm:true})).status,403);
  assert.equal((await request('support','/api/chat/'+id+'/messages','POST',{message:'PRIVATE STAFF NOTE',internal:true,client_id:crypto.randomUUID()})).status,201);
  assert.equal((await request('buyer','/api/chat/summary')).data.unread_messages,0);
  const state=(await request('support','/api/chat/'+id)).data.conversation;
  assert.equal((await request('support','/api/chat/'+id+'/action','POST',{action:'escalate',reason:'مراجعة الإدارة مطلوبة',revision:state.revision})).status,200);
  assert.equal((await request('support','/api/chat/'+id)).status,404);
  assert.equal((await request('other','/api/chat/'+id)).status,404);
  const ownerView=(await request('owner','/api/chat/'+id)).data;assert.ok(ownerView.messages.some(m=>m.body==='PRIVATE STAFF NOTE'));
  assert.equal((await request('owner','/api/chat/'+id+'/action','POST',{action:'claim',revision:ownerView.conversation.revision})).status,200);
  await request('owner','/api/chat/'+id+'/messages','POST',{message:'وصلنا طلبك ونراجعه',client_id:crypto.randomUUID()});
  assert.equal((await request('buyer','/api/chat/summary')).data.unread_messages,1);
  const buyerView=(await request('buyer','/api/chat/'+id)).data;assert.ok(!JSON.stringify(buyerView).includes('PRIVATE STAFF NOTE'));assert.equal(buyerView.conversation.escalation_reason,undefined);
  await request('buyer','/api/chat/'+id+'/read','POST',{last_seq:buyerView.messages.at(-1).seq});assert.equal((await request('buyer','/api/chat/summary')).data.unread_messages,0);
  const c=(await request('owner','/api/chat/'+id)).data.conversation;await request('owner','/api/chat/'+id+'/action','POST',{action:'close',revision:c.revision});
  assert.equal(sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(orderId).payment_status,'unpaid');assert.equal(sql.prepare('SELECT count(*) AS n FROM fox_jobs').get().n,0);
  await request('owner','/api/admin/team/'+encodeURIComponent(supportId),'PUT',{role:'support',active:false,permissions:[]});assert.equal((await request('support','/api/chat/queue')).status,403);
 }finally{globalThis.fetch=originalFetch;sql.close();}
});
