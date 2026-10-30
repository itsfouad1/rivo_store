import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,statSync,createReadStream,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'),bin=join(base,'node_modules','wrangler','bin','wrangler.js');
if(!existsSync(bin)){console.error('شغّل npm install داخل المشروع أولًا.');process.exit(1);}
const folder=join(base,'backups');mkdirSync(folder,{recursive:true});
const target=join(folder,'rivo-db-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sql');
console.log('سيتم تصدير D1 من حساب Cloudflare المسجّل حاليًا. النسخة قد تحتوي بيانات زبائن؛ احتفظ بها بشكل خاص.');
const result=spawnSync(process.execPath,[bin,'d1','export','DB','--remote','--output',target],{cwd:base,stdio:'inherit'});
if(result.status!==0){console.error('فشل التصدير. لم يتم تأكيد صلاحية النسخة.');process.exit(result.status||1);}
if(!existsSync(target)||statSync(target).size===0){console.error('ملف النسخة غير موجود أو فارغ.');process.exit(1);}
const digest=createHash('sha256');for await(const chunk of createReadStream(target))digest.update(chunk);
writeFileSync(target+'.sha256',digest.digest('hex')+'\n');
console.log('تم حفظ تصدير D1 وبصمته: '+target+'\nهذا ليس اختبار استعادة، ولا يشمل صور R2 أو حسابات Supabase.');
