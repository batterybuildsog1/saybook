import { captureServer } from "../analytics.js";
// Loaded only by src/tenant.js in MODE=hosted. No third-party login, billing SDK, or global mutable request state.
import { json, sameOrigin, fail } from './util.js';
import { authRoute, parent, session } from './auth.js';
import { webhook, billingRoute } from './billing.js';
import { accountRoute } from './accounts.js';
import { usageResponse } from './usage.js';
export { who, parent } from './auth.js';
export { allow, charge, finish, providerLimit } from './usage.js';
export { bookGate } from './books.js';
export async function route(req,env,ctx) {
 if(env.MODE!=='hosted')return null;
 const url=new URL(req.url),p=url.pathname;
 if(!p.startsWith('/auth/')&&!/^\/api\/(account|billing)(\/|$)/.test(p))return null;
 try {
  if(p==='/api/billing/webhook')return await webhook(req,env);
  sameOrigin(req);
  if(p.startsWith('/auth/'))return await authRoute(req,env,p)||json({error:'not found'},404);
  const a=await parent(req,env,p==='/api/account'&&req.method==='DELETE');
  env.account_id=a.account_id;
  if(p==='/api/account/usage'||p==='/api/account/ledger') {
   if(req.method!=='GET')fail(405,'Use GET');
   return await usageResponse(req,env,a,url);
  }
  if(p.startsWith('/api/account'))return await accountRoute(req,env,a,url);
  return await billingRoute(req,env,a,p);
 }catch(e){
  if(env.account_id)captureServer(env,'error',{operation:'request',status:e.status||500,error_code:e.status>=500?'provider':'validation',ok:false},{object:crypto.randomUUID()});
  // Never echo Stripe/provider responses or credentials, including into Worker logs.
  return json({error:e.status?e.message:'Hosted request failed. Please try again.'},e.status||500);
 }
}
export { scheduled } from './retention.js';
