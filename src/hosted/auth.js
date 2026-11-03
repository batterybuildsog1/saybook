import { captureServer } from "../analytics.js";
import { isInternalEmail } from './internal.js';
import { now, id, random, sha, hex, unhex, encoder, fail, json, body, enabled, safeAccount, NOTICE_VERSION, testRequest, constantEqual, requireCountry } from './util.js';
const COOKIE = '__Host-storybook';
const SESSION_MS = 30 * 86400000;
const ITERATIONS = 100000; // Workers WebCrypto's PBKDF2 iteration ceiling; 256-bit random salt.
const DUMMY_SALT = 'a'.repeat(64);
export async function passwordHash(password, salt, env) {
 if(typeof env.HOSTED_AUTH_PEPPER!=='string'||env.HOSTED_AUTH_PEPPER.length<32) fail(503,'Account security is not configured');
 const pepper=await crypto.subtle.importKey('raw',encoder.encode(env.HOSTED_AUTH_PEPPER),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const protectedPassword=await crypto.subtle.sign('HMAC',pepper,encoder.encode(password));
 const key = await crypto.subtle.importKey('raw', protectedPassword, 'PBKDF2', false, ['deriveBits']);
 return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:unhex(salt),iterations:ITERATIONS,hash:'SHA-256'}, key, 256));
}
function validatePassword(password) {
 if (typeof password !== 'string' || password.length < 8 || password.length > 256) fail(400, 'weak_password');
}
function emailValue(value) {
 if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(400, 'A parent email is required');
 return value.trim().toLowerCase();
}
const cookie = (value, age) => `${COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
export async function session(req, env, includeDeleting = false) {
 const token = (req.headers.get('cookie') || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
 if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
 const row = await env.DB.prepare(`SELECT a.*, s.token_hash, s.parent_until, s.expires FROM hosted_sessions s
 JOIN hosted_accounts a ON a.account_id=s.account_id WHERE s.token_hash=? AND s.expires>?`).bind(await sha(token), now()).first();
 if (!row || (!includeDeleting && row.status !== 'active')) return null;
 if(row.last_active<now()-86400000)await env.DB.prepare('UPDATE hosted_accounts SET last_active=? WHERE account_id=?').bind(now(),row.account_id).run();
 // INTERNAL_EMAILS can change after signup; keep the stored insider tag in step with the rule.
 const internal=isInternalEmail(row.email,env)?1:0;
 if(row.internal!==internal){await env.DB.prepare('UPDATE hosted_accounts SET internal=? WHERE account_id=?').bind(internal,row.account_id).run();row.internal=internal;}
 return row;
}
export async function who(req, env) {
 const a = await session(req, env);
 return a ? { account_id:a.account_id, plan:a.subscription_status, recordings_enabled:!!a.recordings_enabled, child_access:!!a.parent_verified_at, parent_verified_at:a.parent_verified_at } : null;
}
export async function parent(req, env, includeDeleting = false) {
 const a = await session(req, env, includeDeleting);
 if (!a) fail(401, 'Parent sign-in required');
 return a;
}
async function startSession(env, a, status = 200, recoveryCode) {
 const token = random();
 await env.DB.prepare('INSERT INTO hosted_sessions(token_hash,account_id,created,expires,parent_until) VALUES(?,?,?,?,?)')
  .bind(await sha(token), a.account_id, now(), now()+SESSION_MS, 0).run();
 return json({account:safeAccount(a), ...(recoveryCode ? {recovery_code:recoveryCode} : {})},status,{'set-cookie':cookie(token,SESSION_MS/1000)});
}
async function throttle(req, env, email) {
 const bucket = Math.floor(now()/3600000);
 const ip = req.headers.get('cf-connecting-ip') || 'local';
 // A separate network bucket prevents switching guessed email identifiers to evade the limit.
 for (const [scope, limit] of [[`ip:${ip}`,60],[`login:${email}`,15]]) {
  const key = await sha(`${env.HOSTED_AUTH_PEPPER || env.HOSTED_TEST_TOKEN || 'hosted-auth'}:${bucket}:${scope}`);
  const r = await env.DB.prepare(`INSERT INTO hosted_auth_limits(account_id,key_hash,hits,expires) VALUES('',?,1,?)
   ON CONFLICT(key_hash) DO UPDATE SET hits=hits+1 RETURNING hits`).bind(key,now()+3600000).first();
  if (r.hits > limit) fail(429,'Please wait before trying to sign in again');
 }
 await env.DB.prepare('DELETE FROM hosted_auth_limits WHERE expires<?').bind(now()).run();
}
export async function authRoute(req, env, path) {
 if (req.method !== 'POST') return json({error:'not found'},404);
 if (path === '/auth/signup') {
  // No customer account can be created with internal provider keys. This gate precedes parsing/DB writes.
  if (!enabled(env.HOSTED_OPEN) && !testRequest(req,env))
   return json({error:'signup_closed'},403);
  requireCountry(req,env);
  const b = await body(req), email = emailValue(b.email);
  await throttle(req,env,email);
  validatePassword(b.password);
  if (b.parent !== true || b.consent !== true || b.notice_version !== NOTICE_VERSION) fail(400,'A parent or legal guardian must read and accept the current notice');
  if (typeof b.recordings_enabled !== 'undefined' && typeof b.recordings_enabled !== 'boolean') fail(400,'Invalid recording permission');
  const accountId=id(), salt=random(), recoveryCode=random(24), at=now(), internal=isInternalEmail(email,env)?1:0;
  const hash=await passwordHash(b.password,salt,env);
  try {
   await env.DB.batch([
    // The parent's own ticks are the consent (Alan, 2026-11-02: "email and checkbox is fine"): kids can write right away.
    env.DB.prepare(`INSERT INTO hosted_accounts(account_id,email,password_hash,password_salt,recovery_hash,created,consent_version,consent_at,parent_verified_at,recordings_enabled,internal)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(accountId,email,hash,salt,await sha(recoveryCode),at,NOTICE_VERSION,at,at,b.recordings_enabled?1:0,internal),
    env.DB.prepare('INSERT INTO hosted_consent(account_id,id,version,action,at) VALUES(?,?,?,?,?)').bind(accountId,id(),NOTICE_VERSION,'parent_notice_accepted',at),
    env.DB.prepare('UPDATE analytics_population SET signups=signups+1 WHERE id=1 AND ?=0').bind(internal),
   ]);
  } catch(e) { if (/unique/i.test(String(e))) fail(409,'Account could not be created. Try signing in.'); throw e; }
  await env.DB.prepare('INSERT INTO analytics_preferences(account_id,enabled,at) VALUES(?,?,?)').bind(accountId,b.analytics_consent===true?1:0,at).run();
  captureServer(env,'signup_started',{}, {accountId});
  return startSession(env,await env.DB.prepare('SELECT * FROM hosted_accounts WHERE account_id=?').bind(accountId).first(),201,recoveryCode);
 }
 if (path === '/auth/login') {
  const b=await body(req), email=emailValue(b.email);
  await throttle(req,env,email);
  if (typeof b.password !== 'string' || b.password.length > 256) fail(401,'Email or password did not match');
  const a=await env.DB.prepare('SELECT * FROM hosted_accounts WHERE email=?').bind(email).first();
  const actual=await passwordHash(b.password,a?.password_salt || DUMMY_SALT,env);
  if (!a || !constantEqual(actual,a.password_hash)) fail(401,'Email or password did not match');
  return startSession(env,a);
 }
 if (path === '/auth/recover') {
  const b=await body(req),email=emailValue(b.email); await throttle(req,env,email);
  validatePassword(b.password);
  const a=await env.DB.prepare('SELECT * FROM hosted_accounts WHERE email=?').bind(email).first();
  if (!a || typeof b.recovery_code!=='string' || !constantEqual(await sha(b.recovery_code),a.recovery_hash)) fail(401,'Recovery details did not match');
  const salt=random(), recoveryCode=random(24);
  await env.DB.batch([
   env.DB.prepare('UPDATE hosted_accounts SET password_hash=?,password_salt=?,recovery_hash=? WHERE account_id=?').bind(await passwordHash(b.password,salt,env),salt,await sha(recoveryCode),a.account_id),
   env.DB.prepare('DELETE FROM hosted_sessions WHERE account_id=?').bind(a.account_id),
  ]);
  return startSession(env,a,200,recoveryCode);
 }
 if (path === '/auth/logout') {
  const a=await session(req,env,true);
  if (a) await env.DB.prepare('DELETE FROM hosted_sessions WHERE account_id=? AND token_hash=?').bind(a.account_id,a.token_hash).run();
  return new Response(null,{status:204,headers:{'set-cookie':cookie('',0),'cache-control':'no-store'}});
 }
 // Cached clients may still call these endpoints. Account access now follows the
 // normal signed-in session, with no separate parent timer or password recheck.
 if (path === '/auth/parent' || path === '/auth/lock-parent') {
  await parent(req,env,true);
  return json({ok:true});
 }
 return null;
}
