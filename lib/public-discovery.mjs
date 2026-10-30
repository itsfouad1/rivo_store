const xml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export async function publicDiscovery(req,db){
 const url=new URL(req.url);if(!['/robots.txt','/sitemap.xml'].includes(url.pathname))return null;
 if(req.method!=='GET'&&req.method!=='HEAD')return new Response('Method not allowed',{status:405});
 let content,type;
 if(url.pathname==='/robots.txt'){type='text/plain; charset=utf-8';content='User-agent: *\nAllow: /\n'+['/api/','/admin','/account','/login','/register','/recover','/confirm','/order.html','/payment.html','/chat.html','/operations.html'].map(p=>'Disallow: '+p).join('\n')+'\nSitemap: '+url.origin+'/sitemap.xml\n';}
 else{
  type='application/xml; charset=utf-8';const rows=(await db.prepare("SELECT id FROM products WHERE status='active' ORDER BY id LIMIT 1000").all()).results;
  const policies=(await db.prepare("SELECT id,value FROM settings WHERE id IN ('policy:privacy','policy:terms','policy:refunds')").all()).results;
  const links=[url.origin+'/',url.origin+'/products.html',...rows.map(p=>url.origin+'/product.html?id='+encodeURIComponent(p.id)),...policies.filter(p=>{try{return !!JSON.parse(p.value).published?.body}catch{return false}}).map(p=>url.origin+'/policy.html?type='+encodeURIComponent(p.id.slice(7)))];
  content='<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+links.map(u=>'<url><loc>'+xml(u)+'</loc></url>').join('')+'</urlset>';
 }
 return new Response(req.method==='HEAD'?null:content,{headers:{'Content-Type':type,'Cache-Control':'public,max-age=300','X-Content-Type-Options':'nosniff'}});
}
