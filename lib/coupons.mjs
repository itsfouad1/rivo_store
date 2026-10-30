import {convertCents} from './exchange.mjs';
export class CouponError extends Error{constructor(message,status=409){super(message);this.status=status}}
export function couponCode(value){const s=String(value||'').trim().toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(s))throw new CouponError('كود الخصم غير صالح',400);return s}
export async function priceCoupon(db,{code,userId,items,currency,rates,at=new Date().toISOString()}){
 const c=await db.prepare('SELECT * FROM store_coupons WHERE code=?').bind(couponCode(code)).first();
 if(!c||!c.enabled||c.starts_at>at||c.expires_at<=at)throw new CouponError('الكوبون غير متاح أو انتهت صلاحيته');
 const used=await db.prepare('SELECT count(*) AS n FROM coupon_redemptions WHERE code=?').bind(c.code).first();
 if(used.n>=c.max_uses||await db.prepare('SELECT order_id FROM coupon_redemptions WHERE code=? AND user_id=?').bind(c.code,userId).first())throw new CouponError('تم استخدام الكوبون أو انتهى عدد استخداماته');
 const allowed=JSON.parse(c.product_ids),subtotal=items.reduce((s,p)=>s+p.unit_cents*p.quantity,0);
 if(convertCents(subtotal,currency,'USD',rates)<c.min_usd_cents)throw new CouponError('قيمة السلة أقل من الحد الأدنى للكوبون');
 let total=0,discount=0;const priced=[];
 for(const p of items){
  if(allowed.length&&!allowed.includes(p.id)){priced.push({...p});total+=p.unit_cents*p.quantity;continue}
  const net=Math.ceil(p.unit_cents*(10000-c.percent_bps)/10000),usd=convertCents(net,currency,'USD',rates);
  const f=p.fox??await db.prepare('SELECT * FROM fox_products WHERE product_id=?').bind(p.id).first();
  const manual=await db.prepare('SELECT floor_usd_cents FROM coupon_price_floors WHERE product_id=?').bind(p.id).first();
  let floor=manual?.floor_usd_cents??0;
  if(f){if(!Number.isSafeInteger(f.cost_units)||f.cost_units<=0||!Number.isFinite(Date.parse(f.checked_at))||Date.now()-Date.parse(f.checked_at)>86400000||Date.parse(f.checked_at)>Date.now()+300000)throw new CouponError('تكلفة أحد المنتجات تحتاج تحديثًا قبل استخدام الخصم');floor=Math.max(floor,Number((BigInt(f.cost_units)*BigInt(10000+c.min_margin_bps)+999999n)/1000000n));}
  if(!floor)throw new CouponError('هذا المنتج غير مجهز للخصومات بعد؛ تواصل مع المتجر');
  if(usd<floor||net<=0)throw new CouponError('الخصم لا يناسب الحد الأدنى لتسعير أحد المنتجات');
  discount+=(p.unit_cents-net)*p.quantity;total+=net*p.quantity;
  priced.push({...p,unit_cents:net,sale_usd_cents:usd});
 }
 if(!discount)throw new CouponError('الكوبون لا ينطبق على هذه السلة');
 return {code:c.code,version:c.version,subtotal,discount,total,currency,items:priced};
}
