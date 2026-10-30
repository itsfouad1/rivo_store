import {canManage} from './staff.mjs';
export function createCollections(db, identity) {
  const json = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  const load = async () => {
    const row = await db.prepare('SELECT value FROM settings WHERE id=?').bind('catalog:groups').first();
    return row ? JSON.parse(row.value) : {version:0,groups:[]};
  };
  return async req => {
    const url=new URL(req.url), path=url.pathname;
    if (!['/api/collections','/api/admin/collections'].includes(path)) return null;
    try {
      if (path==='/api/collections' && req.method==='GET') {
        const saved=await load();
        const rows=(await db.prepare("SELECT id FROM products WHERE status='active'").all()).results;
        const active=new Set(rows.map(p=>p.id));
        return json({groups:saved.groups.map(g=>({...g,product_ids:g.product_ids.filter(id=>active.has(id))})).filter(g=>g.product_ids.length)});
      }
      const user=await identity(req);
      if (!user || !canManage(user,'products')) return json({error:'ليس لديك صلاحية إدارة المنتجات'},403);
      if (path!=='/api/admin/collections') return json({error:'طريقة غير مدعومة'},405);
      if (req.method==='GET') return json(await load());
      if (req.method!=='PUT') return json({error:'طريقة غير مدعومة'},405);
      if (req.headers.get('Origin')!==url.origin) return json({error:'مصدر الطلب غير مسموح'},403);
      const raw=await req.text();if(raw.length>100000)return json({error:'البيانات كبيرة'},413);
      let b;try{b=JSON.parse(raw)}catch{return json({error:'بيانات غير صالحة'},400)}
      if (!Number.isSafeInteger(b.version)||!Array.isArray(b.groups)||b.groups.length>100) return json({error:'بيانات المجموعات غير صالحة'},400);
      const ids=new Set(), productIds=new Set(), groups=[];
      for (const g of b.groups) {
        if (!g || typeof g.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(g.id)||ids.has(g.id)||typeof g.title!=='string'||!g.title.trim()||g.title.trim().length>100||/[\x00-\x1f]/.test(g.title)||!['topup','cards','subscriptions','other'].includes(g.kind)||!Array.isArray(g.product_ids)||!g.product_ids.length||g.product_ids.length>500) return json({error:'راجع اسم المجموعة ورابطها ونوعها ومنتجاتها'},400);
        ids.add(g.id);
        for (const id of g.product_ids) {
          if(typeof id!=='string'||id.length>100||!id||productIds.has(id))return json({error:'المنتج لا يمكن أن يتكرر أو ينتمي لمجموعتين يدويتين'},400);
          productIds.add(id);
        }
        groups.push({id:g.id,title:g.title.trim(),kind:g.kind,product_ids:g.product_ids});
      }
      const rows=(await db.prepare('SELECT id FROM products').all()).results;
      const known=new Set(rows.map(p=>p.id));
      if([...productIds].some(id=>!known.has(id)))return json({error:'أحد المنتجات لم يعد موجودًا؛ حدّث الصفحة'},409);
      const current=await load();if(current.version!==b.version)return json({error:'تغيّرت المجموعات؛ حدّث الصفحة قبل الحفظ'},409);
      const next={version:b.version+1,groups};
      const result=await db.prepare("INSERT INTO settings(id,value) VALUES ('catalog:groups',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE json_extract(settings.value,'$.version')=?").bind(JSON.stringify(next),b.version).run();
      if((result.meta?.changes??result.changes)!==1)return json({error:'تغيّرت المجموعات؛ حدّث الصفحة'},409);
      return json(next);
    } catch { return json({error:'تعذّر تحميل أو حفظ مجموعات المنتجات'},500); }
  };
}
