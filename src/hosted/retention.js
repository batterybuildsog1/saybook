import { now } from './util.js';
import { purgeAccount } from './accounts.js';
const DAY=86400000;
export async function scheduled(env) {
 if(env.MODE!=='hosted')return;
 const at=now();let cursor='';
 for(;;) {
  // Server-only maintenance enumerates IDs. Every subsequent data read/delete binds that ID.
  const page=await env.DB.prepare('SELECT account_id FROM hosted_accounts WHERE account_id>? ORDER BY account_id LIMIT 100').bind(cursor).all();
  for(const {account_id} of page.results) {
   const a=await env.DB.prepare('SELECT * FROM hosted_accounts WHERE account_id=?').bind(account_id).first();
   if(!a)continue;
   const expired=a.status==='deleting'||Math.max(a.last_active,a.created)<at-365*DAY;
   if(expired) {
    try { await purgeAccount(null,env,a); }
    catch { console.error('Hosted retention account cleanup needs operator review'); }
   }else {
    await env.DB.batch([
     env.DB.prepare('DELETE FROM events WHERE account_id=? AND at<?').bind(account_id,at-30*DAY),
     env.DB.prepare('DELETE FROM usage_ledger WHERE account_id=? AND at<?').bind(account_id,at-396*DAY),
     env.DB.prepare('DELETE FROM hosted_usage WHERE account_id=? AND at<?').bind(account_id,at-396*DAY),
     env.DB.prepare('DELETE FROM hosted_reservations WHERE account_id=? AND at<? AND expires<?').bind(account_id,at-DAY,at),
     env.DB.prepare('DELETE FROM hosted_sessions WHERE account_id=? AND expires<?').bind(account_id,at),
    ]);
   }
  }
  if(page.results.length<100)break;cursor=page.results.at(-1).account_id;
 }
 await env.DB.batch([
  env.DB.prepare('DELETE FROM contact_limits WHERE expires<?').bind(at),
  env.DB.prepare("DELETE FROM hosted_auth_limits WHERE account_id='' AND expires<?").bind(at),
  env.DB.prepare("DELETE FROM hosted_breakers WHERE account_id='__global__' AND until_at<?").bind(at),
  // The waitlist is retired (Alan, 2026-11-03: no family cap); this stays until any rows it held have expired.
  env.DB.prepare('DELETE FROM hosted_waitlist WHERE expires<?').bind(at),
  env.DB.prepare("DELETE FROM hosted_global_usage WHERE account_id='__global__' AND day<?").bind(at-396*DAY),
 ]);
}
