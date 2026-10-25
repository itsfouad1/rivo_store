export const policyTitles={privacy:'سياسة الخصوصية',terms:'الشروط والأحكام',refunds:'سياسة الاسترجاع'};
// Draft and published snapshots are independent, stored in the existing settings table.
export function createPolicies({db,fail,log}){
 const first=(q,...p)=>db.prepare(q).bind(...p).first();
 const run=(q,...p)=>db.prepare(q).bind(...p).run();
 function slug(value){if(!Object.hasOwn(policyTitles,value))fail(404,'الصفحة غير موجودة');return value}
 function text(value,max,label){if(typeof value!=='string'||value.trim().length>max)fail(400,'تحقق من '+label+' وطوله');return value.trim()}
 async function read(type){slug(type);const row=await first('SELECT value FROM settings WHERE id=?','policy:'+type);return {raw:row?.value??null,data:row?JSON.parse(row.value):{type,revision:0,draft:{title:policyTitles[type],body:''},published:null}}}
 async function list(admin=false){const pages=[];for(const type of Object.keys(policyTitles)){const {data}=await read(type);if(admin)pages.push(data);else if(data.published)pages.push({type,title:data.published.title,version:data.published.version,published_at:data.published.published_at,url:'/policy.html?type='+type});}return {pages}}
 async function detail(type){const {data}=await read(type);if(!data.published)fail(404,'هذه الصفحة غير منشورة');return {page:{type,...data.published}}}
 async function update(type,input,user){
  slug(type);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'بيانات غير صالحة');
  const {raw,data}=await read(type);
  if(!Number.isSafeInteger(input.revision)||input.revision!==data.revision)fail(409,'تم تعديل الصفحة من نافذة أخرى. حدّثها قبل الحفظ.');
  const action=input.action;if(!['save','publish','unpublish'].includes(action))fail(400,'عملية غير صالحة');
  if(action==='save')data.draft={title:text(input.title,120,'عنوان الصفحة'),body:text(input.body,20000,'نص الصفحة')};
  if(action==='publish'){
   if(!data.draft.title||!data.draft.body)fail(400,'احفظ عنوانًا ونصًا للصفحة قبل نشرها');
   data.published={...data.draft,version:data.revision+1,published_at:new Date().toISOString()};
  }
  if(action==='unpublish')data.published=null;
  data.revision++;data.updated_at=new Date().toISOString();
  const result=raw===null?await run('INSERT INTO settings(id,value) VALUES (?,?) ON CONFLICT(id) DO NOTHING','policy:'+type,JSON.stringify(data)):await run('UPDATE settings SET value=? WHERE id=? AND value=?',JSON.stringify(data),'policy:'+type,raw);
  if(Number(result.meta?.changes??result.changes)!==1)fail(409,'تم تعديل الصفحة بالتزامن؛ حدّثها قبل المحاولة مجددًا.');
  await log(user.id,'policy_'+action,type);return {page:data};
 }
 return {list,detail,update};
}
