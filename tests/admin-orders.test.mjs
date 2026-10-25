import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createStoreHandler} from '../lib/store-api.mjs';
function fixture(){
 const sql=new DatabaseSync(':memory:');for(const f of ['0001_store','0004_foxreload','0005_exchange_rates','0006_payunit','0007_product_guides','0008_admin_order_search'])sql.exec(readFileSync(new URL('../migrations/'+f+'.sql',import.meta.url),'utf8'));
 function prepare(q,args=[]){return {q,args,bind(...v){return prepare(q,v)},async first(){return sql.prepare(q).get(...args)||null},async all(){return {results:sql.prepare(q).all(...args)}},async run(){return sql.prepare(q).run(...args)}}}
 const db={prepare,async batch(ss){sql.exec('BEGIN');try{const r=ss.map(s=>sql.prepare(s.q).run(...s.args));sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 sql.prepare('INSERT INTO users VALUES (?,?,?,?)').run('buyer','fouad@example.test','فؤاد أحمد','2020-01-01T00:00:00.000Z');
 const pid=crypto.randomUUID();sql.prepare("INSERT INTO products(id,name,slug,category,description,price_cents,currency,image_url,status,payment_mode,region,player_id_required,supplier_product_id,sort_order,created_at,updated_at) VALUES (?,'Steam card','card','Cards','',1000,'USD','','active','both','US',0,'',0,'2020','2020')").run(pid);
 function order({status='awaiting_payment',payment='unpaid',date='2026-10-25T10:00:00.000Z',method='whatsapp',player='123456',name='Steam card',env,invoice,reference}={}){
  const id=crypto.randomUUID(),item=crypto.randomUUID();sql.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'buyer',method,payment,status,1000,'USD',player,'customer text','internal note','',crypto.randomUUID(),date,date);
  sql.prepare('INSERT INTO order_items(id,order_id,product_id,name,region,unit_cents,quantity) VALUES (?,?,?,?,?,?,?)').run(item,id,pid,name,'US',1000,1);
  if(env)sql.prepare("INSERT INTO payunit_invoices(order_id,invoice_id,amount_usd_cents,status,environment,payment_reference,created_at,updated_at) VALUES (?,?,1000,'pending',?,?,?,?)").run(id,invoice||'inv_'+id,env,reference||'',date,date);
  return {id,item};
 }
 function job(o,status='failed',mock=0,error=''){sql.prepare('INSERT INTO fox_jobs(id,item_id,is_mock,remote_id,status,request_json,result_json,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),o.item,mock,'fox_'+crypto.randomUUID(),status,'SECRET REQUEST','["SECRET CODE"]',error,'2026','2026');}
 const handle=createStoreHandler({db,foxEnabled:true,resolveIdentity:async r=>{const who=r.headers.get('who');return who?{id:who,email:who+'@test.invalid',name:who,role:who==='admin'?'admin':'customer'}:null}});
 async function get(path,who='admin'){const r=await handle(new Request('https://rivo.test'+path,{headers:who?{who}:{}}));return {status:r.status,cache:r.headers.get('cache-control'),data:await r.json()};}
 const find=q=>get('/api/admin/orders?q='+encodeURIComponent(q));
 return {sql,order,job,get,find};
}
test('admin search and detail are unavailable to anonymous users and customers',async()=>{const x=fixture(),o=x.order();for(const path of ['/api/admin/orders','/api/admin/orders/alerts','/api/admin/orders/'+o.id]){assert.equal((await x.get(path,null)).status,401);assert.equal((await x.get(path,'buyer')).status,403)}assert.equal((await x.get('/api/admin/orders/'+o.id)).cache,'no-store')});
test('support search finds old orders outside the latest 300 and accepts short numbers and customer links',async()=>{
 const x=fixture(),old=x.order({date:'2020-01-01T00:00:00.000Z',player:'old-player'});for(let i=0;i<310;i++)x.order();
 for(const q of [old.id,'#'+old.id.slice(0,8),'https://rivo.test/order.html?order='+old.id,'old-player']){const r=await x.find(q);assert.equal(r.status,200);assert.equal(r.data.orders[0].id,old.id);assert.equal(r.data.total,1)}
 const first=await x.get('/api/admin/orders');assert.equal(first.data.total,311);assert.equal(first.data.orders.length,25);assert.ok(!first.data.orders.some(o=>o.id===old.id));
 const second=await x.get('/api/admin/orders?page=2');assert.equal(new Set([...first.data.orders,...second.data.orders].map(o=>o.id)).size,50);
});
test('search combines customer and product words, normalizes Arabic alef, and treats SQL wildcards literally',async()=>{
 const x=fixture();const a=x.order({name:'بطاقة ألعاب Steam',player:'id_100%'});x.order({name:'PUBG',player:'idX1000'});
 for(const q of ['احمد Steam','FOUAD@EXAMPLE.TEST العاب','id_100%']){const r=await x.find(q);assert.equal(r.status,200);assert.equal(r.data.total,1);assert.equal(r.data.orders[0].id,a.id)}
 assert.equal((await x.find("%' OR 1=1 --")).data.total,0);
});
test('search supports provider invoice identifiers and excludes secrets from job summaries',async()=>{
 const x=fixture(),o=x.order({method:'gateway',env:'live',invoice:'inv_live_SPECIAL',reference:'PAYREF-1122'});x.job(o);
 for(const q of ['inv_live_SPECIAL','PAYREF-1122']){const r=await x.find(q);assert.equal(r.data.orders[0].id,o.id)}
 const d=await x.get('/api/admin/orders/'+o.id);assert.equal(d.status,200);assert.equal(d.data.order.customer_email,'fouad@example.test');assert.equal(d.data.order.supplier_jobs[0].status,'failed');assert.ok(!JSON.stringify(d.data).includes('SECRET'));assert.equal(d.data.order.payment_reference.invoice_id,'inv_live_SPECIAL');
 const remote=d.data.order.supplier_jobs[0].remote_id;assert.equal((await x.find(remote)).data.total,1);
});
test('alerts cover all orders and exclude test payments and mock supplier jobs',async()=>{
 const x=fixture();x.order({payment:'paid',status:'processing',date:'2020-01-01T00:00:00.000Z'});
 const failed=x.order({payment:'paid',status:'processing'});x.job(failed);x.job(failed,'failed',1);
 const reviewed=x.order({payment:'paid',status:'processing'});x.job(reviewed,'action_required');
 x.order({payment:'paid',status:'cancelled'});x.order({payment:'partially_refunded',status:'cancelled'});
 const test=x.order({payment:'test_paid',status:'cancelled',method:'gateway',env:'test'});x.job(test);
 x.order({method:'gateway',env:'test'});const onlyMock=x.order();x.job(onlyMock,'failed',1);
 for(let i=0;i<305;i++)x.order({status:'completed',payment:'paid'});
 const a=await x.get('/api/admin/orders/alerts');assert.equal(a.status,200);assert.deepEqual(a.data.counts,{waiting:3,supplier:1,review:3,test:2});
 assert.equal((await x.get('/api/admin/orders?attention=supplier')).data.orders[0].id,failed.id);
 const waiting=await x.get('/api/admin/orders?attention=waiting');assert.equal(waiting.data.total,3);assert.equal(waiting.data.orders[0].created_at,'2020-01-01T00:00:00.000Z');
 assert.equal((await x.get('/api/admin/orders?mode=test')).data.total,2);
});
test('filters combine with inclusive UTC dates and reject invalid ranges and pagination',async()=>{
 const x=fixture();const o=x.order({method:'gateway',env:'live',date:'2026-10-24T23:59:59.999Z'});x.order({date:'2026-10-25T00:00:00.000Z'});
 const r=await x.get('/api/admin/orders?from=2026-10-24&to=2026-10-24&method=gateway&payment=unpaid&mode=live');assert.equal(r.data.total,1);assert.equal(r.data.orders[0].id,o.id);
 for(const q of ['page=0','limit=101','page=1.5','attention=unknown','status=bad','mode=bad','from=2026-02-30','from=2026-10-25&to=2026-10-24','q='+'x'.repeat(201)])assert.equal((await x.get('/api/admin/orders?'+q)).status,400);
 assert.equal((await x.get('/api/admin/orders/'+crypto.randomUUID())).status,404);
});
