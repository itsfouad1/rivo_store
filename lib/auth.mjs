import {pbkdf2,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const derive=promisify(pbkdf2);
const digest=s=>createHash('sha256').update(s).digest('hex');
const token=()=>randomBytes(32).toString('hex');
const cookieName='__Host-rivo_session';
const cookie=(value,age)=>`${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const reply=(body,status=200,c)=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...(c?{'Set-Cookie':c}:{})}});
export async function hashPassword(password){const salt=randomBytes(16).toString('hex');const hash=await derive(password,salt,100000,32,'sha256');return `${salt}:${hash.toString('hex')}`;}
async function verify(password,encoded){const [salt,hex]=encoded.split(':');const actual=await derive(password,salt,100000,32,'sha256');return timingSafeEqual(actual,Buffer.from(hex,'hex'));}
export function authService(db){
 const first=(s,...a)=>db.prepare(s).bind(...a).first();
 const run=(s,...a)=>db.prepare(s).bind(...a).run();
 const sessionToken=req=>(req.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
 async function identity(req){const t=sessionToken(req);if(!/^[a-f0-9]{64}$/.test(t))return null;return await first('SELECT u.id,u.email,u.name,a.role FROM auth_sessions s JOIN auth_accounts a ON a.user_id=s.user_id JOIN users u ON u.id=a.user_id WHERE s.token_hash=? AND s.expires_at>?',digest(t),Date.now());}
 async function limit(key,max){const window=Math.floor(Date.now()/900000);const row=await first('INSERT INTO auth_limits (key,window,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count',digest(key),window);return row.count<=max;}
 async function start(user){const t=token();await run('INSERT INTO auth_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',digest(t),user.id,Date.now()+604800000);return cookie(t,604800);}
 async function handle(req){
  const path=new URL(req.url).pathname;
  if(!path.startsWith('/api/auth/'))return null;
  if(req.method!=='POST')return reply({error:'طريقة غير مسموحة'},405);
  if(req.headers.get('origin')!==new URL(req.url).origin)return reply({error:'مصدر غير مسموح'},403);
  if(path==='/api/auth/logout'){await run('DELETE FROM auth_sessions WHERE token_hash=?',digest(sessionToken(req)));return reply({ok:true},200,cookie('',0));}
  if(!['/api/auth/register','/api/auth/login','/api/auth/recover'].includes(path))return reply({error:'غير موجود'},404);
  // CF-Connecting-IP is set by Cloudflare at 
  // ingress. Never use an arbitrary forwarded IP.
  if(!await limit('ip:'+(req.headers.get('cf-connecting-ip')||'local'),30))return reply({error:'محاولات كثيرة، جرّب بعد 15 دقيقة'},429);
  if(Number(req.headers.get('content-length')||0)>5000)return reply({error:'بيانات كبيرة'},413);
  let b;try{const text=await req.text();if(text.length>5000)return reply({error:'بيانات كبيرة'},413);b=JSON.parse(text)}catch{return reply({error:'بيانات غير صالحة'},400)}
  if(!b||typeof b!=='object'||Array.isArray(b))return reply({error:'بيانات غير صالحة'},400);
  const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';
  const password=b.password;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof password!=='string'||password.length<12||password.length>128)return reply({error:'أدخل إيميلًا صحيحًا وكلمة مرور من 12 إلى 128 حرفًا'},400);
  if(!await limit('email:'+email,10))return reply({error:'محاولات كثيرة، جرّب بعد 15 دقيقة'},429);
  const account=await first('SELECT a.*,u.email,u.name FROM auth_accounts a JOIN users u ON u.id=a.user_id WHERE a.email=?',email);
  if(path==='/api/auth/register'){
   if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100)return reply({error:'أدخل اسمك (حتى 100 حرف)'},400);
   if(account)return reply({error:'تعذّر إنشاء الحساب؛ جرّب الدخول أو استرداد حسابك'},409);
   const id=crypto.randomUUID(),hash=await hashPassword(password),recoveryCode=token();
   try{await db.batch([db.prepare('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)').bind(id,email,b.name.trim(),new Date().toISOString()),db.prepare('INSERT INTO auth_accounts (user_id,email,password_hash,recovery_hash,role) VALUES (?,?,?,?,?)').bind(id,email,hash,digest(recoveryCode),'customer')]);}catch(e){if(String(e.message).includes('UNIQUE'))return reply({error:'تعذّر إنشاء الحساب؛ جرّب الدخول'},409);throw e;}
   return reply({user:{id,email,name:b.name.trim(),role:'customer'},recoveryCode},201,await start({id}));
  }
  if(path==='/api/auth/recover'){
   if(typeof b.recoveryCode!=='string'||!account||digest(b.recoveryCode.trim())!==account.recovery_hash)return reply({error:'بيانات الاسترداد غير صحيحة'},401);
   const recoveryCode=token(),hash=await hashPassword(password);
   const changed=await first('UPDATE auth_accounts SET password_hash=?,recovery_hash=? WHERE user_id=? AND recovery_hash=? RETURNING user_id',hash,digest(recoveryCode),account.user_id,account.recovery_hash);
   if(!changed)return reply({error:'رمز الاسترداد لم يعد صالحًا'},401);
   await run('DELETE FROM auth_sessions WHERE user_id=?',account.user_id);
   return reply({ok:true,recoveryCode},200,cookie('',0));
  }
  // Equal expensive hash work whether or not the email exists.
  const valid=await verify(password,account?.password_hash||'00000000000000000000000000000000:'+ '00'.repeat(32));
  if(!account||!valid)return reply({error:'الإيميل أو كلمة المرور غير صحيحة'},401);
  await run('DELETE FROM auth_sessions WHERE token_hash=?',digest(sessionToken(req)));
  const user={id:account.user_id,email,name:account.name,role:account.role};return reply({user},200,await start(user));
 }
 return {identity,handle};
}
