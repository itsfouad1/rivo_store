const normal=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').trim();
const intents=['start','search','product','orders','order','payment','region','refunds','policies','human','thanks','activation','clarify'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const aliases=[[/ببجي|بوبجي/g,'pubg'],[/فري\s*فاير/g,'free fire'],[/بلاي\s*ستيشن|بليستيشن/g,'playstation'],[/ستيم/g,'steam'],[/روبلوكس/g,'roblox'],[/فورت\s*نايت/g,'fortnite'],[/فالورانت/g,'valorant'],[/اكس\s*بوكس/g,'xbox']];
function searchText(q){for(const [pattern,name] of aliases)q=q.replace(pattern,name);return q;}
function localIntent(q,ctx){
 if(/موظف|اداره|انسان|بشري|human|agent/.test(q))return 'human';
 if(/استرجاع|استرداد|refund/.test(q))return 'refunds';
 if(/طلبي|طلباتي|طلب رقم|حاله الطلب|order status|دفعت|دافع|انخصم|خصموا|ما وصل|ماوصل|لم يصل/.test(q)||uuid.test(q))return 'orders';
 if(/ما اشتغل|مش شغال|لا يعمل|ما زبط|افعل|افعله|استخدمها|استخدمه|تفعيل|redeem|not working/.test(q))return ctx.product_id?'product':'activation';
 if(/دفع|pay|واتساب|وسيله/.test(q))return 'payment';
 if(/منطقه|دوله|ريجن|region|بلدي/.test(q))return 'region';
 if(/خصوصيه|شروط|سياس/.test(q))return 'policies';
 if(ctx.product_id&&/^(بكم|بكم سعره|كم سعرها|كم سعره|قديش سعرها|سعرها|سعره)[؟?\s]*$/.test(q))return 'product';
 if(ctx.order_id&&/^(و?هلقيت|و?هلا|شو صار|وين وصل|وحالته)[؟?\s]*$/.test(q))return 'orders';
 if(ctx.product_id&&/^(وتعليماته|كيف استخدمها|كيف استخدمه|كيف افعلها|كيف افعله)[؟?\s]*$/.test(q))return 'product';
 if(/^(مرحبا|مرحبتين|اهلا|اهلا وسهلا|اهلين|هلا|السلام عليكم(?: ورحمه الله(?: وبركاته)?)?|سلام|هاي|hello|hi|hey|صباح الخير|مساء الخير|كيفك|شو اخبارك)(\s+(ريفو|rivo|فيك))*[.!؟?👋\s]*$/.test(q)||/^(مين انت|من انت|شو بتعمل|كيف بتساعدني|مساعده|help)[؟?!.\s]*$/.test(q))return 'start';
 if(/^(شكرا|شكرا الك|شكرا لك|يسلمو|يسلموا|مشكور|thanks|thank you|تمام شكرا|مع السلامه)(\s+(ريفو|rivo))*[.!؟?\s]*$/.test(q))return 'thanks';
 if(/\b(steam|pubg|playstation|roblox|fortnite|valorant|xbox)\b|free fire/.test(searchText(q)))return 'search';
 return '';
}
function readContext(value,fail){
 if(value===undefined||value===null)return {};
 if(typeof value!=='object'||Array.isArray(value))fail(400,'سياق المحادثة غير صالح');
 const ctx={};
 if(value.intent!==undefined){if(!intents.includes(value.intent))fail(400,'سياق المحادثة غير صالح');ctx.intent=value.intent;}
 if(value.query!==undefined){if(typeof value.query!=='string'||value.query.length>80)fail(400,'سياق المحادثة غير صالح');ctx.query=value.query;}
 for(const k of ['product_id','order_id'])if(value[k]!==undefined){if(typeof value[k]!=='string'||!uuid.test(value[k]))fail(400,'سياق المحادثة غير صالح');ctx[k]=value[k];}
 if(value.misses!==undefined){if(!Number.isInteger(value.misses)||value.misses<0||value.misses>2)fail(400,'سياق المحادثة غير صالح');ctx.misses=value.misses;}
 return ctx;
}
const statuses={contact_pending:'بانتظار التواصل',awaiting_payment:'بانتظار الدفع',processing:'قيد التنفيذ',completed:'مكتمل',cancelled:'ملغي'};
const payments={unpaid:'لم يُؤكد الدفع',paid:'مدفوع',test_paid:'دفع تجريبي ناجح',refunded:'مسترجع',partially_refunded:'استرجاع جزئي',test_refunded:'استرجاع تجريبي',test_partially_refunded:'استرجاع جزئي تجريبي'};
export function createAssistant({db,fail,products,settings,policies,paymentAvailable,language}){
 const first=(q,...p)=>db.prepare(q).bind(...p).first(),all=async(q,...p)=>(await db.prepare(q).bind(...p).all()).results;
 async function answer(req,user,b){
  if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'بيانات غير صالحة');
  if(b.question!==undefined&&(typeof b.question!=='string'||b.question.length>500))fail(400,'السؤال يجب ألا يتجاوز 500 حرف');
  const raw=b.question||'',q=normal(raw),currency=b.currency||'ILS';if(!['USD','ILS','JOD','EGP','SAR','AED','TRY'].includes(currency))fail(400,'عملة غير مدعومة');
  const actor=user?.id||req.headers.get('CF-Connecting-IP')||'visitor';const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(actor));const key='assistant:'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  const rate=await first('INSERT INTO chat_limits(actor,window,hits) VALUES (?,?,1) ON CONFLICT(actor) DO UPDATE SET hits=CASE WHEN window=excluded.window THEN hits+1 ELSE 1 END,window=excluded.window RETURNING hits',key,Math.floor(Date.now()/60000));if(rate.hits>20)fail(429,'أسئلة كثيرة؛ انتظر دقيقة أو انتقل للدعم البشري');
  const ctx=readContext(b.context,fail);let intent=b.intent||'',query=searchText(q),aiUsed=false;
  if(intent&&!intents.includes(intent))fail(400,'طلب غير صالح');
  if(!intent){intent=q?localIntent(q,ctx):'start';if(!intent){const route=await language?.route(raw,ctx,key);if(route){intent=route.intent;query=searchText(normal(route.query||raw));aiUsed=true;}else intent='search';}}
  const context={intent,query:'',misses:0};
  const result={mode:aiUsed?'assisted':'guided',ai_used:aiUsed,reply:'',products:[],orders:[],links:[],offer_handoff:true,intent,context,suggestions:[]};
  const suggest=()=>{result.suggestions=[{label:'أبحث عن منتج',intent:'search'},{label:'أتابع طلبي',intent:'orders'},{label:'أتواصل مع موظف',intent:'human'}];};
  function clarify(){context.intent='clarify';result.intent='clarify';context.misses=Math.min(2,(ctx.misses||0)+1);result.reply=context.misses>1?'لسه مش واضح إلي شو بتحتاج. اختار أحد الخيارات، أو خلّينا نوصل رسالتك لفريق الدعم.':'ممكن توضّحلي شو بتحتاج؟ بدك منتج معيّن، مساعدة بطلب، ولا مشكلة بتفعيل بطاقة؟';if(context.misses>1)result.handoff=true;suggest();return result;}
  if(intent==='human'){result.reply='تقدر تنتقل لموظف من زر «التحدث مع موظف». رح تراجع الرسالة قبل إرسالها، وقد يبقى طلبك بانتظار توفر الفريق.';result.handoff=true;return result;}
  if(intent==='start'){context.query='';result.reply='أهلًا فيك 👋 أنا ريفو، مساعدك الآلي بالمتجر. بساعدك تلاقي الباقة المناسبة وتتابع طلبك، وإذا احتجت موظف بوصلك للفريق. شو بتحتاج اليوم؟';suggest();return result;}
  if(intent==='thanks'){context.query='';result.reply='على راسي 💜 إذا احتجت مساعدة ثانية، أنا هون.';suggest();return result;}
  if(intent==='clarify')return clarify();
  if(intent==='activation'){result.reply='شو اسم اللعبة أو البطاقة؟ واحكيلي رسالة الخطأ ومنطقة حسابك، بدون ما تبعت الكود كامل أو كلمة المرور. إذا المنتج ضمن طلب سابق، اختار «أتابع طلبي» لنحدده.';result.suggestions=[{label:'أتابع طلبي',intent:'orders'},{label:'مساعدة من موظف',intent:'human'}];return result;}
  if(intent==='orders'||intent==='order'){
   if(!user){result.reply='حالة الطلب معلومات خاصة. سجّل الدخول بحساب صاحب الطلب، ثم اسألني مرة ثانية.';result.links=[{title:'تسجيل الدخول',url:'/login'}];return result;}
   if(user.role!=='customer')fail(403,'متابعة الطلبات هنا مخصصة لحساب الزبون');
   let id=b.order_id;
   if(!id){const match=raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);id=match?.[0];}
   if(!id&&ctx.order_id&&/^(و?هلقيت|و?هلا|شو صار|وين وصل|وحالته|حاله الطلب)[؟?\s]*$/.test(q))id=ctx.order_id;
   if(id){if(typeof id!=='string'||!uuid.test(id))fail(400,'رقم الطلب غير صالح');const o=await first('SELECT id,status,payment_status,customer_update,created_at FROM orders WHERE id=? AND user_id=?',id,user.id);if(!o){result.reply='لم أجد الطلب ضمن حسابك. تأكد أنك داخل حساب صاحب الطلب، أو تواصل مع الدعم.';return result;}context.order_id=o.id;result.orders=[await orderView(o)];result.reply='هذه الحالة المحفوظة الآن في المتجر. إذا دفعت ولم يتأكد الدفع، لا تكرر الدفع؛ افتح تفاصيل الطلب لمراجعة الحالة أو تواصل مع الفريق.';return result;}
   const rows=await all('SELECT id,status,payment_status,customer_update,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 5',user.id);for(const o of rows)result.orders.push(await orderView(o));result.reply=rows.length?'هذه آخر خمسة طلبات كحد أقصى من حسابك. اختر طلبًا لعرض حالته.':'لا توجد طلبات في حسابك بعد.';result.links=[{title:'كل طلباتي',url:'/account'}];return result;
  }
  if(intent==='payment'){
   const config=await settings();result.reply=[config.whatsapp?'الطلب عبر واتساب متاح للمنتجات التي تدعمه. فتح المحادثة وحده لا يؤكد الدفع.':'رقم واتساب الطلبات غير مهيأ حاليًا.',paymentAvailable(user)?'Payunit متاح للمنتجات التي تدعمه، والتحصيل بالدولار بعد مراجعة المبلغ.':'بوابة الدفع غير متاحة لهذا الحساب حاليًا.','الطرق المتاحة قد تختلف حسب المنتج؛ راجع تفاصيله. المساعد لا يؤكد الدفع من الرسائل أو الصور.'].join('\n');return result;
  }
  if(intent==='region'){result.reply='عملة العرض لا تحدد منطقة تفعيل البطاقة. راجع المنطقة المكتوبة للمنتج وقارنها بمنطقة حسابك في اللعبة أو المنصة. لا تفترض أن تغيير العملة يغيّر صلاحية البطاقة. إذا لم تكن متأكدًا، اسأل موظفًا قبل الشراء.';result.links=[{title:'عرض المنتجات والمناطق',url:'/#catalog'}];return result;}
  if(intent==='policies'||intent==='refunds'){
   const pages=(await policies.list()).pages.filter(p=>intent!=='refunds'||p.type==='refunds');
   result.reply=pages.length?'اقرأ النص المنشور والمعتمد في هذه الصفحات. المساعد لا يوافق على استرجاع أو تعويض؛ الطلبات الخاصة يحوّلها للفريق.':'لا توجد سياسة منشورة لهذا الموضوع بعد. تواصل مع الفريق لتوضيح الشروط، ولن أفترض شروطًا أو مهلة استرجاع.';
   result.links=pages.map(p=>({title:p.title,url:p.url}));return result;
  }
  const catalog=await products(currency);
  function safeProduct(p,detail=false){const wa=!!p.payment_mode&&['whatsapp','both'].includes(p.payment_mode);const pay=paymentAvailable(user)&&['gateway','both'].includes(p.payment_mode);return {id:p.id,name:p.name,price_cents:p.price_cents,currency:p.currency,region:p.region||'غير محددة — اسأل قبل الشراء',available:p.available!==false&&(wa&&!!config.whatsapp||pay),delivery_estimate:p.delivery_estimate||'',url:'/?product='+encodeURIComponent(p.id),...(detail?{description:p.description||'',activation_instructions:p.activation_instructions||'',purchase_notice:p.purchase_notice||''}:{})};}
  const config=await settings();
  if(intent==='product'){
   const p=catalog.find(p=>p.id===(b.product_id||ctx.product_id));if(!p){result.reply='المنتج لم يعد منشورًا أو متاحًا للعرض. جرّب البحث مرة ثانية.';return result;}context.product_id=p.id;result.products=[safeProduct(p,true)];result.reply='هاي تفاصيل المنتج وتعليماته المسجلة بالمتجر. إذا المشكلة مستمرة أو التعليمات ناقصة، فريق الدعم بيساعدك بدون ما تحتاج تبعت كلمة مرورك أو الكود كامل.';return result;
  }
  const ignored=new Set(['بدي','ابحث','عن','عندكم','عندك','عندكو','في','هل','ممكن','اريد','منتج','بطاقه','بطاقة','شحن','اشحن','كيف','افعل','تفعيل','طريقة','طريقه','مرحبا','اهلا','لو','سمحت','لعبه','لعبة','كرت','كروت','باقة','باقه']);const words=query.replace(/[؟?!،,.]/g,' ').split(/\s+/).filter(w=>w&&!ignored.has(w));
  if(!words.length){result.reply='اكتب اسم اللعبة أو المنصة، مثل Steam أو PUBG، حتى أبحث في المنتجات المنشورة.';return result;}
  const matches=catalog.filter(p=>{const content=searchText(normal([p.name,p.category,p.description,p.region].join(' ')));return words.every(w=>content.includes(w));});
  if(matches.length)context.query=words.join(' ').slice(0,80);
  if(!matches.length&&!b.intent&&!aiUsed&&!/steam|pubg|free fire|playstation|roblox|fortnite|valorant|xbox|بحث|اشحن|بطاق|كرت|باقة|باقه/.test(query))return clarify();
  result.products=matches.slice(0,5).map(p=>safeProduct(p));result.reply=matches.length?`لقيت ${matches.length} منتجًا، بعرضلك أول خمس نتائج كحد أقصى. اختار المنتج عشان تشوف تعليماته ومنطقة تفعيله. الأسعار بعملة ${currency}.`:'ما لقيت منتجًا منشورًا بهذا الاسم. جرّب اسم اللعبة أو المنصة بدون تفاصيل إضافية، أو اسأل فريق الدعم عن توفّره.';if(matches.length===1)context.product_id=matches[0].id;if(!matches.length){result.suggestions=[{label:'اسأل موظف عن المنتج',intent:'human'},{label:'أبحث من جديد',intent:'search'}];}return result;
 }
 async function orderView(o){return {id:o.id,status:statuses[o.status]||'قيد المتابعة',payment:payments[o.payment_status]||'تحتاج مراجعة',update:o.customer_update,url:'/order.html?order='+o.id};}
 return {answer};
}
