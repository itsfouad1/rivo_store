import {canManage} from './staff.mjs';
const stamp=()=>new Date().toISOString();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createOrderEmail(env,identity=async()=>null,fetcher=fetch){
 const db=env.DB,first=(q,...v)=>db.prepare(q).bind(...v).first(),run=(q,...v)=>db.prepare(q).bind(...v).run(),all=async(q,...v)=>(await db.prepare(q).bind(...v).all()).results;
 const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const configuration=async()=>{
  const row=await first("SELECT value FROM settings WHERE id='commerce:email'");const enabled=!!JSON.parse(row?.value||'{}').enabled;let origin='';try{const u=new URL(env.PUBLIC_SITE_URL);if(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash)origin=u.origin}catch{}
  const from=String(env.EMAIL_FROM||''),validFrom=/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from);return {enabled,ready:enabled&&env.EMAIL_ENABLED==='true'&&!!env.RESEND_API_KEY&&validFrom&&!!origin,origin,from,validFrom};
 };
 async function handle(req){
  const url=new URL(req.url),admin=url.pathname==='/api/admin/email',customer=url.pathname==='/api/customer/email',confirm=url.pathname==='/api/customer/email/confirm';if(!admin&&!customer&&!confirm)return null;
  try{
   const u=await identity(req);if(!u)return json({error:'سجّل الدخول أولًا'},401);if(admin&&!canManage(u,'settings'))return json({error:'تحتاج صلاحية إعدادات المتجر'},403);
   if(req.method!=='GET'&&req.headers.get('Origin')!==url.origin)return json({error:'مصدر غير مسموح'},403);
   const cfg=await configuration();
   if(admin&&req.method==='GET')return json({enabled:cfg.enabled,ready:cfg.ready,requirements:{flag:env.EMAIL_ENABLED==='true',key:!!env.RESEND_API_KEY,from:cfg.validFrom,site:!!cfg.origin},queue:await all('SELECT status,count(*) AS count FROM email_outbox GROUP BY status'),recent:await all('SELECT id,kind,status,attempts,error,created_at FROM email_outbox ORDER BY created_at DESC LIMIT 30')});
   const pref=await first('SELECT * FROM customer_email_preferences WHERE user_id=?',u.id),owner=await first('SELECT email FROM users WHERE id=?',u.id);
   if(customer&&req.method==='GET')return json({ready:cfg.ready,enabled:!!pref?.enabled&&pref.email===owner?.email,confirmed:!!pref?.confirmed_at&&pref.email===owner?.email,email:owner?.email});
   if(!['POST','PUT'].includes(req.method))return json({error:'طريقة غير مدعومة'},405);
   const text=await req.text();if(text.length>3000)return json({error:'البيانات كبيرة'},413);let b;try{b=JSON.parse(text)}catch{return json({error:'بيانات غير صالحة'},400)}
   if(admin&&req.method==='PUT'){if(typeof b.enabled!=='boolean')return json({error:'حالة غير صالحة'},400);await run("UPDATE settings SET value=? WHERE id='commerce:email'",JSON.stringify({enabled:b.enabled}));return json({ok:true});}
   if(customer&&b.action==='disable'){await run('UPDATE customer_email_preferences SET enabled=0,token_hash=NULL WHERE user_id=?',u.id);return json({ok:true});}
   if(confirm){if(typeof b.token!=='string'||!/^[a-f0-9]{64}$/.test(b.token))return json({error:'رابط غير صالح'},400);const r=await run('UPDATE customer_email_preferences SET enabled=1,confirmed_at=?,token_hash=NULL,token_expires=NULL WHERE user_id=? AND email=? AND token_hash=? AND token_expires>?',stamp(),u.id,owner.email,await hash(b.token),stamp());return (r.meta?.changes??r.changes)===1?json({ok:true}):json({error:'الرابط انتهى أو استُخدم؛ اطلب رابطًا جديدًا'},409);}
   if(!customer||b.action!=='verify')return json({error:'عملية غير صالحة'},400);
   if(!cfg.ready)return json({error:'إرسال الإيميل غير مهيأ بعد'},409);
   if(pref?.requested_at&&Date.now()-Date.parse(pref.requested_at)<3600000)return json({error:'انتظر ساعة قبل طلب رسالة تأكيد جديدة'},429);
   const email=owner?.email;if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||''))return json({error:'بريد الحساب غير صالح'},400);
   const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),id=crypto.randomUUID(),time=stamp();
   await db.batch([
    db.prepare("UPDATE email_outbox SET status='cancelled' WHERE user_id=? AND kind='confirmation' AND status IN ('pending','review')").bind(u.id),
    db.prepare('INSERT INTO customer_email_preferences(user_id,email,enabled,token_hash,token_expires,requested_at) VALUES (?,?,0,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,enabled=0,confirmed_at=NULL,token_hash=excluded.token_hash,token_expires=excluded.token_expires,requested_at=excluded.requested_at WHERE customer_email_preferences.requested_at IS NULL OR customer_email_preferences.requested_at<?').bind(u.id,email,await hash(token),new Date(Date.now()+86400000).toISOString(),time,new Date(Date.now()-3600000).toISOString()),
    db.prepare("INSERT INTO email_outbox(id,user_id,kind,recipient,subject,link_path,next_attempt_at,created_at) SELECT ?,?,'confirmation',?,'تأكيد إشعارات ريفو',?,?,? WHERE EXISTS(SELECT 1 FROM customer_email_preferences WHERE user_id=? AND token_hash=?)").bind(id,u.id,email,'/account?email_token='+token,time,time,u.id,await hash(token))
   ]);return json({ok:true,message:'سيصلك رابط تأكيد عند معالجة البريد. افتحه وأنت داخل حسابك.'});
  }catch{return json({error:'تعذّر تنفيذ إعدادات البريد'},500)}
 }
 async function drain(){
  const cfg=await configuration();if(!cfg.ready)return {configured:false};
  const time=stamp();await run("UPDATE email_outbox SET status='pending' WHERE status='sending' AND lock_until<?",time);
  const rows=await all("SELECT * FROM email_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 5",time);let accepted=0;
  for(const row of rows){
   if(row.first_attempt_at&&Date.now()-Date.parse(row.first_attempt_at)>20*3600000){await run("UPDATE email_outbox SET status='review',error='انتهت نافذة إعادة المحاولة الآمنة' WHERE id=? AND status='pending'",row.id);continue;}
   const user=await first('SELECT email FROM users WHERE id=?',row.user_id),pref=await first('SELECT * FROM customer_email_preferences WHERE user_id=?',row.user_id);
   if(user?.email!==row.recipient||(row.kind==='order'&&(!pref?.enabled||!pref.confirmed_at||pref.email!==row.recipient))||(row.kind==='confirmation'&&(!pref?.token_hash||pref.token_expires<time))){await run("UPDATE email_outbox SET status='cancelled' WHERE id=?",row.id);continue;}
   const claim=await run("UPDATE email_outbox SET status='sending',lock_until=?,first_attempt_at=coalesce(first_attempt_at,?),attempts=attempts+1 WHERE id=? AND status='pending'",new Date(Date.now()+60000).toISOString(),time,row.id);if((claim.meta?.changes??claim.changes)!==1)continue;
   const budget=await first('INSERT INTO email_budget(day,attempts) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<100 RETURNING attempts',time.slice(0,10));if(!budget){await run("UPDATE email_outbox SET status='pending',next_attempt_at=?,attempts=attempts-1 WHERE id=?",new Date(Date.now()+3600000).toISOString(),row.id);break;}
   let payload=row.payload_json;const link=cfg.origin+row.link_path;
   if(!payload){payload=JSON.stringify({from:cfg.from,to:[row.recipient],subject:'RIVO | '+row.subject,text:(row.kind==='confirmation'?'أكد رغبتك باستلام إشعارات الطلبات من ريفو.':'يوجد تحديث على طلبك. تفاصيل الطلب والتسليم داخل حسابك فقط.')+'\n'+link,html:`<div dir="rtl" style="font-family:Arial;background:#0c1020;color:#fff;padding:28px"><h1 style="color:#55e0df">RIVO | ريفو</h1><h2>${esc(row.subject)}</h2><p>${row.kind==='confirmation'?'أكد رغبتك باستلام إشعارات الطلبات.':'يوجد تحديث على طلبك؛ راجع التفاصيل داخل حسابك.'}</p><a style="color:#b99cff" href="${esc(link)}">${row.kind==='confirmation'?'تأكيد الإشعارات':'افتح طلبك'} ←</a><p>يمكن إيقاف إشعارات البريد من صفحة حسابك.</p></div>`});await run('UPDATE email_outbox SET payload_json=? WHERE id=?',payload,row.id);}
   try{
    const res=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'rivo-'+row.id},body:payload,signal:AbortSignal.timeout(8000)});
    if(!res.ok){const retry=res.status===429||res.status>=500;await run('UPDATE email_outbox SET status=?,error=?,next_attempt_at=? WHERE id=?',retry&&row.attempts<4?'pending':'review','HTTP '+res.status,new Date(Date.now()+900000).toISOString(),row.id);continue;}
    const d=await res.json();if(typeof d.id!=='string')throw Error('Invalid provider response');await run("UPDATE email_outbox SET status='accepted',provider_id=?,error='' WHERE id=?",d.id,row.id);accepted++;
   }catch{await run('UPDATE email_outbox SET status=?,error=?,next_attempt_at=? WHERE id=?',row.attempts<4?'pending':'review','تعذّر تأكيد استجابة مزوّد البريد',new Date(Date.now()+900000).toISOString(),row.id);}
  }
  return {configured:true,accepted};
 }
 return {handle,drain};
}
