import { captureServer } from "../analytics.js";
import { now, id, number, micros, json, fail, enabled } from './util.js';
const holds = new WeakMap();
const DEFAULT_RESERVES = { image:2, cast:2, text:0.50, chat:0.50, book:0.50, punctuation:0.50, tts:0.50, stt:0.02, narration:0.02 };
export const LIMIT_MESSAGE = 'Your words are safe. The printing press is resting. You can keep imagining while a grown-up checks when pictures and voices are ready again.';
export function period(at=now()) { const d=new Date(at); return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1); }
export function config(env) {
 return { allowance:micros(number(env,'HOSTED_MONTHLY_ALLOWANCE_USD',2.25,0.01)), // Final benchmark provider reserve; change on API migration.
 daily:micros(number(env,'HOSTED_GLOBAL_DAILY_USD',25,0.01)),
 images:number(env,'HOSTED_MONTHLY_IMAGES',120,1),tokens:number(env,'HOSTED_MONTHLY_TOKENS',1000000,1),
 dailyImages:number(env,'HOSTED_GLOBAL_DAILY_IMAGES',100,1),dailyTokens:number(env,'HOSTED_GLOBAL_DAILY_TOKENS',1000000,1),
 characters:number(env,'HOSTED_MONTHLY_TTS_CHARACTERS',50000,1),dailyCharacters:number(env,'HOSTED_GLOBAL_DAILY_TTS_CHARACTERS',500000,1),
 rate:number(env,'HOSTED_RATE_PER_MINUTE',20,1),concurrent:number(env,'HOSTED_MAX_INFLIGHT',4,1) };
}
async function totals(env,accountId) {
 const at=now(),month=period(at),day=new Date(at).setUTCHours(0,0,0,0);
 const sum=(table,column,clause)=>`(SELECT COALESCE(SUM(${column}),0) FROM ${table} WHERE ${clause})`;
 const specs=[['used','hosted_usage','usd_micros','account_id=? AND at>=?',[accountId,month]],
 ['images','hosted_usage','images','account_id=? AND at>=?',[accountId,month]],
 ['tokens','hosted_usage','tokens','account_id=? AND at>=?',[accountId,month]],
 ['characters','hosted_usage','characters','account_id=? AND at>=?',[accountId,month]],
 ['reserved','hosted_reservations','usd_micros','account_id=? AND expires>?',[accountId,at]],
 ['reserved_images','hosted_reservations','images','account_id=? AND expires>?',[accountId,at]],
 ['reserved_tokens','hosted_reservations','tokens','account_id=? AND expires>?',[accountId,at]],
 ['reserved_characters','hosted_reservations','characters','account_id=? AND expires>?',[accountId,at]],
 ['daily','hosted_global_usage','usd_micros',"account_id='__global__' AND day=?",[day]],['daily_images','hosted_global_usage','images',"account_id='__global__' AND day=?",[day]],['daily_tokens','hosted_global_usage','tokens',"account_id='__global__' AND day=?",[day]],['daily_characters','hosted_global_usage','characters',"account_id='__global__' AND day=?",[day]],
 ['daily_reserved','hosted_reservations','usd_micros','expires>?',[at]],['daily_reserved_images','hosted_reservations','images','expires>?',[at]],['daily_reserved_tokens','hosted_reservations','tokens','expires>?',[at]],['daily_reserved_characters','hosted_reservations','characters','expires>?',[at]]];
 const sql=specs.map(([alias,table,col,where])=>`${sum(table,col,where)} AS ${alias}`).join(',');
 return env.DB.prepare(`SELECT ${sql},
 (SELECT COUNT(*) FROM hosted_reservations WHERE account_id=? AND at>?) AS recent,
 (SELECT COUNT(*) FROM hosted_reservations WHERE account_id=? AND expires>?) AS inflight`)
 .bind(...specs.flatMap(x=>x[4]),accountId,at-60000,accountId,at).first();
}
export async function usage(env,accountId) {
 const t=await totals(env,accountId),c=config(env),d=new Date(period()),end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)).toISOString();
 const pct=Math.max(t.used/c.allowance,t.images/c.images,t.tokens/c.tokens,t.characters/c.characters),limited=t.used+t.reserved>=c.allowance||t.images+t.reserved_images>=c.images||t.tokens+t.reserved_tokens>=c.tokens||t.characters+t.reserved_characters>=c.characters;
 return {period_start:d.toISOString(),period_end:end,resets_at:end,pct:Math.min(1,pct),state:limited?'limit':pct>=0.8?'warn':'ok',
 provider_cost_usd:t.used/1e6,reserved_usd:t.reserved/1e6,allowance_usd:c.allowance/1e6,remaining_usd:Math.max(0,c.allowance-t.used-t.reserved)/1e6,
 images:t.images,image_allowance:c.images,reserved_images:t.reserved_images,tokens:t.tokens,token_allowance:c.tokens,reserved_tokens:t.reserved_tokens,
 tts_characters:t.characters,tts_character_allowance:c.characters,reserved_characters:t.reserved_characters,warning:pct>=0.8,limit_reached:limited,paused:enabled(env.HOSTED_PAUSE),
 breakdown:{pictures:t.images,readings:t.characters},allowance_note:"About 8 typical books per month; longer books and redraws use more allowance",about_books:8};
}
export async function allow(env,accountId,kind) {
 if(enabled(env.HOSTED_PAUSE)||(enabled(env.HOSTED_TTS_PAUSE)&&(typeof kind==='string'?kind:kind?.kind)==='tts'))return {ok:false,reason:'breaker',message:LIMIT_MESSAGE};
 const c=config(env),at=now(),month=period(at),day=new Date(at).setUTCHours(0,0,0,0);
 const breaker=await env.DB.prepare("SELECT until_at FROM hosted_breakers WHERE account_id='__global__' AND id='provider' AND until_at>?").bind(at).first();
 if(breaker)return {ok:false,reason:'breaker',message:LIMIT_MESSAGE};
 const name=typeof kind==='string'?kind:kind?.kind;
 if(!name||!Object.hasOwn(DEFAULT_RESERVES,name))return {ok:false,reason:'unknown_operation',message:LIMIT_MESSAGE};
 const flatRate=enabled(env.PROVIDER_FLAT_RATE)&&['image','cast','text','chat','book','punctuation'].includes(name);
 const reserve=micros(number(env,`HOSTED_RESERVE_${name.toUpperCase()}_USD`,flatRate?0:DEFAULT_RESERVES[name],0));
 const imageReserve=['image','cast'].includes(name)?number(env,'HOSTED_RESERVE_IMAGES',1,1):0;
 const tokenReserve=['text','chat','book','punctuation'].includes(name)?number(env,'HOSTED_RESERVE_TOKENS',128000,1):0;
 const charReserve=name==='tts'?number(env,'HOSTED_RESERVE_TTS_CHARACTERS',12000,1):0;
 const reservation=id();
 const dimensions=[['usd_micros',reserve,c.allowance,c.daily],['images',imageReserve,c.images,c.dailyImages],['tokens',tokenReserve,c.tokens,c.dailyTokens],['characters',charReserve,c.characters,c.dailyCharacters]];
 const clauses=[],bindings=[accountId,reservation,name,reserve,imageReserve,tokenReserve,charReserve,at,at+30*60000,accountId,at];
 for(const [column,reserved,monthly,daily] of dimensions) {
  clauses.push(`(SELECT COALESCE(SUM(${column}),0) FROM hosted_usage WHERE account_id=? AND at>=?)
   +(SELECT COALESCE(SUM(${column}),0) FROM hosted_reservations WHERE account_id=? AND expires>?) + ? <= ?`);
  bindings.push(accountId,month,accountId,at,reserved,monthly);
  clauses.push(`(SELECT COALESCE(SUM(${column}),0) FROM hosted_global_usage WHERE account_id='__global__' AND day=?)
   +(SELECT COALESCE(SUM(${column}),0) FROM hosted_reservations WHERE expires>?) + ? <= ?`);
  bindings.push(day,at,reserved,daily);
 }
 bindings.push(accountId,at-60000,c.rate,accountId,at,c.concurrent);
 // One conditional write is the admission decision; competing D1 writes see each other's holds.
 const result=await env.DB.prepare(`INSERT INTO hosted_reservations(account_id,id,kind,usd_micros,images,tokens,characters,at,expires)
 SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hosted_accounts WHERE account_id=? AND status='active'
 AND consent_at>0 AND parent_verified_at>0 AND subscription_status='active' AND subscription_end>?)
 AND ${clauses.join(' AND ')}
 AND (SELECT COUNT(*) FROM hosted_reservations WHERE account_id=? AND at>?) < ?
 AND (SELECT COUNT(*) FROM hosted_reservations WHERE account_id=? AND expires>?) < ?`).bind(...bindings).run();
 if(result.meta.changes===1) {
  let pending=holds.get(env);if(!pending)holds.set(env,pending=[]);
  pending.push({id:reservation,accountId,kind:name});
  const t=await totals(env,accountId);
  return {ok:true,reservation_id:reservation,warning:Math.max(t.used/c.allowance,t.images/c.images,t.tokens/c.tokens,t.characters/c.characters)>=0.8};
 }
 const a=await env.DB.prepare('SELECT status,consent_at,parent_verified_at,subscription_status,subscription_end FROM hosted_accounts WHERE account_id=?').bind(accountId).first();
 let reason='allowance';
 if(!a||a.status!=='active')reason='account_unavailable';
 else if(!a.consent_at||!a.parent_verified_at)reason='parental_consent_required';
 else if(a.subscription_status!=='active'||a.subscription_end<=at)reason='billing';
 else {
  const t=await totals(env,accountId);
  if(t.daily+t.daily_reserved+reserve>c.daily||t.daily_images+t.daily_reserved_images+imageReserve>c.dailyImages||t.daily_tokens+t.daily_reserved_tokens+tokenReserve>c.dailyTokens||t.daily_characters+t.daily_reserved_characters+charReserve>c.dailyCharacters)reason='breaker';
  else if(t.recent>=c.rate||t.inflight>=c.concurrent)reason='rate_limit';
 }
 if(['allowance','rate_limit','breaker'].includes(reason))captureServer(env,'allowance_hit',{error_code:reason==='rate_limit'?'rate_limit':'quota'},{accountId,object:`${period()}:${reason}`});
 return {ok:false,reason,message:LIMIT_MESSAGE};
}
function unitsOf(detail) {
 const raw=detail.units??{},u=typeof raw==='object'&&raw!==null?raw:{};
 const numeric=typeof raw==='number'?raw:0;
 const positive=x=>Number.isFinite(Number(x))&&Number(x)>=0?Math.ceil(Number(x)):0;
 return {raw,images:positive(u.images??(detail.kind==='image'?numeric||1:0)),
 tokens:positive(u.total_tokens??u.tokens??((u.input_tokens||u.output_tokens)?Number(u.input_tokens||0)+Number(u.output_tokens||0):detail.kind==='text'?numeric:0)),
 characters:positive(u.characters??u.chars??(detail.kind==='tts'?numeric:0))};
}
export async function charge(env,accountId,detail) {
 if(!detail||typeof detail.kind!=='string'||!Number.isFinite(detail.usd)||detail.usd<0)throw new Error('Provider cost must be a non-negative USD number');
 const u=unitsOf(detail),units=JSON.stringify(u.raw);if(units.length>8192)throw new Error('Usage units too large');
 const pending=holds.get(env)||[],ix=pending.findIndex(h=>h.accountId===accountId&&(detail.reservation_id?h.id===detail.reservation_id:h.kind===detail.kind));
 const hold=ix>=0?pending[ix]:null,callId=detail.call_id||hold?.id;
 if(!callId)throw new Error('Hosted charge requires the paid call reservation or a stable call_id');
 const at=now(),day=new Date(at).setUTCHours(0,0,0,0);
 const statements=[env.DB.prepare(`INSERT INTO hosted_global_usage(account_id,day,usd_micros,images,tokens,characters)
 SELECT '__global__',?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM hosted_usage WHERE account_id=? AND id=?)
 AND EXISTS(SELECT 1 FROM hosted_accounts WHERE account_id=?)
 ON CONFLICT(account_id,day) DO UPDATE SET usd_micros=usd_micros+excluded.usd_micros,images=images+excluded.images,tokens=tokens+excluded.tokens,characters=characters+excluded.characters`)
 .bind(day,micros(detail.usd),u.images,u.tokens,u.characters,accountId,callId,accountId),
 env.DB.prepare(`INSERT OR IGNORE INTO hosted_usage(account_id,id,kind,usd_micros,images,tokens,characters,units,story_id,at)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hosted_accounts WHERE account_id=?)`)
 .bind(accountId,callId,detail.kind,micros(detail.usd),u.images,u.tokens,u.characters,units,detail.story_id||null,now(),accountId)];
 if(hold)statements.push(env.DB.prepare('UPDATE hosted_reservations SET usd_micros=0,images=0,tokens=0,characters=0,expires=? WHERE account_id=? AND id=?').bind(now(),accountId,hold.id));
 await env.DB.batch(statements);if(hold)pending.splice(ix,1);
}
export async function finish(env) {
 const pending=holds.get(env)||[];if(!pending.length)return;
 await env.DB.batch(pending.map(h=>env.DB.prepare('UPDATE hosted_reservations SET usd_micros=0,images=0,tokens=0,characters=0,expires=? WHERE account_id=? AND id=?').bind(now(),h.accountId,h.id)));
 holds.delete(env);
}
export async function usageResponse(req,env,a,url) {
 if(url.pathname==='/api/account/usage')return json(await usage(env,a.account_id));
 if(url.pathname==='/api/account/ledger') {
  const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||100)),before=Number(url.searchParams.get('before'))||now()+1;
  const {results}=await env.DB.prepare('SELECT id,kind,usd_micros,images,tokens,characters,units,story_id,at FROM hosted_usage WHERE account_id=? AND at<? ORDER BY at DESC,id LIMIT ?').bind(a.account_id,before,limit).all();
  return json({entries:results.map(r=>({...r,usd:r.usd_micros/1e6,units:JSON.parse(r.units)})),usage:await usage(env,a.account_id)});
 }
 fail(404,'not found');
}

export async function providerLimit(env) {
 const end=new Date(now()).setUTCHours(24,0,0,0);
 await env.DB.prepare("INSERT INTO hosted_breakers(account_id,id,until_at,reason) VALUES('__global__','provider',?,'provider_limit') ON CONFLICT(account_id,id) DO UPDATE SET until_at=excluded.until_at,reason=excluded.reason").bind(end).run();
}
