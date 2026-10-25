export const staffPermissions=['products','orders_write','settings','suppliers','policies'];
export const canManage=(u,p)=>u?.role==='owner'||u?.role==='admin'&&(!u.permissions||u.permissions.includes(p));
export const isManager=u=>['owner','admin'].includes(u?.role);
export async function staffIdentity(db,user){
 const row=await db.prepare('SELECT * FROM staff_access WHERE user_id=?').bind(user.id).first();
 if(!row)return user;
 return {...user,role:row.active?row.role:'customer',permissions:row.active?JSON.parse(row.permissions):[]};
}
export function createStaff({db,fail,log}){
 const all=async(q,...p)=>(await db.prepare(q).bind(...p).all()).results;
 async function list(q='') {if(q.length>150)fail(400,'البحث طويل');return {permissions:staffPermissions,users:await all("SELECT u.id,u.name,u.email,coalesce(s.role,a.role,'customer') AS role,coalesce(s.active,1) AS active,s.permissions FROM users u LEFT JOIN auth_roles a ON a.user_id=u.id LEFT JOIN staff_access s ON s.user_id=u.id WHERE instr(lower(u.email||' '||u.name||' '||u.id),lower(?))>0 ORDER BY u.created_at DESC LIMIT 100",q)};}
 async function update(id,b,actor){
  if(id===actor.id)fail(409,'لا يمكنك تغيير صلاحيات حساب المالك الحالي');
  const user=await db.prepare('SELECT id FROM users WHERE id=?').bind(id).first();if(!user)fail(404,'الحساب غير موجود؛ يجب أن يسجّل الموظف حسابه أولًا');
  const current=await db.prepare('SELECT role FROM staff_access WHERE user_id=?').bind(id).first();if(current?.role==='owner')fail(409,'لا يمكن تعديل حساب المالك من هذه الشاشة');
  if(!['admin','support','customer'].includes(b.role)||typeof b.active!=='boolean'||!Array.isArray(b.permissions)||b.permissions.some(p=>!staffPermissions.includes(p)))fail(400,'صلاحيات غير صالحة');
  const permissions=b.role==='admin'?[...new Set(b.permissions)]:[];
  await db.prepare('INSERT INTO staff_access(user_id,role,active,permissions) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,active=excluded.active,permissions=excluded.permissions').bind(id,b.role,b.active?1:0,JSON.stringify(permissions)).run();await log(actor.id,'staff_updated',id);return {ok:true};
 }
 return {list,update};
}
