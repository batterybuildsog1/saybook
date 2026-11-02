#!/usr/bin/env node
// Phase-based real Stripe TEST Checkout lifecycle. Synthetic parent state stays in a private file.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const root=path.join(os.homedir(),'.config/saybook'),stateFile=path.join(root,'hosted-real-checkout-state.json');
const phase=process.argv[2]||'start',base=process.env.HOSTED_URL;
if(!base||!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(base))throw Error('Set HOSTED_URL to test Worker');
const token=(await fs.readFile(path.join(root,'hosted-test-token.key'),'utf8')).trim();
const setup=JSON.parse(await fs.readFile(path.join(root,'stripe-test-setup.json'),'utf8'));
const key=(await fs.readFile(path.join(root,'stripe-test.key'),'utf8')).trim();
if(!/^(sk|rk)_test_/.test(key))throw Error('Test key required');
let state;
try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch{state={base,actors:[],started:new Date().toISOString(),checks:[],requests:[]};}
if(state.base!==base)throw Error('State target mismatch');
async function save(){await fs.writeFile(stateFile,JSON.stringify(state,null,2),{mode:0o600});await fs.chmod(stateFile,0o600);}
async function req(a,url,method='GET',data){
 const headers={};if(a?.cookie)headers.cookie=a.cookie;if(method!=='GET'){headers.origin=base;headers['content-type']='application/json';headers['x-hosted-test-token']=token;}
 const r=await fetch(base+url,{method,headers,body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(180000)});
 if(a&&r.headers.get('set-cookie'))a.cookie=r.headers.get('set-cookie').split(';')[0];
 const bytes=Buffer.from(await r.arrayBuffer());let value;try{value=JSON.parse(bytes);}catch{}
 state.requests.push({path:url.split('?')[0],method,status:r.status,bytes:bytes.length,...(value?.error?{error:value.error}:{})});await save();
 if(r.status>=400)throw Error(`${url}: HTTP ${r.status} ${value?.error||''}`);
 return {value,bytes,headers:r.headers,status:r.status};
}
async function stripe(url,method='GET',data){
 const headers={authorization:`Bearer ${key}`,'Stripe-Version':'2026-10-28.endive'};if(data)headers['content-type']='application/x-www-form-urlencoded';
 const r=await fetch(`https://api.stripe.com/v1${url}`,{method,headers,body:data?new URLSearchParams(data):undefined,signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error(`Stripe HTTP ${r.status}`);return r.json();
}
function check(name,passed){if(!passed)throw Error(name);state.checks.push({name,passed:true});}
if(phase==='start'){
 const at=Date.now();
 for(const name of ['a','b']){
  let a=state.actors.find(a=>a.name===name);
  if(!a){a={name,email:`saybook-real-e2e-${at}-${name}@example.invalid`,password:`Parent ${randomBytes(20).toString('hex')}`};
  const b=(await req(a,'/auth/signup','POST',{email:a.email,password:a.password,parent:true,consent:true,notice_version:'2026-11-02',recordings_enabled:false})).value;
  a.id=b.account.account_id;a.recovery=b.recovery_code;state.actors.push(a);await save();
  check(`${name}: signup alone cannot enable child access`,!b.account.child_access);}
  if(a.checkout_url){console.log(JSON.stringify({account:name,checkout_url:a.checkout_url}));continue;}
  const checkout=(await req(a,'/api/billing/checkout','POST',{})).value;
  a.checkout_url=checkout.url;await save();
  console.log(JSON.stringify({account:name,checkout_url:checkout.url}));
 }
 await save();
}else if(phase==='status'){
 const statuses=[];
 for(const a of state.actors){const {value}=await req(a,'/api/account');statuses.push({name:a.name,id:a.id,child_access:value.account.child_access,subscription_status:value.account.subscription_status,parent_verified_at:value.account.parent_verified_at});}
 console.log(JSON.stringify(statuses,null,2));
}else if(phase==='verify'){
 for(const a of state.actors){
  const {value}=await req(a,'/api/account');check(`${a.name}: signed live TEST webhook enables parent-verified child access`,value.account.child_access&&value.account.subscription_status==='active');
  const {value:portal}=await req(a,'/api/billing/portal','POST',{});check(`${a.name}: billing portal opens for scoped customer`,portal.url.startsWith('https://billing.stripe.com/'));
  const text=`A quiet blue boat carried a paper star across a little pond. At sunset it floated safely beside a lily pad.`;
  a.story=(await req(a,'/api/stories','POST',{author:`Test writer ${a.name}`,text,title:'The paper star'})).value.id;
 }
 const A=state.actors[0],B=state.actors[1];
 // Use raw fetch for expected denials, never hide them behind successful-response helpers.
 const forbidden=await fetch(`${base}/api/stories/${A.story}`,{headers:{cookie:B.cookie}});check('real paid parent B cannot read parent A story',forbidden.status===404);
 const upload=await fetch(`${base}/api/upload?story=${A.story}`,{method:'POST',headers:{cookie:B.cookie,origin:base,'content-type':'image/png'},body:Buffer.from('blocked')});check('real paid parent B cannot upload to parent A story',upload.status===404);
 for(const a of state.actors){
  await req(a,'/api/billing/cancel','POST',{});
  const local=(await req(a,'/api/account')).value;check(`${a.name}: parent cancellation schedules end of paid period`,local.account.cancel_at_period_end===true);
  const customers=await stripe(`/customers?email=${encodeURIComponent(a.email)}&limit=2`);
  const c=customers.data.find(c=>c.metadata?.account_id===a.id);if(!c)throw Error('Scoped Stripe customer not found');
  a.stripe_customer_id=c.id;
  const subscriptions=await stripe(`/subscriptions?customer=${c.id}&status=all&limit=10`);const sub=subscriptions.data.find(s=>s.metadata?.account_id===a.id);if(!sub)throw Error('Scoped Stripe subscription not found');
  a.stripe_subscription_id=sub.id;
  check(`${a.name}: Stripe confirms TEST subscription and period-end cancellation`,sub.livemode===false&&sub.cancel_at_period_end===true);
  const sessions=await stripe(`/checkout/sessions?customer=${c.id}&limit=10`);const session=sessions.data.find(s=>s.client_reference_id===a.id&&s.payment_status==='paid');
  check(`${a.name}: Stripe confirms actual paid Checkout at 1950 cents`,!!session&&session.amount_total===1950&&session.mode==='subscription');
  state.checks.push({name:`${a.name}: paid Stripe evidence`,passed:true,checkout_id:session.id,subscription_id:sub.id,customer_id:c.id,paid:session.amount_total,currency:session.currency,livemode:session.livemode});
  const exported=await req(a,'/api/account/export','POST',{});check(`${a.name}: export completes`,exported.bytes.toString().includes('"type":"complete"'));
  await req(a,'/api/account','DELETE',{confirmation:'DELETE'});a.deleted=true;await save();
  const after=await stripe(`/subscriptions/${sub.id}`);check(`${a.name}: deletion cancels actual Stripe test subscription`,after.status==='canceled');
  const denied=await fetch(base+'/api/stories',{headers:{cookie:a.cookie}});check(`${a.name}: deletion revokes session`,denied.status===401);
 }
 state.finished=new Date().toISOString();await save();
 const out=path.resolve('e2e/out-hosted',new Date().toISOString().replace(/[:.]/g,'-')+'-stripe-test');await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'stripe-checkout-report.json'),JSON.stringify({passed:true,url:base,started:state.started,finished:state.finished,billing:'real Stripe TEST Checkout with 4242 card; actual signed webhooks; no real-money charge',checks:state.checks,requests:state.requests,limitations:['Test card cannot establish notification delivery to a real primary card account holder. Live receipts and cardholder notifications still need operator verification.','Provider book/image/TTS lifecycle separately proven by hosted fixture E2E; this payment rerun does not repeat hub generation.']},null,2));
 console.log(JSON.stringify({passed:true,checks:state.checks.length,artifact:path.join(out,'stripe-checkout-report.json')}));
}else if(phase==='cleanup'){
 for(const a of state.actors){if(a.deleted)continue;try{await req(a,'/api/account','DELETE',{confirmation:'DELETE'});a.deleted=true;await save();}catch(e){console.log(JSON.stringify({account:a.name,cleanup:'retry_required',error:e.message}));}}
 await save();
}else throw Error('Unknown phase');
