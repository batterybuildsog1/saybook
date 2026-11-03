// The only server ingestion boundary. Never pass request bodies, URLs or provider metadata here.
import { sha } from './hosted/util.js';
export const SERVER_EVENTS = ['signup_started','consent_given','checkout_started','subscribed','writer_added','story_started','first_page_formed','first_picture_painted','first_read_aloud','book_shared','second_story','subscription_canceled','allowance_hit','error'];
const PARENT = new Set(['signup_started','checkout_started','subscribed','consent_given','subscription_canceled']);
const ENUMS = {
 operation: ['signup','consent','checkout','subscribe','writer','story','page','image','audio','share','stt','save','request'],
 error_code: ['network','timeout','rate_limit','quota','provider','validation','unauthorized','unknown'],
 route: ['/','/home/','/signin/','/account/'],
};
export function safeProperties(input={}) {
 const out={};
 for(const [k,v] of Object.entries(input)) {
  if(ENUMS[k]?.includes(v))out[k]=v;
  else if(['count','duration_ms','lcp_ms','inp_ms','cls','status'].includes(k)&&typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e9)out[k]=v;
  else if(k==='ok'&&typeof v==='boolean')out[k]=v;
 }
 return out;
}
// Local E2E only: a loopback capture URL stands in for PostHog. Anything else goes to PostHog US.
const captureUrl = env => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w/]*$/.test(env.ANALYTICS_CAPTURE_URL||'') ? env.ANALYTICS_CAPTURE_URL : 'https://us.i.posthog.com/i/v0/e/';
export const accountHash = id => sha(`saybook:analytics:v1:${id}`);
export function captureServer(env,event,properties={}, {accountId=env.account_id,object='account'}={}) {
 if(env.MODE!=='hosted'||!env.CTX?.waitUntil||!env.ANALYTICS_KEY||env.ANALYTICS_BUDGET_VERIFIED!=='true'||!SERVER_EVENTS.includes(event)||!accountId)return;
 // All DB and network work belongs to waitUntil, including consent checks and hashing.
 const task=(async()=>{
  const a=await env.DB.prepare(`SELECT a.consent_at,a.parent_verified_at,a.internal FROM hosted_accounts a JOIN analytics_preferences p ON p.account_id=a.account_id WHERE a.account_id=? AND a.status='active' AND p.enabled=1`).bind(accountId).first();
  if(!a||(!PARENT.has(event)&&!(a.consent_at>0&&a.parent_verified_at>0)))return;
  if(event==='second_story') {
   const count=await env.DB.prepare('SELECT COUNT(*) n FROM stories WHERE account_id=?').bind(accountId).first();
   if(count.n<2)return;
   properties={count:count.n};
  }
  const distinct_id=await accountHash(accountId),objectHash=await sha(String(object));
  const insertId=await sha(`${distinct_id}:${event}:${objectHash}`);
  const once=await env.DB.prepare('INSERT OR IGNORE INTO analytics_milestones(account_id,event,object_hash,at) VALUES(?,?,?,?)').bind(accountId,event,objectHash,Date.now()).run();
  if(!once.meta.changes)return;
  const props={...safeProperties(properties),schema_version:2,source:'server',deployment:env.ANALYTICS_DEPLOYMENT==='production'?'production':'test',account_id:distinct_id,$insert_id:insertId,$process_person_profile:false,$geoip_disable:true,$ip:'0.0.0.0'};
  // Insiders (src/hosted/internal.js) carry one boolean on the event and their person; real families send nothing extra.
  if(a.internal)Object.assign(props,{internal:true,$process_person_profile:true,$set:{internal:true}});
  let r;try{r=await fetch(captureUrl(env),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api_key:env.ANALYTICS_KEY,event,distinct_id,properties:props,timestamp:new Date().toISOString()}),signal:AbortSignal.timeout(5000)});}catch{r={ok:false,status:0};}
  if(!r.ok){await env.DB.prepare('DELETE FROM analytics_milestones WHERE account_id=? AND event=? AND object_hash=?').bind(accountId,event,objectHash).run();console.error('analytics capture unavailable',r.status);}
 })().catch(()=>console.error('analytics capture unavailable'));
 env.CTX.waitUntil(task);
}
