import {canManage} from './staff.mjs';
import {homeDefaults} from '../public/home-content.js';
import {groupProducts} from '../public/product-groups.js';
const text=(v,max,required=false)=>{if(typeof v!=='string'||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)||(required&&!v.trim()))throw Error('راجع النصوص المطلوبة وطولها');return v.trim()};
export function internalLink(v){v=text(v,1000,true);if(!v.startsWith('/')||v.startsWith('//')||/[\\\s]/.test(v))throw Error('رابط الزر يجب أن يكون داخل المتجر، مثل /products.html');return v;}
export function homeImage(v){v=text(v,1000);if(!v)return '';if(v.startsWith('/assets/')||v.startsWith('/media/')){internalLink(v);if(v.includes('..'))throw Error('رابط صورة غير صالح');return v}let u;try{u=new URL(v)}catch{throw Error('رابط صورة غير صالح')}if(u.protocol!=='https:'||u.username||u.password)throw Error('استخدم رابط صورة HTTPS');return u.href;}
export function validateHome(b){
 if(!b||!Number.isSafeInteger(b.version)||b.version<0||!b.hero||!b.featured||!Array.isArray(b.banners)||b.banners.length>3)throw Error('بيانات الرئيسية غير صالحة');
 const h=b.hero,f=b.featured;
 if(typeof h.enabled!=='boolean'||typeof f.enabled!=='boolean'||!['auto','manual'].includes(f.mode)||!Number.isInteger(f.limit)||f.limit<1||f.limit>12||!Array.isArray(f.product_ids)||f.product_ids.length>12||f.product_ids.some(id=>typeof id!=='string'||!id||id.length>100)||new Set(f.product_ids).size!==f.product_ids.length)throw Error('راجع إعدادات المنتجات المميزة');
 const ids=new Set();
 return {version:b.version,hero:{enabled:h.enabled,title:text(h.title,180),accent:text(h.accent,180),description:text(h.description,600),button:text(h.button,50,true),link:internalLink(h.link)},featured:{enabled:f.enabled,mode:f.mode,title:text(f.title,100,true),description:text(f.description,250),limit:f.limit,product_ids:f.product_ids},banners:b.banners.map(b=>{
  if(!b||typeof b.enabled!=='boolean'||!['purple','cyan'].includes(b.theme)||typeof b.id!=='string'||!/^[a-z0-9-]{1,80}$/.test(b.id)||ids.has(b.id))throw Error('بيانات البنر غير صالحة');ids.add(b.id);
  return {id:b.id,enabled:b.enabled,theme:b.theme,title:text(b.title,100,true),text:text(b.text,300),button:text(b.button,50,true),link:internalLink(b.link),image:homeImage(b.image)};
 })};
}
export function createHomepage(db,identity){
 const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const load=async()=>{const row=await db.prepare('SELECT value FROM settings WHERE id=?').bind('store:homepage').first();return row?JSON.parse(row.value):homeDefaults()};
 const resolve=async home=>{
  if(!home.featured.product_ids.length)return [];
  const rows=(await db.prepare('SELECT * FROM products').all()).results;
  const mapping=await db.prepare('SELECT value FROM settings WHERE id=?').bind('catalog:groups').first();
  const groups=groupProducts(rows,mapping?JSON.parse(mapping.value).groups:[]);
  return home.featured.product_ids.map(reference=>{
   const group=groups.find(g=>g.variants.some(p=>p.id===reference));
   const active=group?.variants.find(p=>p.id===reference&&p.status==='active')||group?.variants.find(p=>p.status==='active');
   return {reference,product_id:active?.id||null};
  });
 };
 return async req=>{
  const url=new URL(req.url);if(!['/api/homepage','/api/admin/homepage'].includes(url.pathname))return null;
  try{
   if(url.pathname==='/api/homepage'){if(req.method!=='GET')return json({error:'طريقة غير مدعومة'},405);const home=await load(),resolved=await resolve(home);return json({...home,featured:{...home.featured,product_ids:[...new Set(resolved.map(r=>r.product_id).filter(Boolean))]},banners:home.banners.filter(b=>b.enabled)})}
   const user=await identity(req);if(!canManage(user,'settings'))return json({error:'تحتاج صلاحية إعدادات المتجر'},403);
   if(req.method==='GET'){const home=await load();return json({...home,resolved:await resolve(home)})}
   if(req.method!=='PUT')return json({error:'طريقة غير مدعومة'},405);
   if(req.headers.get('Origin')!==url.origin)return json({error:'مصدر الطلب غير مسموح'},403);
   const raw=await req.text();if(raw.length>20000)return json({error:'البيانات كبيرة'},413);
   let next;try{next=validateHome(JSON.parse(raw))}catch(e){return json({error:e.message||'بيانات غير صالحة'},400)}
   const current=await load();if(current.version!==next.version)return json({error:'تغيّرت الرئيسية؛ أعد تحميل الإعدادات قبل الحفظ'},409);
   // Preserve previously selected IDs when unpublished; new unknown IDs are rejected.
   const known=new Set((await db.prepare('SELECT id FROM products').all()).results.map(p=>p.id));
   if(next.featured.product_ids.some(id=>!known.has(id)&&!current.featured.product_ids.includes(id)))return json({error:'أحد المنتجات المحددة غير موجود'},400);
   const prior=next.version;next.version++;
   const r=await db.prepare("INSERT INTO settings(id,value) VALUES ('store:homepage',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE json_extract(settings.value,'$.version')=?").bind(JSON.stringify(next),prior).run();
   if((r.meta?.changes??r.changes)!==1)return json({error:'تغيّرت الرئيسية؛ أعد تحميل الإعدادات'},409);
   return json({...next,resolved:await resolve(next)});
  }catch{return json({error:'تعذّر تحميل أو حفظ الرئيسية'},500)}
 };
}
