import {analyticsChoice,analyticsOffered,startAnalytics,stopAnalytics,capture} from '/analytics.js';
const cfg=await fetch('/api/config').then(r=>r.json()).catch(()=>({}));
// This module is referenced only by parent pages. Never import it in the studio/shared reader.
if(analyticsOffered(cfg)) {
 const host=document.querySelector('[data-analytics-choice]');
 let accountHash='';
 if(location.pathname==='/account/') {
  const pref=await fetch('/api/account/analytics').then(r=>r.ok?r.json():null).catch(()=>null);
  if(pref){analyticsChoice.set(pref.enabled);accountHash=pref.account_hash;}
 }
 if(host){
  host.hidden=false;
  host.innerHTML='<label><input type="checkbox"> Help improve Saybook with optional usage data and masked recordings of parent pages.</label> <a href="/legal/privacy">Privacy</a>';
  const box=host.querySelector('input');box.checked=analyticsChoice.get();
  box.onchange=async()=>{
   analyticsChoice.set(box.checked);
   if(cfg.signed_in){const r=await fetch('/api/account/analytics',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:box.checked})});if(!r.ok){box.checked=false;stopAnalytics();return;}const pref=await r.json();accountHash=pref.account_hash;}
   if(box.checked)await startAnalytics(cfg,{accountId:accountHash});else {stopAnalytics();location.reload();}
  };
 }
 await startAnalytics(cfg,{accountId:accountHash});
 // Standard Web Vitals callbacks emit only the finalized numeric values; attribution/resource data is discarded.
 const {onLCP,onINP,onCLS}=await import('/vendor/web-vitals-5.1.0.js');
 for(const [observe,key] of [[onLCP,'lcp_ms'],[onINP,'inp_ms'],[onCLS,'cls']])observe(metric=>capture('page_performance',{route:location.pathname,[key]:metric.value}));
 let last=null,hits=0,lastAt=0,capturedAt=0;
 document.addEventListener('click',e=>{const el=e.target.closest('button,a');if(!el)return;const at=Date.now();hits=el===last&&at-lastAt<1000?hits+1:1;last=el;lastAt=at;if(hits>=3&&at-capturedAt>10000){capturedAt=at;capture('rage_click',{route:location.pathname,control:el.id==='checkout'?'checkout':'navigation'});}});
}
