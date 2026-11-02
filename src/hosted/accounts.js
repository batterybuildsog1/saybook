import { now, id, json, body, fail, safeAccount, mediaPrefix, NOTICE_VERSION, testRequest } from './util.js';
import { usage, allow, charge, finish } from './usage.js';
import { cancelForDeletion } from './billing.js';
const TABLES=['shares','stories','scenes','events','settings','usage_ledger','hosted_profiles','hosted_consent','hosted_usage'];
const b64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
export function dataExport(env,a) {
 const stream=new ReadableStream({
  async start(controller) {
   const emit=x=>controller.enqueue(new TextEncoder().encode(JSON.stringify(x)+'\n'));
   try {
    emit({type:'account',version:1,exported_at:new Date().toISOString(),account:safeAccount(a)});
    for(const table of TABLES) {
     // The table names are constants, never supplied by a request.
     for(let offset=0;;offset+=200) {
      const {results}=await env.DB.prepare(`SELECT * FROM ${table} WHERE account_id=? LIMIT 200 OFFSET ?`).bind(a.account_id,offset).all();
      for(const row of results) emit({type:'row',table,data:row});
      if(results.length<200)break;
     }
    }
    for(let cursor;;) {
     const page=await env.MEDIA.list({prefix:mediaPrefix(a.account_id),cursor,limit:100});
     for(const entry of page.objects) {
      const object=await env.MEDIA.get(entry.key); if(!object)continue;
      const key=entry.key.slice(mediaPrefix(a.account_id).length);
      emit({type:'media',key,size:object.size,content_type:object.httpMetadata?.contentType||'application/octet-stream'});
      const reader=object.body.getReader();let chunk=0;
      for(;;){const {done,value}=await reader.read();if(done)break;emit({type:'media_chunk',key,chunk:chunk++,base64:b64(value)});}
      emit({type:'media_end',key,chunks:chunk});
     }
     if(!page.truncated)break;cursor=page.cursor;
    }
    emit({type:'complete'});controller.close();
   } catch {controller.error(new Error('Export incomplete; please retry'));}
  },
 });
 return new Response(stream,{headers:{'content-type':'application/x-ndjson; charset=utf-8','content-disposition':'attachment; filename="storybook-account.ndjson"','cache-control':'no-store','x-content-type-options':'nosniff'}});
}
export async function deleteAccount(req,env,a) {
 const b=await body(req);if(b.confirmation!=='DELETE')fail(400,'Type DELETE to confirm account deletion');
 return purgeAccount(req,env,a);
}
export async function purgeAccount(req,env,a) {
 // Freeze first. A failed cancellation or storage operation leaves a retryable deleting account, never a false success.
 await env.DB.prepare("UPDATE hosted_accounts SET status='deleting' WHERE account_id=?").bind(a.account_id).run();
 await cancelForDeletion(req,env,a);
 await env.DB.prepare("UPDATE hosted_accounts SET subscription_status='canceled',subscription_end=0 WHERE account_id=?").bind(a.account_id).run();
 const inflight=await env.DB.prepare('SELECT COUNT(*) n FROM hosted_reservations WHERE account_id=? AND expires>?').bind(a.account_id,now()).first();
 if(inflight.n) return json({error:'deletion_waiting_for_inflight_work',message:'The account is locked. Please retry deletion after the current picture or recording finishes.'},409);
 for(let cursor;;) {
  const page=await env.MEDIA.list({prefix:mediaPrefix(a.account_id),cursor,limit:1000});
  if(page.objects.length)await env.MEDIA.delete(page.objects.map(x=>x.key));
  if(!page.truncated)break;cursor=page.cursor;
 }
 const tables=[...TABLES,'hosted_enrollment','hosted_sessions','hosted_reservations','hosted_stripe_events','hosted_auth_limits','hosted_accounts'];
 await env.DB.batch(tables.map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE account_id=?`).bind(a.account_id)));
 return new Response(null,{status:204,headers:{'cache-control':'no-store','set-cookie':'__Host-storybook=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'}});
}
export async function accountRoute(req,env,a,url) {
 const path=url.pathname,m=req.method;
 if(path==='/api/account' && m==='GET')return json({account:safeAccount(a),usage:await usage(env,a.account_id)});
 if(path==='/api/account'&&m==='DELETE')return deleteAccount(req,env,a);
 if(path==='/api/account/export'&&m==='POST')return dataExport(env,a);
 if(path==='/api/account'&&(m==='PUT'||m==='PATCH')) {
  const b=await body(req);
  if(!a.parent_verified_at)fail(403,'parental_consent_required');
  if(typeof b.recordings_enabled!=='boolean')fail(400,'Choose whether to save Read it to me recordings');
  if(b.recordings_enabled && b.notice_version!==NOTICE_VERSION)fail(400,'Accept the current recording notice');
  await env.DB.batch([
   env.DB.prepare('UPDATE hosted_accounts SET recordings_enabled=? WHERE account_id=?').bind(b.recordings_enabled?1:0,a.account_id),
   env.DB.prepare('INSERT INTO hosted_consent(account_id,id,version,action,at) VALUES(?,?,?,?,?)').bind(a.account_id,id(),NOTICE_VERSION,b.recordings_enabled?'recordings_enabled':'recordings_disabled',now()),
  ]);
  return json({ok:true,recordings_enabled:b.recordings_enabled});
 }
 if(path==='/api/account/profiles') {
  if(!a.parent_verified_at)fail(403,'parental_consent_required');
  const row=await env.DB.prepare('SELECT writers FROM settings WHERE account_id=?').bind(a.account_id).first();
  const writers=row?JSON.parse(row.writers):[];
  const profiles=writers.map(w=>typeof w==='string'?{id:w,name:w,color:'#92734d'}:{...w,id:w.name});
  if(m==='GET')return json({profiles});
  if(m==='POST') {
   const b=await body(req),name=String(b.name||'').trim().slice(0,24),color=/^#[0-9a-f]{6}$/i.test(b.color||'')?b.color:'#92734d';
   if(!name)fail(400,'Choose a writer nickname');
   if(profiles.length>=12)fail(400,'This family already has 12 writer profiles');
   if(profiles.some(p=>p.name===name))fail(409,'Choose a different nickname');
   const writer={name,color};
   await env.DB.prepare('INSERT INTO settings(account_id,writers) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET writers=excluded.writers').bind(a.account_id,JSON.stringify([...writers,writer])).run();
   return json({...writer,id:name},201);
  }
 }
 // Internal test harness only. A normal parent session never permits these routes; live Stripe mode disables them.
 if(path.startsWith('/api/account/test/')) {
  if(!testRequest(req,env))fail(404,'not found');
  if(path==='/api/account/test/spend'&&m==='POST') {
   const b=await body(req),kind=b.kind||'text';
   const testEnv=Object.create(env);
   const options=['HOSTED_PAUSE','HOSTED_MONTHLY_IMAGES','HOSTED_MONTHLY_TOKENS','HOSTED_MONTHLY_TTS_CHARACTERS','HOSTED_MONTHLY_ALLOWANCE_USD','HOSTED_GLOBAL_DAILY_IMAGES','HOSTED_GLOBAL_DAILY_TOKENS','HOSTED_GLOBAL_DAILY_USD','HOSTED_RATE_PER_MINUTE','HOSTED_MAX_INFLIGHT'];
   for(const key of options)if(b.config&&Object.hasOwn(b.config,key))testEnv[key]=String(b.config[key]);
   try {
   const decision=await allow(testEnv,a.account_id,kind);
   if(!decision.ok)return json(decision,402);
   if(b.delay_ms)await new Promise(resolve=>setTimeout(resolve,Math.min(Number(b.delay_ms)||0,1500)));
   const usd=Number(b.usd??0.01);if(!Number.isFinite(usd)||usd<0||usd>2)fail(400,'Invalid fixture cost');
   await charge(testEnv,a.account_id,{kind,usd,units:{fixture:true,...b.units},story_id:b.story_id||null});
   return json({ok:true,fixture:true,usage:await usage(testEnv,a.account_id)});
   }finally{await finish(testEnv);}
  }
  if(path==='/api/account/test/waitlist'&&m==='DELETE'){
   const b=await body(req),email=String(b.email||'').toLowerCase();
   if(!email.endsWith('@example.invalid'))fail(400,'Synthetic waitlist email required');
   const {sha}=await import('./util.js');const key=await sha(`waitlist:${email}`);
   const row=await env.DB.prepare('SELECT email FROM hosted_waitlist WHERE account_id=?').bind(key).first();
   await env.DB.prepare('DELETE FROM hosted_waitlist WHERE account_id=?').bind(key).run();return json({deleted:!!row});
  }
  if(path==='/api/account/test/retention'&&m==='POST') {
   const b=await body(req),days=Number(b.days);
   if(!Number.isFinite(days)||days<0||days>500)fail(400,'Invalid fixture age');
   await env.DB.prepare('UPDATE hosted_accounts SET created=?,last_active=? WHERE account_id=?').bind(now()-days*86400000,now()-days*86400000,a.account_id).run();
   await (await import('./retention.js')).scheduled(env);
   return json({fixture:true,cleanup_ran:true});
  }
 }
 fail(404,'not found');
}
