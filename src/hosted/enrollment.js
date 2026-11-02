import { now, number, sha, json, fail, body, testRequest } from './util.js';
export const PAINTING_NOTICE='Pictures can take a few minutes to paint. Under busy shared load, the first picture may take around 6–11 minutes. Your story stays saved while it paints.';
export function maximumAccounts(env){return Math.floor(number(env,'HOSTED_MAX_ACCOUNTS',10,1));}
export async function enrollment(env){
 const r=await env.DB.prepare(`SELECT
 (SELECT COUNT(*) FROM hosted_enrollment WHERE expires>?) AS slots,
 (SELECT COUNT(*) FROM hosted_accounts WHERE status='active' AND subscription_status='active' AND subscription_end>? AND parent_verified_at>0) AS paid`)
 .bind(now(),now()).first();
 return {waitlist_only:r.slots>=maximumAccounts(env)||r.paid>=maximumAccounts(env),paid_families:r.paid,max_accounts:maximumAccounts(env),painting_notice:PAINTING_NOTICE,about_books:8};
}
export async function waitlist(email,env){
 const key=await sha(`waitlist:${email}`),at=now();
 await env.DB.prepare('INSERT INTO hosted_waitlist(account_id,email,created,expires) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET expires=excluded.expires').bind(key,email,at,at+30*86400000).run();
 return json({waitlisted:true,message:'Our first family shelves are full. We saved only your email for the waitlist. There is no charge and no child data is collected.'},202);
}
export async function reserveEnrollment(env,accountId){
 const at=now(),limit=maximumAccounts(env);
 const r=await env.DB.prepare(`INSERT INTO hosted_enrollment(account_id,expires,state)
 SELECT ?,?,'reserved' WHERE
 (SELECT COUNT(*) FROM hosted_enrollment WHERE expires>? AND account_id<>?) < ?
 AND EXISTS(SELECT 1 FROM hosted_accounts WHERE account_id=? AND status='active')
 ON CONFLICT(account_id) DO UPDATE SET expires=MAX(hosted_enrollment.expires,excluded.expires)`)
 .bind(accountId,at+2*3600000,at,accountId,limit,accountId).run();
 return r.meta.changes===1;
}
export function enrollmentUpdate(env,accountId){
 return [env.DB.prepare(`DELETE FROM hosted_enrollment WHERE account_id=? AND state='paid' AND NOT EXISTS(SELECT 1 FROM hosted_accounts WHERE account_id=? AND status='active' AND subscription_status='active' AND subscription_end>?)`).bind(accountId,accountId,now()),
 env.DB.prepare(`INSERT INTO hosted_enrollment(account_id,expires,state)
 SELECT account_id,subscription_end,'paid' FROM hosted_accounts WHERE account_id=? AND status='active' AND subscription_status='active' AND subscription_end>?
 ON CONFLICT(account_id) DO UPDATE SET expires=excluded.expires,state='paid'`).bind(accountId,now())];
}
