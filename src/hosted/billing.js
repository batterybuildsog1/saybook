import { captureServer } from "../analytics.js";
import { now, encoder, hex, sha, constantEqual, fail, json, body, enabled, testRequest, requireCountry } from './util.js';
const STRIPE_BASE='https://api.stripe.com/v1';
const STRIPE_VERSION='2026-10-28.endive';
// Two plans after the free books (Alan, 2026-11-02: "annually or monthly 40% annual discount"). Same monthly allowance.
// Price IDs are config; each must match its amount and interval exactly or checkout refuses.
const PLANS={
 monthly:{price:'STRIPE_PRICE_ID',cents:1950,interval:'month',terms:'Saybook renews at $19.50 every month until you cancel.'},
 annual:{price:'STRIPE_ANNUAL_PRICE_ID',cents:14040,interval:'year',terms:'Saybook renews at $140.40 every year until you cancel.'},
};
const REFUND_TEXT='Charges are non-refundable except where the law requires. Cancel renewal any time from your Account page. Sold by HVAC Calc LLC.';
const objectId = value => typeof value==='string'?value:value?.id;
function stripeMode(env) {
 const live=env.STRIPE_MODE==='live';
 if(!live && env.STRIPE_MODE && env.STRIPE_MODE!=='test') fail(503,'Invalid Stripe mode');
 return live;
}
export async function stripe(env,path,method='GET',params=null,idempotencyKey=null) {
 const live=stripeMode(env), key=env.STRIPE_SECRET_KEY;
 if(typeof key!=='string'||!new RegExp(live?'^(sk|rk)_live_':'^(sk|rk)_test_').test(key)) fail(503,'Stripe is not configured for this mode');
 const headers={authorization:`Bearer ${key}`,'Stripe-Version':STRIPE_VERSION};
 if(params) headers['content-type']='application/x-www-form-urlencoded';
 if(idempotencyKey) headers['Idempotency-Key']=idempotencyKey;
 const res=await fetch(`${STRIPE_BASE}${path}`,{method,headers,body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(20000)});
 if(!res.ok) {
  // Stripe's error type/code (never the key or body) so a failing call can be diagnosed from the Worker log.
  const detail=await res.json().catch(()=>null);
  console.warn('stripe',method,path.split('?')[0],res.status,detail?.error?.type||'',detail?.error?.code||'');
  const e=new Error('Stripe could not complete this request. Please try again.');e.status=502;e.stripeStatus=res.status;throw e;
 }
 return res.json();
}
// 'monthly' | 'annual' when the price is exactly one of the configured plans in this Stripe mode, else null.
function planOf(price,env) {
 for(const [plan,p] of Object.entries(PLANS))
  if(price?.id&&price.id===env[p.price]&&price.active!==false&&price.currency==='usd'&&price.unit_amount===p.cents&&
   price.recurring?.interval===p.interval&&(price.recurring.interval_count??1)===1&&price.livemode===stripeMode(env)) return plan;
 return null;
}
export async function billingRoute(req,env,a,path) {
 if(req.method!=='POST') fail(405,'Use POST');
 if(path==='/api/billing/checkout') {
  requireCountry(req,env);
  if(a.subscription_status==='active'&&a.subscription_end>now()) fail(409,'Use billing settings to manage your existing subscription');
  const {plan}=await body(req);
  if(!Object.hasOwn(PLANS,plan||'')) fail(400,'Choose monthly or annual');
  const priceId=env[PLANS[plan].price];
  if(!/^price_[A-Za-z0-9_]+$/.test(priceId||'')) fail(503,`Set the ${plan} Stripe price before checkout`);
  if(planOf(await stripe(env,`/prices/${priceId}`),env)!==plan) fail(503,`The ${plan} Stripe price does not match its plan or Stripe mode`);
  let customer=a.stripe_customer_id;
  if(!customer) {
   const created=await stripe(env,'/customers','POST',{'email':a.email,'metadata[account_id]':a.account_id},`storybook-customer-${a.account_id}`);
   customer=created.id;
   await env.DB.prepare('UPDATE hosted_accounts SET stripe_customer_id=? WHERE account_id=? AND status=\'active\'').bind(customer,a.account_id).run();
  }
  const origin=new URL(req.url).origin,success_url=`${origin}/account/?checkout=done`;
  // A parent who backs out and presses "Continue to payment" again gets the same open session for the same plan.
  // Every other open session of this family's customer (other plan, other origin, nearly expired) is expired first,
  // so only one Checkout can ever be paid.
  let checkout=null;
  const open=await stripe(env,`/checkout/sessions?customer=${encodeURIComponent(customer)}&status=open&limit=10&expand%5B%5D=data.line_items`);
  for(const s of open.data||[]) {
   const items=s.line_items?.data||[];
   const same=s.metadata?.account_id===a.account_id&&objectId(s.customer)===customer&&s.mode==='subscription'&&
    items.length===1&&items[0].price?.id===priceId&&s.success_url===success_url&&typeof s.url==='string'&&s.expires_at*1000>now()+600000;
   if(same&&!checkout) checkout=s;
   else await stripe(env,`/checkout/sessions/${encodeURIComponent(s.id)}/expire`,'POST',{});
  }
  if(!checkout) {
   const params={
    mode:'subscription',customer,client_reference_id:a.account_id,
    'line_items[0][price]':priceId,'line_items[0][quantity]':'1',
    'subscription_data[metadata][account_id]':a.account_id,'metadata[account_id]':a.account_id,
    'custom_text[submit][message]':`${PLANS[plan].terms} ${REFUND_TEXT}`,
    'expires_at':String(Math.floor(now()/1000)+1800),
    success_url,cancel_url:`${origin}/account/`,
    'allowed_payment_method_types[0]':'card',
   };
   // The key covers every parameter, so a replay is always the identical request (Stripe rejects a key reused with different ones).
   checkout=await stripe(env,'/checkout/sessions','POST',params,`storybook-checkout-${a.account_id}-${await sha(JSON.stringify(params))}`);
  }
  captureServer(env,'checkout_started',{}, {accountId:a.account_id,object:checkout.id});
  return json({url:checkout.url,mode:stripeMode(env)?'live':'test'});
 }
 if(path==='/api/billing/portal') {
  if(!a.stripe_customer_id) fail(409,'There is no billing account yet');
  const portal=await stripe(env,'/billing_portal/sessions','POST',{customer:a.stripe_customer_id,...(env.STRIPE_PORTAL_CONFIGURATION_ID?{configuration:env.STRIPE_PORTAL_CONFIGURATION_ID}:{}),return_url:`${new URL(req.url).origin}/account/`});
  return json({url:portal.url});
 }
 if(path==='/api/billing/cancel') {
  if(!a.stripe_subscription_id) fail(409,'There is no subscription to cancel');
  if(a.stripe_subscription_id.startsWith('sub_fixture_')&&testRequest(req,env)) {
   await env.DB.prepare("UPDATE hosted_accounts SET subscription_status='canceled',subscription_end=0,cancel_at_period_end=0 WHERE account_id=?").bind(a.account_id).run();
   return json({ok:true,fixture:true});
  }
  await stripe(env,`/subscriptions/${encodeURIComponent(a.stripe_subscription_id)}`,'POST',{cancel_at_period_end:'true'},`storybook-cancel-${a.account_id}-${a.stripe_subscription_id}`);
  await env.DB.prepare('UPDATE hosted_accounts SET cancel_at_period_end=1 WHERE account_id=?').bind(a.account_id).run();
  captureServer(env,'subscription_canceled',{}, {accountId:a.account_id,object:a.stripe_subscription_id});
  return json({ok:true,cancel_at_period_end:true});
 }
 fail(404,'not found');
}
export async function verifySignature(raw,header,secret,at=Math.floor(now()/1000)) {
 if(typeof secret!=='string'||!secret.startsWith('whsec_')) return false;
 const parts=String(header||'').split(',').map(x=>x.trim().split('='));
 const timestamps=parts.filter(([k])=>k==='t').map(([,v])=>v),signatures=parts.filter(([k])=>k==='v1').map(([,v])=>v);
 if(timestamps.length!==1||!/^\d+$/.test(timestamps[0])) return false;
 const timestamp=Number(timestamps[0]); if(!Number.isSafeInteger(timestamp)||Math.abs(at-timestamp)>300) return false;
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const expected=hex(await crypto.subtle.sign('HMAC',key,encoder.encode(`${timestamp}.${raw}`)));
 return signatures.some(sig=>/^[a-f0-9]{64}$/.test(sig)&&constantEqual(sig,expected));
}
async function rawPayload(req) {
 // Read exact bytes as UTF-8 once. Re-serializing parsed JSON breaks Stripe signatures.
 if(Number(req.headers.get('content-length'))>262144) fail(413,'Webhook too large');
 const reader=req.body?.getReader(); if(!reader) fail(400,'Missing webhook');
 let total=0;const chunks=[];
 for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>262144){await reader.cancel();fail(413,'Webhook too large');}chunks.push(value);}
 const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export async function webhook(req,env) {
 if(req.method!=='POST') fail(405,'Use POST');
 const raw=await rawPayload(req);
 if(!await verifySignature(raw,req.headers.get('stripe-signature'),env.STRIPE_WEBHOOK_SECRET)) fail(400,'Invalid Stripe signature');
 let event;try{event=JSON.parse(raw);}catch{fail(400,'Invalid webhook JSON');}
 if(!/^evt_[A-Za-z0-9_]+$/.test(event.id||'')||!Number.isInteger(event.created)||event.livemode!==stripeMode(env)) fail(400,'Invalid Stripe event or mode');
 const allowed=['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','checkout.session.completed','invoice.paid','invoice.payment_failed'];
 if(!allowed.includes(event.type)) return json({received:true,ignored:true});
 let object=event.data?.object;
 if(!object) fail(400,'Missing Stripe object');
 const fixture=enabled(env.STRIPE_TEST_FIXTURES)&&testRequest(req,env)&&!stripeMode(env);
 if(event.type==='checkout.session.completed'&&!fixture) object=await stripe(env,`/checkout/sessions/${encodeURIComponent(object.id)}?expand%5B%5D=subscription`);
 let subscription;
 if(event.type.startsWith('customer.subscription.')) subscription=object;
 else {
  const sid=objectId(object.subscription)||objectId(object.parent?.subscription_details?.subscription);
  if(!sid) return json({received:true,ignored:true});
  subscription=typeof object.subscription==='object'?object.subscription:{id:sid};
 }
 // Real deliveries always re-read current Stripe state: webhook delivery order is not state order.
 if(!fixture) subscription=await stripe(env,`/subscriptions/${encodeURIComponent(subscription.id)}`);
 else if(!String(subscription.id).startsWith('sub_fixture_')) fail(400,'Fixture subscription required');
 const accountId=subscription.metadata?.account_id;
 if(typeof accountId!=='string') return json({received:true,ignored:true});
 const a=await env.DB.prepare('SELECT * FROM hosted_accounts WHERE account_id=?').bind(accountId).first();
 if(!a||a.status!=='active') return json({received:true,ignored:true});
 if(!fixture && (!a.stripe_customer_id||objectId(subscription.customer)!==a.stripe_customer_id)) fail(400,'Subscription customer mismatch');
 if(fixture && a.stripe_customer_id && a.stripe_customer_id!==objectId(subscription.customer)) fail(400,'Fixture customer mismatch');
 const item=subscription.items?.data?.[0];
 const plan=subscription.items?.data?.length===1&&(item.quantity??1)===1?planOf(item.price,env):null;
 const status=plan?subscription.status:'invalid_price';
 // The Portal cancels by setting cancel_at (cancel_at_period_end stays false). Either one means the plan ends,
 // and it ends at cancel_at when set. Removing cancel_at (resubscribe in the Portal) clears both.
 const cancelAt=Number.isSafeInteger(subscription.cancel_at)&&subscription.cancel_at>0?subscription.cancel_at*1000:0;
 const ending=!!subscription.cancel_at_period_end||cancelAt>0;
 const end=cancelAt||(subscription.current_period_end||item?.current_period_end||0)*1000;
 const customer=objectId(subscription.customer);
 if(!customer||!/^cus_[A-Za-z0-9_]+$/.test(customer)||!Number.isFinite(end)) fail(400,'Invalid subscription');
 const recorded=await env.DB.prepare('SELECT event_id FROM hosted_stripe_events WHERE account_id=? AND event_id=?').bind(accountId,event.id).first();
 if(recorded) return json({received:true,duplicate:true});
 // Atomic update + dedupe. Older events cannot resurrect access. A canceled subscription stays canceled at equal timestamps.
 await env.DB.batch([
  env.DB.prepare(`UPDATE hosted_accounts SET stripe_customer_id=?,stripe_subscription_id=?,subscription_status=?,subscription_end=?,
   stripe_event_at=?,cancel_at_period_end=?,billing_plan=? WHERE account_id=? AND status='active' AND stripe_event_at<=?
   AND NOT(stripe_event_at=? AND subscription_status='canceled' AND stripe_subscription_id=?)
   AND NOT EXISTS(SELECT 1 FROM hosted_stripe_events WHERE account_id=? AND event_id=?)`)
   .bind(customer,subscription.id,status,end,event.created,ending?1:0,plan||'',accountId,event.created,event.created,subscription.id,accountId,event.id),
  env.DB.prepare('INSERT OR IGNORE INTO hosted_stripe_events(account_id,event_id,at,type) VALUES(?,?,?,?)').bind(accountId,event.id,now(),event.type),
 ]);
 if(event.type==='checkout.session.completed'&&status==='active')captureServer(env,'subscribed',{}, {accountId});
 if(status==='canceled'||ending)captureServer(env,'subscription_canceled',{}, {accountId,object:subscription.id});
 return json({received:true,fixture});
}
export async function cancelForDeletion(req,env,a) {
 if(!a.stripe_subscription_id||['none','canceled','incomplete_expired'].includes(a.subscription_status)) return;
 if(a.stripe_subscription_id.startsWith('sub_fixture_')&&(req?testRequest(req,env):enabled(env.HOSTED_TEST_MODE))) return;
 await stripe(env,`/subscriptions/${encodeURIComponent(a.stripe_subscription_id)}`,'DELETE',null,`storybook-delete-${a.account_id}`);
}
// Account deletion removes the family's Stripe customer too (its email and saved card), never another account's.
export async function deleteCustomerForDeletion(req,env,a) {
 const id=a.stripe_customer_id;
 if(!id) return;
 if(id.startsWith('cus_fixture_')&&(req?testRequest(req,env):enabled(env.HOSTED_TEST_MODE))) return;
 let customer;
 try {customer=await stripe(env,`/customers/${encodeURIComponent(id)}`);}
 catch(e) {if(e.stripeStatus===404) return; throw e;}
 if(customer.deleted) return;
 // Checkout created this customer with this account's id. Anything else is not ours to delete.
 if(customer.metadata?.account_id!==a.account_id) {console.warn('stripe customer not deleted: account mismatch',id);return;}
 await stripe(env,`/customers/${encodeURIComponent(id)}`,'DELETE');
}
