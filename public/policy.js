const $=id=>document.getElementById(id),type=new URLSearchParams(location.search).get('type');
async function get(path){const r=await fetch(path,{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'تعذّر تحميل الصفحة');return d}
async function load(){try{
 if(!['privacy','terms','refunds'].includes(type))throw new Error('رابط الصفحة غير صالح. اختر صفحة من الروابط أدناه.');
 const {page}=await get('/api/policies/'+type);document.title=page.title+' | RIVO';$('policy-title').textContent=page.title;
 $('policy-date').textContent='آخر نشر: '+new Intl.DateTimeFormat('ar-PS',{dateStyle:'long'}).format(new Date(page.published_at));$('policy-body').textContent=page.body;$('policy-status').textContent='';
}catch(e){$('policy-status').textContent=e.message;}
 try{const {pages}=await get('/api/policies');for(const p of pages){const a=document.createElement('a');a.href='/policy.html?type='+p.type;a.textContent=p.title;if(p.type===type)a.setAttribute('aria-current','page');$('policy-nav').append(a)}}catch{}
}
load();
