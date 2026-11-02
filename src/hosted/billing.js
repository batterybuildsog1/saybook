import { reserveEnrollment, enrollmentUpdate, PAINTING_NOTICE } from './enrollment.js';
import { now, encoder, hex, constantEqual, fail, json, enabled, testRequest, NOTICE_VERSION, requireCountry } from './util.js';
const STRIPE_BASE='https://api.stripe.com/v1';
const STRIPE_VERSION='2026-10-28.endive';
const CONSENT_TEXT='By paying, you confirm you are the parent or legal guardian and consent to Saybook collecting and using your child’s stories, images and temporary dictation audio as described in the parent notice. Saved voice recordings and public sharing are optional and off unless you enable them. HVAC Calc LLC operates Saybook. You can withdraw consent and delete the account in Parent settings.';
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
 if(!res.ok) fail(502,'Stripe could not complete this request. Please try again.');
 return res.json();
}
function validPrice(price,env) {
 return price?.id===env.STRIPE_PRICE_ID && price.active!==false && price.currency==='usd' && price.unit_amount===1950 &&
 price.recurring?.interval==='month' && (price.recurring.interval_count??1)===1 && price.livemode===stripeMode(env);
}
export async function billingRoute(req,env,a,path) {
 if(req.method!=='POST') fail(405,'Use POST');
 if(path==='/api/billing/checkout') {
  requireCountry(req,env);
  if(a.subscription_status==='active'&&a.subscription_end>now()) fail(409,'Use billing settings to manage your existing subscription');
  if(!/^price_[A-Za-z0-9_]+$/.test(env.STRIPE_PRICE_ID||'')) fail(503,'Set the USD 19.50 monthly Stripe price before checkout');
  const price=await stripe(env,`/prices/${env.STRIPE_PRICE_ID}`);
  if(!validPrice(price,env)) fail(503,'Stripe price must be USD 19.50 per month, with the matching test/live mode');
  let customer=a.stripe_customer_id;
  if(!customer) {
   const created=await stripe(env,'/customers','POST',{'email':a.email,'metadata[account_id]':a.account_id,'invoice_settings[footer]':`Saybook parental consent: this subscription payment records your consent to the parent notice (${NOTICE_VERSION}). Review or withdraw consent at https://saybook.app/account/. HVAC Calc LLC.`},`storybook-customer-${a.account_id}`);
   customer=created.id;
   await env.DB.prepare('UPDATE hosted_accounts SET stripe_customer_id=? WHERE account_id=? AND status=\'active\'').bind(customer,a.account_id).run();
  }
  if(!await reserveEnrollment(env,a.account_id))fail(409,'waitlist_only');
  const origin=new URL(req.url).origin;
  const checkout=await stripe(env,'/checkout/sessions','POST',{
   mode:'subscription',customer,client_reference_id:a.account_id,
   'line_items[0][price]':env.STRIPE_PRICE_ID,'line_items[0][quantity]':'1',
   'subscription_data[metadata][account_id]':a.account_id,'metadata[account_id]':a.account_id,
   'metadata[consent_version]':NOTICE_VERSION,'subscription_data[metadata][consent_version]':NOTICE_VERSION,
   'custom_text[submit][message]':CONSENT_TEXT+' '+PAINTING_NOTICE,
   'expires_at':String(Math.floor(now()/1000)+1800),
   'subscription_data[description]':`Saybook parent subscription; parental consent notice ${NOTICE_VERSION}`,
   success_url:`${origin}/account/?checkout=done`,cancel_url:`${origin}/account/`,
   'allowed_payment_method_types[0]':'card',
  },`storybook-checkout-${a.account_id}-${Math.floor(now()/1800000)}`);
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
 const price=item?.price;
 const correctPrice=validPrice(price,env)&&subscription.items.data.length===1&&(item.quantity??1)===1;
 const status=correctPrice?subscription.status:'invalid_price';
 const end=(subscription.current_period_end||item?.current_period_end||0)*1000;
 const customer=objectId(subscription.customer);
 if(!customer||!/^cus_[A-Za-z0-9_]+$/.test(customer)||!Number.isFinite(end)) fail(400,'Invalid subscription');
 const paidConsent=event.type==='checkout.session.completed'&&object.mode==='subscription'&&object.status==='complete'&&object.payment_status==='paid'
  &&object.amount_total>=1950&&object.currency==='usd'&&object.client_reference_id===accountId
  &&object.metadata?.account_id===accountId&&object.metadata?.consent_version===a.consent_version
  &&objectId(object.customer)===customer&&correctPrice&&a.consent_at>0
  &&(!env.HOSTED_ALLOWED_COUNTRY||object.customer_details?.address?.country===env.HOSTED_ALLOWED_COUNTRY);
 const recorded=await env.DB.prepare('SELECT event_id FROM hosted_stripe_events WHERE account_id=? AND event_id=?').bind(accountId,event.id).first();
 if(recorded) return json({received:true,duplicate:true});
 // Atomic update + dedupe. Older events cannot resurrect access. A canceled subscription stays canceled at equal timestamps.
 const updates=[
  env.DB.prepare(`UPDATE hosted_accounts SET stripe_customer_id=?,stripe_subscription_id=?,subscription_status=?,subscription_end=?,
   stripe_event_at=?,cancel_at_period_end=? WHERE account_id=? AND status='active' AND stripe_event_at<=?
   AND NOT(stripe_event_at=? AND subscription_status='canceled' AND stripe_subscription_id=?)
   AND NOT EXISTS(SELECT 1 FROM hosted_stripe_events WHERE account_id=? AND event_id=?)`)
   .bind(customer,subscription.id,status,end,event.created,subscription.cancel_at_period_end?1:0,accountId,event.created,event.created,subscription.id,accountId,event.id),
 ];
 if(paidConsent) {
  updates.push(env.DB.prepare(`UPDATE hosted_accounts SET parent_verified_at=CASE WHEN parent_verified_at=0 THEN ? ELSE parent_verified_at END,consent_checkout_id=COALESCE(consent_checkout_id,?) WHERE account_id=? AND status='active'`).bind(now(),object.id,accountId));
  updates.push(env.DB.prepare(`INSERT OR IGNORE INTO hosted_consent(account_id,id,version,action,at) VALUES(?,?,?,?,?)`).bind(accountId,event.id,a.consent_version,'paid_checkout_parental_consent',now()));
 }
 updates.push(...enrollmentUpdate(env,accountId));
 updates.push(env.DB.prepare('INSERT OR IGNORE INTO hosted_stripe_events(account_id,event_id,at,type) VALUES(?,?,?,?)').bind(accountId,event.id,now(),event.type));
 await env.DB.batch(updates);
 return json({received:true,fixture});
}
export async function cancelForDeletion(req,env,a) {
 if(!a.stripe_subscription_id||['none','canceled','incomplete_expired'].includes(a.subscription_status)) return;
 if(a.stripe_subscription_id.startsWith('sub_fixture_')&&(req?testRequest(req,env):enabled(env.HOSTED_TEST_MODE))) return;
 await stripe(env,`/subscriptions/${encodeURIComponent(a.stripe_subscription_id)}`,'DELETE',null,`storybook-delete-${a.account_id}`);
}
