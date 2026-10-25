// Read-only support search. All values are bound; only fixed SQL fragments are used.
export function createAdminOrders({db,hydrate,fail}){
 const first=(q,...p)=>db.prepare(q).bind(...p).first();
 const all=async(q,...p)=>(await db.prepare(q).bind(...p).all()).results;
 async function context(){
  const tables=await all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fox_jobs','payunit_invoices')");
  const names=new Set(tables.map(x=>x.name)),pay=names.has('payunit_invoices'),fox=names.has('fox_jobs');
  const job=condition=>fox?`EXISTS (SELECT 1 FROM order_items fi JOIN fox_jobs fj ON fj.item_id=fi.id WHERE fi.order_id=o.id AND fj.is_mock=0 AND (${condition}))`:'0';
  const trial=`(o.payment_status LIKE 'test_%'${pay?" OR EXISTS (SELECT 1 FROM payunit_invoices pi WHERE pi.order_id=o.id AND pi.environment='test')":''})`;
  const waiting="(o.payment_status='paid' AND o.status NOT IN ('completed','cancelled'))";
  const supplier=job("fj.status='failed' OR (fj.error<>'' AND fj.status NOT IN ('completed','refunded','cancelled'))");
  const review=`((o.payment_status='paid' AND o.status='cancelled') OR o.payment_status IN ('refunded','partially_refunded') OR ${job("fj.status IN ('action_required','refunded','cancelled')")})`;
  return {pay,fox,trial,attention:{waiting,supplier,review}};
 }
 const normal=v=>String(v).normalize('NFKC').toLowerCase().replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ـ/g,'');
 const sqlNormal=s=>`replace(replace(replace(replace(replace(replace(lower(coalesce(${s},'')),'أ','ا'),'إ','ا'),'آ','ا'),'ٱ','ا'),'ى','ي'),'ـ','')`;
 function day(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail(400,'التاريخ غير صالح');return v}
 async function enrich(rows,c){
  const orders=await hydrate(rows,true);
  for(const o of orders){
   if(c.pay){const p=await first('SELECT invoice_id,environment,status,payment_reference FROM payunit_invoices WHERE order_id=?',o.id);if(p)o.payment_reference={invoice_id:p.invoice_id,environment:p.environment,status:p.status,reference:p.payment_reference};}
   if(c.fox)o.supplier_jobs=await all('SELECT j.item_id,j.remote_id,j.status,j.error,j.updated_at FROM fox_jobs j JOIN order_items i ON i.id=j.item_id WHERE i.order_id=? AND j.is_mock=0',o.id);
  }
  return orders;
 }
 async function alerts(){
  const c=await context(),counts={};
  for(const [key,condition] of Object.entries(c.attention))counts[key]=(await first(`SELECT count(*) AS n FROM orders o WHERE NOT ${c.trial} AND ${condition}`)).n;
  counts.test=(await first(`SELECT count(*) AS n FROM orders o WHERE ${c.trial}`)).n;
  return {counts,checked_at:new Date().toISOString()};
 }
 async function list(params){
  const c=await context(),conditions=[],values=[];
  let q=(params.get('q')||'').trim();if(q.length>200)fail(400,'البحث طويل؛ استخدم 200 حرف كحد أقصى');
  if(/^https?:\/\//i.test(q)){try{const u=new URL(q);q=u.searchParams.get('order')||q}catch{}}
  q=q.replace(/^#/,'').trim();
  for(const word of normal(q).split(/\s+/).filter(Boolean)){
   const match="LIKE ? ESCAPE '\\'",pattern='%'+word.replace(/[\\%_]/g,'\\$&')+'%';
   const fields=['o.id','u.name','u.email','o.player_id'];
   const parts=fields.map(f=>`${sqlNormal(f)} ${match}`);
   values.push(...fields.map(()=>pattern));
   parts.push(`EXISTS (SELECT 1 FROM order_items si WHERE si.order_id=o.id AND ${sqlNormal('si.name')} ${match})`);values.push(pattern);
   if(c.pay){parts.push(`EXISTS (SELECT 1 FROM payunit_invoices pi WHERE pi.order_id=o.id AND (${sqlNormal('pi.invoice_id')} ${match} OR ${sqlNormal('pi.payment_reference')} ${match}))`);values.push(pattern,pattern);}
   if(c.fox){parts.push(`EXISTS (SELECT 1 FROM order_items si JOIN fox_jobs sj ON sj.item_id=si.id WHERE si.order_id=o.id AND sj.is_mock=0 AND ${sqlNormal('sj.remote_id')} ${match})`);values.push(pattern);}
   conditions.push('('+parts.join(' OR ')+')');
  }
  for(const [param,column,allowed] of [['status','o.status',['contact_pending','awaiting_payment','processing','completed','cancelled']],['payment','o.payment_status',['unpaid','paid','refunded','partially_refunded','test_paid','test_refunded','test_partially_refunded']],['method','o.payment_method',['whatsapp','gateway']]]){
   const v=params.get(param);if(v){if(!allowed.includes(v))fail(400,'فلتر غير صالح');conditions.push(column+'=?');values.push(v);}
  }
  const mode=params.get('mode')||'all';if(!['all','live','test'].includes(mode))fail(400,'فلتر البيئة غير صالح');if(mode!=='all')conditions.push((mode==='live'?'NOT ':'')+c.trial);
  const attention=params.get('attention');if(attention){if(!Object.hasOwn(c.attention,attention))fail(400,'فلتر المتابعة غير صالح');conditions.push('NOT '+c.trial,c.attention[attention]);}
  const from=params.get('from'),to=params.get('to');if(from){conditions.push('o.created_at>=?');values.push(day(from)+'T00:00:00.000Z');}if(to){day(to);conditions.push('o.created_at<?');values.push(new Date(Date.parse(to)+86400000).toISOString());}if(from&&to&&from>to)fail(400,'تاريخ البداية يجب ألا يتجاوز النهاية');
  const page=Number(params.get('page')||1),limit=Number(params.get('limit')||25);if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'رقم الصفحة أو حجمها غير صالح');
  const where=conditions.length?' WHERE '+conditions.join(' AND '):'',join=' FROM orders o JOIN users u ON u.id=o.user_id';
  const total=(await first('SELECT count(*) AS n'+join+where,...values)).n;
  const rows=await all('SELECT o.*,u.name AS customer_name,u.email AS customer_email'+join+where+' ORDER BY o.created_at '+(attention?'ASC':'DESC')+',o.id DESC LIMIT ? OFFSET ?',...values,limit,(page-1)*limit);
  return {orders:await enrich(rows,c),total,page,limit,pages:Math.ceil(total/limit),checked_at:new Date().toISOString()};
 }
 async function detail(id){
  if(!/^[a-f0-9-]{36}$/.test(id))fail(400,'رقم الطلب غير صالح');
  const row=await first('SELECT o.*,u.name AS customer_name,u.email AS customer_email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?',id);if(!row)fail(404,'الطلب غير موجود');
  return {order:(await enrich([row],await context()))[0]};
 }
 return {list,alerts,detail};
}
