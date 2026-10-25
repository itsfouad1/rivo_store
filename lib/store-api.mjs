import {countries,currencies,validCurrency,rateMap,convertCents,publicRates} from './exchange.mjs';
import {createAdminOrders} from './admin-orders.mjs';
// All authorization, pricing and order ownership checks live on the server.
const defaults={storeName:'RIVO | ريفو',tagline:'عالمك الرقمي، على كيفك',heroTitle:'رصيد جديد.',heroAccent:'جولة جديدة.',heroDescription:'لعبتك المفضّلة، بطاقتك الجاية، وبداية مغامرة جديدة. كل عالمك الرقمي في مكان واحد.',whatsapp:'',instagram:'rivoo.ps',currency:'USD',gatewayLabel:'بوابة الدفع',announcement:'قريبًا في ريفو — نجهّز المنتجات، تابعنا ليصلك الجديد.'};
const now=()=>new Date().toISOString();
const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
class Problem extends Error{constructor(status,message){super(message);this.status=status}}
const fail=(status,msg)=>{throw new Problem(status,msg)};
function string(v,max=500,required=false){if(typeof v!=='string')fail(400,'قيمة نصية غير صالحة');v=v.trim();if(v.length>max||required&&!v)fail(400,'تحقّق من الحقول المطلوبة وطول النص');return v}
function integer(v,min,max){if(!Number.isSafeInteger(v)||v<min||v>max)fail(400,'قيمة رقمية غير صالحة');return v}
function enumValue(v,options){if(!options.includes(v))fail(400,'خيار غير صالح');return v}
function safeImage(v){v=string(v,1000);if(!v)return '';if(/^\/media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(v))return v;let u;try{u=new URL(v)}catch{fail(400,'رابط الصورة غير صالح')}if(u.protocol!=='https:')fail(400,'استخدم رابط صورة HTTPS');return v}
function baseUrl(v){v=string(v,500);if(!v)return '';let u;try{u=new URL(v)}catch{fail(400,'رابط المورد غير صالح')}if(u.protocol!=='https:'||u.username||u.password)fail(400,'استخدم رابط HTTPS دون بيانات دخول');return u.href}
export function createStoreHandler({db,bucket,resolveIdentity=async()=>null,foxEnabled=false,gatewayReady=false,gatewayMode='test'}){
 const first=(sql,...p)=>db.prepare(sql).bind(...p).first();
 const all=async(sql,...p)=>(await db.prepare(sql).bind(...p).all()).results;
 const run=(sql,...p)=>db.prepare(sql).bind(...p).run();
 const log=(actor,action,target)=>run('INSERT INTO audit (id,actor,action,target,created_at) VALUES (?,?,?,?,?)',crypto.randomUUID(),actor,action,target,now());
 async function settings(){let row=await first('SELECT value FROM settings WHERE id=?','store');return {...defaults,...(row?JSON.parse(row.value):{})}}
 async function body(req){if(Number(req.headers.get('content-length')||0)>200000)fail(413,'حجم الطلب كبير');let text=await req.text();if(text.length>200000)fail(413,'حجم الطلب كبير');try{return JSON.parse(text)}catch{fail(400,'بيانات غير صالحة')}}
 function cleanProduct(p,id){return{id,name:string(p.name,120,true),slug:string(p.slug,100,true),category:string(p.category,80,true),description:string(p.description||'',3000),activation_instructions:string(p.activation_instructions??'',3000),delivery_estimate:string(p.delivery_estimate??'',200),purchase_notice:string(p.purchase_notice??'',1500),price_cents:integer(p.price_cents,0,100000000),currency:enumValue(p.currency,currencies),image_url:safeImage(p.image_url||''),status:enumValue(p.status,['draft','active','archived']),payment_mode:enumValue(p.payment_mode,['whatsapp','gateway','both']),region:string(p.region||'',100),player_id_required:p.player_id_required?1:0,supplier_id:p.supplier_id?string(p.supplier_id,100):null,supplier_product_id:string(p.supplier_product_id||'',150),sort_order:integer(p.sort_order??0,0,99999)}}
 async function productStatement(p,existing=false){if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug))fail(400,'الرابط يقبل أحرف إنجليزية صغيرة وأرقامًا وشرطات فقط');if(p.supplier_id&&!await first('SELECT id FROM suppliers WHERE id=?',p.supplier_id))fail(400,'المورد غير موجود');let collision=await first('SELECT id FROM products WHERE slug=? AND id<>?',p.slug,p.id);if(collision)fail(409,'رابط المنتج مستخدم');const keys=Object.keys(p);const t=now();return existing?db.prepare('UPDATE products SET '+keys.filter(k=>k!=='id').map(k=>k+'=?').join(',')+',updated_at=? WHERE id=?').bind(...keys.filter(k=>k!=='id').map(k=>p[k]),t,p.id):db.prepare('INSERT INTO products ('+keys.join(',')+',created_at,updated_at) VALUES ('+[...keys,'created_at','updated_at'].map(()=>'?').join(',')+')').bind(...keys.map(k=>p[k]),t,t)}
 async function publicProducts(targetCurrency,rates){
 const rows=await all('SELECT id,name,slug,category,description,activation_instructions,delivery_estimate,purchase_notice,price_cents,currency,image_url,payment_mode,region,player_id_required,sort_order FROM products WHERE status=? ORDER BY sort_order,created_at DESC','active');
 for(const p of rows){p.price_cents=convertCents(p.price_cents,p.currency,targetCurrency,rates);p.currency=targetCurrency;}
 if(foxEnabled){const links=await all('SELECT product_id,stock,min_qty,max_qty,checked_at FROM fox_products');const map=new Map(links.map(x=>[x.product_id,x]));for(const p of rows){const f=map.get(p.id);if(f){p.min_quantity=f.min_qty;p.max_quantity=Math.min(99,f.max_qty??99,f.stock);p.available=f.stock>=f.min_qty&&Date.now()-Date.parse(f.checked_at)<=86400000;}}}
 return rows;
 }
 async function hydrateOrders(list,admin=false){for(const o of list){o.items=await all('SELECT id,product_id,name,region,unit_cents,quantity,activation_instructions,delivery_estimate,purchase_notice FROM order_items WHERE order_id=?',o.id);if(o.payment_method==='gateway'){const p=await first('SELECT status,checkout_url,amount_usd_cents,fee_usd_cents,net_usd_cents FROM payunit_invoices WHERE order_id=?',o.id);if(p)o.gateway={status:p.status,amount_usd_cents:p.amount_usd_cents,currency:'USD',checkout_url:o.payment_status==='unpaid'?p.checkout_url:'',...(admin?{fee_usd_cents:p.fee_usd_cents,net_usd_cents:p.net_usd_cents}:{})};}if(!admin){delete o.admin_note;delete o.idempotency_key;delete o.user_id;}}return list}
 const adminOrders=createAdminOrders({db,hydrate:hydrateOrders,fail});
 return async function handle(req){try{
 const url=new URL(req.url),path=url.pathname,method=req.method;let user=await resolveIdentity(req);
 if(!['GET','HEAD'].includes(method)){const origin=req.headers.get('origin');if(!origin||origin!==url.origin)fail(403,'طلب من مصدر غير مسموح');}
 if(path==='/api/session'){if(user)await run('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name',user.id,user.email,user.name,now());return json({user})}
 if(path==='/api/store'&&method==='GET'){const currency=url.searchParams.get('currency')||'ILS';if(!validCurrency(currency))fail(400,'العملة المختارة غير مدعومة');const rates=await rateMap(db);if(!currencies.every(code=>rates[code]?.units>0))fail(503,'أسعار الصرف غير جاهزة بعد');const updatedAt=currencies.map(code=>rates[code].updatedAt).sort().at(0);return json({settings:await settings(),products:await publicProducts(currency,rates),gatewayReady:gatewayReady&&(gatewayMode==='live'||user?.role==='admin'),gatewayMode,paymentCurrency:'USD',market:{selectedCurrency:currency,countries,rates:publicRates(rates),updatedAt,source:'https://www.exchangerate-api.com'}})}
 if(path.startsWith('/media/')&&method==='GET'){const key=path.slice(7);if(!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(key))fail(404,'الصورة غير موجودة');const object=await bucket?.get(key);if(!object)fail(404,'الصورة غير موجودة');return new Response(object.body,{headers:{'content-type':object.httpMetadata?.contentType||'image/png','cache-control':'public,max-age=86400','x-content-type-options':'nosniff'}})}
 if(path.startsWith('/api/admin')){if(!user)fail(401,'سجّل الدخول أولًا');if(user.role!=='admin')fail(403,'هذه الصفحة مخصصة لإدارة المتجر');}
 else if(path.startsWith('/api/')){if(!user)fail(401,'سجّل الدخول أولًا');}
 if(user)await run('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name',user.id,user.email,user.name,now());
 if(path==='/api/admin/orders/alerts'&&method==='GET')return json(await adminOrders.alerts());
 if(path==='/api/admin/orders'&&method==='GET')return json(await adminOrders.list(url.searchParams));
 const adminDetail=path.match(/^\/api\/admin\/orders\/([a-f0-9-]{36})$/);
 if(adminDetail&&method==='GET')return json(await adminOrders.detail(adminDetail[1]));
 if(path==='/api/admin/overview'&&method==='GET'){const products=await all('SELECT * FROM products ORDER BY sort_order,created_at DESC');const orders=await hydrateOrders(await all('SELECT o.*,u.name AS customer_name,u.email AS customer_email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 300'),true);return json({products,orders,suppliers:await all('SELECT * FROM suppliers ORDER BY created_at DESC'),settings:await settings(),gatewayReady,activity:await all('SELECT action,target,created_at FROM audit ORDER BY created_at DESC LIMIT 12')})}
 if(path==='/api/admin/products'&&method==='POST'){const p=cleanProduct(await body(req),crypto.randomUUID());await (await productStatement(p)).run();await log(user.id,'product_created',p.name);return json({product:p},201)}
 if(path==='/api/admin/products/bulk'&&method==='POST'){
  const b=await body(req),action=enumValue(b.action,['publish','delete']);
  if(!Array.isArray(b.ids)||b.ids.length<1||b.ids.length>100)fail(400,'اختر من 1 إلى 100 منتج');
  const ids=[...new Set(b.ids.map(id=>string(id,100,true)))];if(ids.length!==b.ids.length)fail(400,'قائمة المنتجات تحتوي تكرارًا');
  const marks=ids.map(()=>'?').join(','),products=await all('SELECT id,name FROM products WHERE id IN ('+marks+')',...ids);
  if(products.length!==ids.length)fail(404,'أحد المنتجات المحددة غير موجود');
  if(action==='publish'){
   await run('UPDATE products SET status=?,updated_at=? WHERE id IN ('+marks+')','active',now(),...ids);
   await log(user.id,'products_published',String(ids.length));return json({ok:true,count:ids.length});
  }
  const used=await all('SELECT DISTINCT p.name FROM products p JOIN order_items i ON i.product_id=p.id WHERE p.id IN ('+marks+')',...ids);
  if(used.length)fail(409,'لا يمكن حذف منتجات مرتبطة بطلبات سابقة: '+used.slice(0,5).map(x=>x.name).join('، ')+'. استخدم الأرشفة لها.');
  const statements=[];if(foxEnabled)statements.push(db.prepare('DELETE FROM fox_products WHERE product_id IN ('+marks+')').bind(...ids));
  statements.push(db.prepare('DELETE FROM products WHERE id IN ('+marks+')').bind(...ids));
  statements.push(db.prepare('INSERT INTO audit (id,actor,action,target,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),user.id,'products_deleted',String(ids.length),now()));
  await db.batch(statements);return json({ok:true,count:ids.length});
 }
 const pm=path.match(/^\/api\/admin\/products\/([^/]+)$/);if(pm&&method==='PUT'){const existing=await first('SELECT * FROM products WHERE id=?',pm[1]);if(!existing)fail(404,'المنتج غير موجود');const input=await body(req);const p=cleanProduct({activation_instructions:existing.activation_instructions,delivery_estimate:existing.delivery_estimate,purchase_notice:existing.purchase_notice,...input},pm[1]);if(foxEnabled){const link=await first('SELECT * FROM fox_products WHERE product_id=?',pm[1]);if(link&&(p.supplier_id!=='foxreload'||p.supplier_product_id!==link.remote_id))fail(400,'حافظ على مورد ومعرّف FoxReload للمنتج المرتبط');if(link?.auto_price){const rates=await rateMap(db),usdCents=Number((BigInt(link.cost_units)*BigInt(10000+link.markup_bps)+999999n)/1000000n);p.price_cents=convertCents(usdCents,'USD',p.currency,rates);}}await(await productStatement(p,true)).run();await log(user.id,'product_updated',p.name);return json({product:p})}
 if(pm&&method==='DELETE'){const p=await first('SELECT name FROM products WHERE id=?',pm[1]);if(!p)fail(404,'المنتج غير موجود');await run('UPDATE products SET status=?,updated_at=? WHERE id=?','archived',now(),pm[1]);await log(user.id,'product_archived',p.name);return json({ok:true})}
 const pd=path.match(/^\/api\/admin\/products\/([^/]+)\/permanent$/);if(pd&&method==='DELETE'){
  const p=await first('SELECT id,name FROM products WHERE id=?',pd[1]);if(!p)fail(404,'المنتج غير موجود');
  if(await first('SELECT id FROM order_items WHERE product_id=? LIMIT 1',p.id))fail(409,'لا يمكن حذف منتج مرتبط بطلبات سابقة. استخدم الأرشفة للحفاظ على سجل الطلبات.');
  const statements=[];if(foxEnabled)statements.push(db.prepare('DELETE FROM fox_products WHERE product_id=?').bind(p.id));
  statements.push(db.prepare('DELETE FROM products WHERE id=?').bind(p.id));
  statements.push(db.prepare('INSERT INTO audit (id,actor,action,target,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),user.id,'product_deleted',p.name,now()));
  await db.batch(statements);return json({ok:true});
 }
 if(path==='/api/admin/settings'&&method==='PUT'){const b=await body(req),s={};for(const k of Object.keys(defaults))s[k]=string(b[k]??defaults[k],k==='heroDescription'?600:180);if(s.whatsapp&&!/^[1-9]\d{6,14}$/.test(s.whatsapp))fail(400,'رقم واتساب دولي دون + أو مسافات، مثل 970xxxxxxxxx');enumValue(s.currency,currencies);await run('INSERT INTO settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value','store',JSON.stringify(s));await log(user.id,'settings_updated','store');return json({settings:s})}
 if(path==='/api/admin/suppliers'&&method==='POST'){const b=await body(req),s={id:crypto.randomUUID(),name:string(b.name,100,true),base_url:baseUrl(b.base_url||''),secret_name:string(b.secret_name||'',80),notes:string(b.notes||'',1000)};if(s.secret_name&&!/^[A-Z][A-Z0-9_]*$/.test(s.secret_name))fail(400,'اسم متغير المفتاح يجب أن يكون أحرفًا كبيرة وأرقامًا وشرطة سفلية');await run('INSERT INTO suppliers (id,name,base_url,secret_name,notes,created_at) VALUES (?,?,?,?,?,?)',s.id,s.name,s.base_url,s.secret_name,s.notes,now());await log(user.id,'supplier_created',s.name);return json({supplier:s},201)}
 const sm=path.match(/^\/api\/admin\/suppliers\/([^/]+)$/);if(sm&&method==='PUT'){if(!await first('SELECT id FROM suppliers WHERE id=?',sm[1]))fail(404,'المورد غير موجود');const b=await body(req);const name=string(b.name,100,true),url=baseUrl(b.base_url||''),secret=string(b.secret_name||'',80),notes=string(b.notes||'',1000);if(secret&&!/^[A-Z][A-Z0-9_]*$/.test(secret))fail(400,'اسم متغير المفتاح غير صالح');await run('UPDATE suppliers SET name=?,base_url=?,secret_name=?,notes=? WHERE id=?',name,url,secret,notes,sm[1]);await log(user.id,'supplier_updated',name);return json({ok:true})}
 if(path==='/api/admin/import'&&method==='POST'){const b=await body(req);if(!Array.isArray(b.products)||b.products.length<1||b.products.length>100)fail(400,'أرسل من 1 إلى 100 منتج');const ids=new Set();const statements=[];for(const v of b.products){const p=cleanProduct({...v,status:'draft',supplier_id:b.supplier_id||null},crypto.randomUUID());if(ids.has(p.slug))fail(400,'روابط مكررة في ملف الاستيراد');ids.add(p.slug);statements.push(await productStatement(p))}await db.batch(statements);await log(user.id,'products_imported',String(statements.length));return json({count:statements.length})}
 if(path==='/api/admin/upload'&&method==='POST'){if(!bucket)fail(503,'رفع الصور غير مهيأ');const type=req.headers.get('content-type'),ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[type];if(!ext)fail(400,'ارفع PNG أو JPG أو WebP');const bytes=new Uint8Array(await req.arrayBuffer());if(bytes.length>4*1024*1024||bytes.length<12)fail(400,'الصورة يجب أن تكون أصغر من 4 ميجابايت');const valid=ext==='png'?bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71:ext==='jpg'?bytes[0]===255&&bytes[1]===216: new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';if(!valid)fail(400,'محتوى الصورة لا يطابق النوع');const key=crypto.randomUUID()+'.'+ext;await bucket.put(key,bytes,{httpMetadata:{contentType:type}});return json({url:'/media/'+key},201)}
 const detail=path.match(/^\/api\/orders\/([a-f0-9-]{36})$/);
 if(detail&&method==='GET'){
  const order=await first('SELECT * FROM orders WHERE id=? AND user_id=?',detail[1],user.id);if(!order)fail(404,'الطلب غير موجود أو لا يتبع هذا الحساب');
  const [safeOrder]=await hydrateOrders([order]);const config=await settings();
  const phone=String(config.whatsapp||'').replace(/[^0-9]/g,'');
  return json({order:safeOrder,support_url:/^[0-9]{8,15}$/.test(phone)?'https://wa.me/'+phone+'?text='+encodeURIComponent('مرحبًا ريفو، أحتاج مساعدة بخصوص الطلب '+order.id):null});
 }
 if(path==='/api/orders'&&method==='GET'){return json({orders:await hydrateOrders(await all('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200',user.id))})}
 if(path==='/api/orders'&&method==='POST'){
  const b=await body(req);if(!Array.isArray(b.items)||!b.items.length||b.items.length>20)fail(400,'اختر من 1 إلى 20 منتجًا');
  const payment=enumValue(b.payment_method,['whatsapp','gateway']);if(payment==='gateway'&&gatewayReady&&gatewayMode==='test'&&user.role!=='admin')fail(403,'الدفع التجريبي مخصص للإدارة');if(payment==='gateway'&&!gatewayReady)fail(409,'بوابة Payunit غير مهيأة بعد؛ لم يتم إنشاء طلب أو تحصيل مبلغ');
  const config=await settings();if(payment==='whatsapp'&&!/^[1-9]\d{6,14}$/.test(config.whatsapp))fail(409,'رقم واتساب المتجر لم يُضف بعد');
  const token=string(b.idempotency_key,100,true);if(!/^[a-f0-9-]{36}$/.test(token))fail(400,'معرّف الطلب غير صالح');
  const requestedCurrency=b.display_currency===undefined?null:enumValue(b.display_currency,currencies),rates=await rateMap(db);
  let old=await first('SELECT id,user_id,payment_method FROM orders WHERE idempotency_key=?',token);if(old&&old.user_id!==user.id)fail(409,'معرّف الطلب مستخدم');if(old){if(old.payment_method!==payment)fail(409,'طريقة دفع الطلب السابق مختلفة');return payment==='gateway'?json({order_id:old.id,payment_required:true,payment_currency:'USD'}):json({order_id:old.id,whatsapp_url:'https://wa.me/'+config.whatsapp+'?text='+encodeURIComponent('متابعة طلب ريفو '+old.id)});}
  let seen=new Set(),total=0,currency=requestedCurrency,items=[];
  for(const x of b.items){
   const id=string(x.id,100,true);if(seen.has(id))fail(400,'منتج مكرر');seen.add(id);integer(x.quantity,1,99);
   const p=await first('SELECT * FROM products WHERE id=? AND status=?',id,'active');if(!p)fail(409,'أحد المنتجات لم يعد متاحًا');
   if(foxEnabled){const f=await first('SELECT * FROM fox_products WHERE product_id=?',p.id);if(f){if(f.stock<x.quantity||x.quantity<f.min_qty||(f.max_qty!==null&&x.quantity>f.max_qty)||Date.now()-Date.parse(f.checked_at)>86400000)fail(409,'كمية أحد المنتجات غير متاحة؛ تواصل مع المتجر');p.fox=f;}}
   const allowed=payment==='gateway'?['gateway','both']:['whatsapp','both'];if(!allowed.includes(p.payment_mode))fail(409,'أحد المنتجات لا يدعم طريقة الدفع المختارة');
   if(!currency)currency=p.currency;else if(!requestedCurrency&&p.currency!==currency)fail(400,'حدّد عملة العرض لطلب منتجات بعملات أصلية مختلفة');
   if(p.player_id_required&&!b.player_id?.trim())fail(400,'معرّف اللاعب مطلوب لهذا المنتج');
   const unit_cents=convertCents(p.price_cents,p.currency,currency,rates),sale_usd_cents=convertCents(unit_cents,currency,'USD',rates);
   total+=unit_cents*x.quantity;items.push({...p,unit_cents,sale_usd_cents,quantity:x.quantity});
  }
  if(total>100000000)fail(400,'قيمة الطلب كبيرة');
  const id=crypto.randomUUID(),time=now(),orderStatus=payment==='gateway'?'awaiting_payment':'contact_pending';const statements=[db.prepare('INSERT INTO orders (id,user_id,payment_method,payment_status,status,total_cents,currency,player_id,customer_note,admin_note,customer_update,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,user.id,payment,'unpaid',orderStatus,total,currency,string(b.player_id||'',150),string(b.customer_note||'',600),'','',token,time,time)];
  if(payment==='gateway'){
   const usdTotal=items.reduce((sum,p)=>sum+p.sale_usd_cents*p.quantity,0);if(usdTotal<=0||usdTotal>100000000)fail(400,'مبلغ الدفع بالدولار خارج الحد');
   const payload={amount:(usdTotal/100).toFixed(2),currency:'USD',description:'RIVO order #'+id.slice(0,8),external_ref:id,success_url:url.origin+'/payment.html?order='+id};
   statements.push(db.prepare("INSERT INTO payunit_invoices(order_id,amount_usd_cents,rates_json,request_json,status,environment,created_at,updated_at) VALUES (?,?,?,?,'creating',?,?,?)").bind(id,usdTotal,JSON.stringify(rates),JSON.stringify(payload),gatewayMode,time,time));
  }
  for(const p of items){const itemId=crypto.randomUUID();statements.push(db.prepare('INSERT INTO order_items (id,order_id,product_id,name,region,unit_cents,quantity,activation_instructions,delivery_estimate,purchase_notice) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(itemId,id,p.id,p.name,p.region,p.unit_cents,p.quantity,p.activation_instructions,p.delivery_estimate,p.purchase_notice));if(p.fox)statements.push(db.prepare('INSERT INTO fox_order_lines(item_id,remote_id,cost_units,delivery_type,note_schema,sale_usd_cents) VALUES (?,?,?,?,?,?)').bind(itemId,p.fox.remote_id,p.fox.cost_units,p.fox.delivery_type,p.fox.note_schema,p.sale_usd_cents));}
  try{await db.batch(statements)}catch(err){const duplicate=await first('SELECT id,user_id,payment_method FROM orders WHERE idempotency_key=?',token);if(duplicate?.user_id===user.id&&duplicate.payment_method===payment){if(payment==='gateway')return json({order_id:duplicate.id,payment_required:true,payment_currency:'USD'});return json({order_id:duplicate.id,whatsapp_url:'https://wa.me/'+config.whatsapp+'?text='+encodeURIComponent('متابعة طلب ريفو '+duplicate.id)});}throw err}
  if(payment==='gateway')return json({order_id:id,payment_required:true,payment_currency:'USD'},201);
  const message='مرحبًا ريفو، أرغب بمتابعة الطلب '+id+'\n'+items.map(p=>p.name+' × '+p.quantity+(p.region?' — '+p.region:'')).join('\n')+'\nالإجمالي: '+(total/100).toFixed(2)+' '+currency+'\nلم يتم الدفع بعد.';return json({order_id:id,whatsapp_url:'https://wa.me/'+config.whatsapp+'?text='+encodeURIComponent(message)},201);
 }
 const om=path.match(/^\/api\/admin\/orders\/([^/]+)$/);if(om&&method==='PUT'){const b=await body(req),o=await first('SELECT * FROM orders WHERE id=?',om[1]);if(!o)fail(404,'الطلب غير موجود');if(foxEnabled&&await first("SELECT j.id FROM fox_jobs j JOIN order_items i ON i.id=j.item_id WHERE i.order_id=? AND j.is_mock=0 LIMIT 1",o.id)){if(b.payment_status!=='paid'||b.status==='cancelled')fail(409,'يوجد طلب لدى المورد؛ راجع نتيجته قبل تغيير الدفع أو الإلغاء');}const status=enumValue(b.status,['contact_pending','awaiting_payment','processing','completed','cancelled']),payment=enumValue(b.payment_status,['unpaid','paid','refunded','partially_refunded','test_paid','test_refunded','test_partially_refunded']);if(o.payment_method!=='gateway'&&!['unpaid','paid'].includes(payment))fail(400,'حالة دفع غير صالحة');if(o.payment_method==='gateway'&&payment!==o.payment_status)fail(409,'حالة دفع Payunit تُحدّث تلقائيًا من الإشعار الموقّع ولا يمكن تعديلها يدويًا');if(o.payment_method==='gateway'&&o.payment_status==='unpaid'&&status==='cancelled')fail(409,'ألغِ الفاتورة في Payunit أولًا ثم حدّث حالة الدفع');if(status==='completed'&&payment!=='paid')fail(400,'لا يمكن إكمال طلب دون تأكيد استلام الدفع');await run('UPDATE orders SET status=?,payment_status=?,admin_note=?,customer_update=?,updated_at=? WHERE id=?',status,payment,string(b.admin_note||'',2000),string(b.customer_update||'',2000),now(),o.id);await log(user.id,'order_updated',o.id);return json({ok:true})}
 fail(404,'الصفحة المطلوبة غير موجودة');
 }catch(e){if(e instanceof Problem)return json({error:e.message},e.status);console.error('RIVO request failed',e?.message);return json({error:'تعذّر تنفيذ العملية. حاول مجددًا.'},500)}}
}
