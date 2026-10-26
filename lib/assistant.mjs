const normal=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').trim();
const statuses={contact_pending:'بانتظار التواصل',awaiting_payment:'بانتظار الدفع',processing:'قيد التنفيذ',completed:'مكتمل',cancelled:'ملغي'};
const payments={unpaid:'لم يُؤكد الدفع',paid:'مدفوع',test_paid:'دفع تجريبي ناجح',refunded:'مسترجع',partially_refunded:'استرجاع جزئي',test_refunded:'استرجاع تجريبي',test_partially_refunded:'استرجاع جزئي تجريبي'};
export function createAssistant({db,fail,products,settings,policies,paymentAvailable}){
 const first=(q,...p)=>db.prepare(q).bind(...p).first(),all=async(q,...p)=>(await db.prepare(q).bind(...p).all()).results;
 async function answer(req,user,b){
  if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'بيانات غير صالحة');
  if(b.question!==undefined&&(typeof b.question!=='string'||b.question.length>500))fail(400,'السؤال يجب ألا يتجاوز 500 حرف');
  const raw=b.question||'',q=normal(raw),currency=b.currency||'ILS';if(!['USD','ILS','JOD','EGP','SAR','AED','TRY'].includes(currency))fail(400,'عملة غير مدعومة');
  const actor=user?.id||req.headers.get('CF-Connecting-IP')||'visitor';const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(actor));const key='assistant:'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  const rate=await first('INSERT INTO chat_limits(actor,window,hits) VALUES (?,?,1) ON CONFLICT(actor) DO UPDATE SET hits=CASE WHEN window=excluded.window THEN hits+1 ELSE 1 END,window=excluded.window RETURNING hits',key,Math.floor(Date.now()/60000));if(rate.hits>20)fail(429,'أسئلة كثيرة؛ انتظر دقيقة أو انتقل للدعم البشري');
  let intent=b.intent||'';const allowed=['start','search','product','orders','order','payment','region','refunds','policies','human'];if(intent&&!allowed.includes(intent))fail(400,'طلب غير صالح');
  if(!intent){if(/موظف|اداره|انسان|بشري|human|agent/.test(q))intent='human';else if(/استرجاع|استرداد|refund/.test(q))intent='refunds';else if(/طلبي|طلباتي|طلب رقم|حاله الطلب|order status/.test(q))intent='orders';else if(/دفع|دفعت|pay|واتساب|وسيله/.test(q))intent='payment';else if(/منطقه|دوله|ريجن|region/.test(q))intent='region';else if(/خصوصيه|شروط|سياس/.test(q))intent='policies';else intent=q?'search':'start';}
  const result={mode:'guided',reply:'',products:[],orders:[],links:[],offer_handoff:true,intent};
  if(intent==='human'){result.reply='تقدر تنتقل لموظف من زر «التحدث مع موظف». رح تراجع الرسالة قبل إرسالها، وقد يبقى طلبك بانتظار توفر الفريق.';result.handoff=true;return result;}
  if(intent==='start'){result.reply='أنا مساعد ريفو الآلي المبني على بيانات المتجر. أساعدك تبحث عن منتج أو تقرأ تعليماته وسياساته، وأعرض طلباتك بعد تسجيل الدخول. اكتب اسم اللعبة أو اختَر موضوعًا. لست موظفًا ولا أغيّر الدفع أو أنفّذ طلبات.';return result;}
  if(intent==='orders'||intent==='order'){
   if(!user){result.reply='حالة الطلب معلومات خاصة. سجّل الدخول بحساب صاحب الطلب، ثم اسألني مرة ثانية.';result.links=[{title:'تسجيل الدخول',url:'/login'}];return result;}
   if(user.role!=='customer')fail(403,'متابعة الطلبات هنا مخصصة لحساب الزبون');
   let id=b.order_id;
   if(!id){const match=raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);id=match?.[0];}
   if(id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))fail(400,'رقم الطلب غير صالح');const o=await first('SELECT id,status,payment_status,customer_update,created_at FROM orders WHERE id=? AND user_id=?',id,user.id);if(!o){result.reply='لم أجد الطلب ضمن حسابك. تأكد أنك داخل حساب صاحب الطلب، أو تواصل مع الدعم.';return result;}result.orders=[await orderView(o)];result.reply='هذه الحالة المحفوظة الآن في المتجر. إذا دفعت ولم يتأكد الدفع، لا تكرر الدفع؛ افتح تفاصيل الطلب لمراجعة الحالة أو تواصل مع الفريق.';return result;}
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
   const p=catalog.find(p=>p.id===b.product_id);if(!p){result.reply='المنتج لم يعد منشورًا أو متاحًا للعرض. جرّب البحث مرة ثانية.';return result;}result.products=[safeProduct(p,true)];result.reply='هذه تفاصيل المنتج كما أدخلها المتجر. إذا تعليمات التفعيل أو وقت التنفيذ غير مكتوبين، اسأل الموظف؛ ما عندي تفاصيل إضافية مؤكدة.';return result;
  }
  const ignored=new Set(['بدي','ابحث','عن','عندكم','عندك','في','هل','ممكن','اريد','منتج','بطاقه','شحن','كيف','افعل','تفعيل','طريقة','طريقه']);const words=q.split(/\s+/).filter(w=>w&&!ignored.has(w));
  if(!words.length){result.reply='اكتب اسم اللعبة أو المنصة، مثل Steam أو PUBG، حتى أبحث في المنتجات المنشورة.';return result;}
  const matches=catalog.filter(p=>{const content=normal([p.name,p.category,p.description,p.region].join(' '));return words.every(w=>content.includes(w));});
  result.products=matches.slice(0,5).map(p=>safeProduct(p));result.reply=matches.length?`وجدت ${matches.length} منتجًا مطابقًا، وهذه أول خمس نتائج كحد أقصى. اختَر منتجًا لقراءة تعليماته وتنبيهاته. الأسعار بعملة ${currency}.`:'ما لقيت منتجًا مطابقًا. جرّب اسم اللعبة فقط، أو اضغط «التحدث مع موظف». البحث لا يترجم أسماء الألعاب تلقائيًا.';return result;
 }
 async function orderView(o){return {id:o.id,status:statuses[o.status]||'قيد المتابعة',payment:payments[o.payment_status]||'تحتاج مراجعة',update:o.customer_update,url:'/order.html?order='+o.id};}
 return {answer};
}
