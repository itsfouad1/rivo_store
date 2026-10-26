export const chatManager=u=>['owner','admin'].includes(u?.role);
export const chatStaff=u=>chatManager(u)||u?.role==='support';
export const eligibleEmployee=`EXISTS(SELECT 1 FROM users tu LEFT JOIN staff_access sa ON sa.user_id=tu.id LEFT JOIN auth_roles ar ON ar.user_id=tu.id WHERE tu.id=? AND ((sa.user_id IS NOT NULL AND sa.active=1 AND sa.role IN ('owner','admin','support')) OR (sa.user_id IS NULL AND ar.role='admin')))`;
const normal=v=>v.normalize('NFKC').toLowerCase().replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ـ/g,'');
const normSql=s=>`replace(replace(replace(replace(replace(replace(lower(coalesce(${s},'')),'أ','ا'),'إ','ا'),'آ','ا'),'ٱ','ا'),'ى','ي'),'ـ','')`;
export function queueFilters(params,user,fail){
 let q=(params.get('q')||'').trim();if(q.length>200)fail(400,'البحث طويل؛ الحد 200 حرف');
 if(/^https?:\/\//i.test(q)){try{const u=new URL(q);q=u.searchParams.get('order')||u.searchParams.get('conversation')||q}catch{}}
 q=q.replace(/^#/,'').trim();const conditions=[],values=[];
 for(const word of normal(q).split(/\s+/).filter(Boolean)){
  const fields=['c.id','c.order_id','c.subject'];
  const parts=fields.map(f=>`instr(${normSql(f)},?)>0`);values.push(...fields.map(()=>word));
  parts.push(`EXISTS (SELECT 1 FROM users su WHERE su.id=c.customer_id AND (instr(${normSql('su.name')},?)>0 OR instr(${normSql('su.email')},?)>0))`);values.push(word,word);conditions.push('('+parts.join(' OR ')+')');
 }
 const priority=params.get('priority');if(priority){if(!['normal','urgent'].includes(priority))fail(400,'أولوية غير صالحة');conditions.push('c.priority=?');values.push(priority);}
 const assigned=params.get('assignee');if(assigned){if(assigned==='mine'){conditions.push('c.assignee=?');values.push(user.id);}else if(assigned==='unassigned')conditions.push('c.assignee IS NULL');else{if(!chatManager(user))fail(403,'تصفية موظف آخر للإدارة فقط');if(assigned.length>200)fail(400,'معرّف الموظف طويل');conditions.push('c.assignee=?');values.push(assigned);}}
 return {sql:conditions.length?' AND '+conditions.join(' AND '):'',values};
}
export function createChatTools({db,fail,json,body,log}){
 const first=(q,...p)=>db.prepare(q).bind(...p).first(),run=(q,...p)=>db.prepare(q).bind(...p).run(),all=async(q,...p)=>(await db.prepare(q).bind(...p).all()).results;
 const text=(v,max)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(400,'تحقق من العنوان والنص وطولهما');return v.trim()};
 async function handle(req,user){const path=new URL(req.url).pathname;
  if(path==='/api/chat/staff'&&req.method==='GET'){
   if(!chatManager(user))fail(403,'اختيار الموظفين للإدارة فقط');
   return json({staff:await all("SELECT u.id,u.name,u.email,CASE WHEN sa.user_id IS NULL THEN ar.role ELSE sa.role END AS role FROM users u LEFT JOIN staff_access sa ON sa.user_id=u.id LEFT JOIN auth_roles ar ON ar.user_id=u.id WHERE ((sa.user_id IS NOT NULL AND sa.active=1 AND sa.role IN ('owner','admin','support')) OR (sa.user_id IS NULL AND ar.role='admin')) ORDER BY u.name,u.id")});
  }
  const match=path.match(/^\/api\/chat\/templates(?:\/([a-f0-9-]{36}))?$/);if(!match)return null;
  if(!chatStaff(user))fail(403,'الردود الجاهزة للفريق فقط');
  if(!match[1]&&req.method==='GET')return json({templates:await all('SELECT id,title,body,active,revision,updated_at FROM chat_templates'+(chatManager(user)?'':' WHERE active=1')+' ORDER BY active DESC,title,id'),can_manage:chatManager(user)});
  if(!chatManager(user))fail(403,'إدارة الردود الجاهزة للإدارة فقط');
  if(!match[1]&&req.method==='POST'){
   const b=await body(req);if(!b||typeof b!=='object')fail(400,'بيانات غير صالحة');const title=text(b.title,120),content=text(b.body,3000),id=crypto.randomUUID(),stamp=new Date().toISOString();
   await run('INSERT INTO chat_templates(id,title,body,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',id,title,content,user.id,user.id,stamp,stamp);await log(user.id,'chat_template_created',id);return json({id},201);
  }
  if(match[1]&&req.method==='PUT'){
   const b=await body(req);if(!b||typeof b!=='object'||!Number.isSafeInteger(b.revision)||typeof b.active!=='boolean')fail(400,'بيانات أو رقم نسخة غير صالح');
   const title=text(b.title,120),content=text(b.body,3000);if(!await first('SELECT id FROM chat_templates WHERE id=?',match[1]))fail(404,'الرد غير موجود');
   const r=await run('UPDATE chat_templates SET title=?,body=?,active=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND revision=?',title,content,b.active?1:0,user.id,new Date().toISOString(),match[1],b.revision);
   if(Number(r.meta?.changes??r.changes)!==1)fail(409,'عُدّل الرد من نافذة أخرى؛ حدّث القائمة');await log(user.id,'chat_template_updated',match[1]);return json({ok:true});
  }
  fail(405,'طريقة غير مسموحة');
 }
 return {handle};
}
