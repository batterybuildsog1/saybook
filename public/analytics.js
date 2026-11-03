import { analyticsConfig,captureSafe,withdrawAnalytics } from '/analytics-config.js';
const LS_KEY='saybook.analytics';
export const analyticsChoice={get(){try{return localStorage.getItem(LS_KEY)==='on';}catch{return false;}},set(on){try{if(on)localStorage.setItem(LS_KEY,'on');else localStorage.removeItem(LS_KEY);}catch{}}};
export const analyticsOffered=cfg=>typeof cfg?.analytics_key==='string'&&cfg.analytics_key.startsWith('phc_')&&cfg.analytics_budget_verified===true;
let ph=null,starting=null;
const parentRoute=()=>['/home/','/signin/','/account/'].includes(location.pathname)||location.pathname==='/'&&!document.querySelector('.kid-screen');
export async function startAnalytics(cfg,{surface='parent',accountId=''}={}) {
 if(!parentRoute()||surface!=='parent'||!analyticsChoice.get()||!analyticsOffered(cfg))return null;
 if(ph)return ph;if(starting)return starting;
 const options=analyticsConfig({mode:cfg.mode,key:cfg.analytics_key,analyticsConsent:true,surface:'parent',budgetVerified:cfg.analytics_budget_verified,replayApproved:cfg.analytics_replay,route:location.pathname,deployment:cfg.analytics_deployment});
 if(!options)return null;
 // rrweb's metadata includes location independently of event sanitization. Remove private URL parts BEFORE loading.
 history.replaceState(history.state,'',location.pathname);
 starting=(async()=>{
  if(!window.posthog?.__loaded)await new Promise(resolve=>{const s=document.createElement('script');s.src='/vendor/posthog-1.444.4.js';s.onload=resolve;s.onerror=resolve;document.head.appendChild(s);});
  if(!analyticsChoice.get()||!parentRoute()||!window.posthog)return null;
  let anonymous;try{anonymous=localStorage.getItem('saybook.analytics.id');if(!/^[a-f0-9-]{36}$/.test(anonymous||'')){anonymous=crypto.randomUUID();localStorage.setItem('saybook.analytics.id',anonymous);}}catch{anonymous=crypto.randomUUID();}
  // bootstrap avoids identify/person events and never puts an email or raw account id in persistence.
  const identity=/^[a-f0-9]{64}$/.test(accountId)?accountId:anonymous;
  ph=window.posthog.init(cfg.analytics_key,{...options,bootstrap:{distinctID:identity,isIdentifiedID:false}})||window.posthog;
  captureSafe(ph,'landing_viewed',{route:location.pathname});
  return ph;
 })();
 try{return await starting;}finally{starting=null;}
}
export function capture(event,props){if(ph)captureSafe(ph,event,props);}
export function stopAnalytics(){analyticsChoice.set(false);if(ph)withdrawAnalytics(ph);ph=null;try{localStorage.removeItem('saybook.analytics.id');}catch{};}
