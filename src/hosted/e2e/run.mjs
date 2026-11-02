#!/usr/bin/env node
// HTTP E2E against the deployed Worker. Real D1/R2/queue and bounded provider work; no module mocks.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,createHash} from 'node:crypto';
const base=process.env.HOSTED_URL;
if(!base)throw Error('Set HOSTED_URL to your hosted test Worker URL');
if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(base)&&!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)&&!(base==='https://saybook.app'&&process.env.HOSTED_PRODUCTION_FIXTURES==='true'))throw Error('Refusing unexpected E2E target');
const secrets=path.join(os.homedir(),'.config/saybook');
const testToken=(await fs.readFile(process.env.HOSTED_TOKEN_FILE||path.join(secrets,'hosted-test-token.key'),'utf8')).trim();
const webhookSecret=(await fs.readFile(process.env.HOSTED_WEBHOOK_FILE||path.join(secrets,'hosted-fixture-webhook.key'),'utf8')).trim();
const price=process.env.STRIPE_PRICE_ID||'price_fixture_monthly';
const at=new Date().toISOString().replace(/[:.]/g,'-'),out=path.resolve('e2e/out-hosted',at);await fs.mkdir(out,{recursive:true});
const report={started:new Date().toISOString(),url:base,billing:'documented Stripe snapshots + HMAC signatures; no real Stripe account/key',checks:[],requests:[],provider_work:[],accounts:[],limitations:[]};
const actors=[];let sequence=0,eventClock=Math.floor(Date.now()/1000),hubStopped=false;
function check(name,condition,detail){assert.ok(condition,name);report.checks.push({name,passed:true,...(detail?{detail}:{})});}
async function req(actor,url,{method='GET',data,raw,headers={},internal=false}={}) {
 const h={...headers};if(actor?.cookie)h.cookie=actor.cookie;
 if(!['GET','HEAD'].includes(method)&&!h.origin)h.origin=base;
 if(internal)h['x-hosted-test-token']=testToken;
 let body=raw;if(data!==undefined){h['content-type']='application/json';body=JSON.stringify(data);}
 const start=Date.now(),res=await fetch(base+url,{method,headers:h,body,signal:AbortSignal.timeout(180000)});
 const set=res.headers.get('set-cookie');if(set&&actor)actor.cookie=set.split(';')[0];
 const bytes=Buffer.from(await res.arrayBuffer());let value;
 try{value=JSON.parse(bytes.toString());}catch{value=null;}
 report.requests.push({path:url.split('?')[0],method,status:res.status,ms:Date.now()-start,bytes:bytes.length,...(value?.error?{error:value.error}:{}),...(value?.reason?{reason:value.reason}:{})});
 if(value?.reason==='provider_limit'||(res.status===429&&url!=='/auth/login'))hubStopped=true;
 return {status:res.status,value,bytes,headers:res.headers};
}
function ok(r,status=200){assert.equal(r.status,status,`HTTP ${r.status}: ${r.value?.error||'unexpected status'}`);return r.value;}
async function signup(name){
 const a={name,email:`saybook-e2e-${at.toLowerCase()}-${name}@example.invalid`,password:`Parent ${randomBytes(20).toString('hex')}`,cookie:''};
 const r=await req(a,'/auth/signup',{method:'POST',internal:true,data:{email:a.email,password:a.password,consent:true,parent:true,notice_version:'2026-11-02',recordings_enabled:false}});
 const b=ok(r,201);a.id=b.account.account_id;a.recovery=b.recovery_code;actors.push(a);report.accounts.push({name,id:a.id});
 check(`${name} signup records consent without child access`,!b.account.child_access&&b.account.consent_version==='2026-11-02'&&typeof a.recovery==='string');
 return a;
}
function sub(a,status='active'){
 return {id:`sub_fixture_${a.id.replaceAll('-','')}`,object:'subscription',customer:`cus_fixture_${a.id.replaceAll('-','')}`,status,metadata:{account_id:a.id,consent_version:'2026-11-02'},current_period_end:Math.floor(Date.now()/1000)+30*86400,cancel_at_period_end:false,
 items:{object:'list',data:[{id:'si_fixture',object:'subscription_item',quantity:1,current_period_end:Math.floor(Date.now()/1000)+30*86400,price:{id:price,object:'price',active:true,livemode:false,currency:'usd',unit_amount:1950,recurring:{interval:'month',interval_count:1}}}]}};
}
function event(type,object,created=++eventClock){return {id:`evt_fixture_${at.replaceAll('-','')}_${++sequence}`,object:'event',api_version:'2026-10-28.endive',created,livemode:false,type,data:{object}};}
async function webhook(e,{bad=false,stale=false}={}){
 const raw=JSON.stringify(e),timestamp=Math.floor(Date.now()/1000)-(stale?600:0);
 const signature=createHmac('sha256',webhookSecret).update(`${timestamp}.${raw}`).digest('hex');
 return req(null,'/api/billing/webhook',{method:'POST',raw,internal:true,headers:{'content-type':'application/json','stripe-signature':`t=${timestamp},v1=${bad?'0'.repeat(64):signature}`}});
}
function checkout(a,{paid=true,country='US'}={}){return {id:`cs_test_fixture_${a.id.replaceAll('-','')}`,object:'checkout.session',mode:'subscription',status:'complete',payment_status:paid?'paid':'unpaid',amount_total:1950,currency:'usd',customer_details:{address:{country}},customer:sub(a).customer,subscription:sub(a),client_reference_id:a.id,metadata:{account_id:a.id,consent_version:'2026-11-02'}};}
async function paidConsent(a){
 ok(await webhook(event('customer.subscription.created',sub(a))));
 check(`${a.name} subscription status alone cannot enable child data`,!ok(await req(a,'/api/account')).account.child_access);
 ok(await webhook(event('checkout.session.completed',checkout(a,{paid:false}))));
 check(`${a.name} unpaid Checkout cannot enable child data`,!ok(await req(a,'/api/account')).account.child_access);
 if(process.env.HOSTED_COUNTRY_CHECKS==='true') for(const country of ['CA',null]) {
  ok(await webhook(event('checkout.session.completed',checkout(a,{country}))));
  check(`${a.name} foreign or missing billing country cannot enable child data (${country})`,!ok(await req(a,'/api/account')).account.child_access);
 }
 const e=event('checkout.session.completed',checkout(a));ok(await webhook(e));
 check(`${a.name} paid signed Checkout enables child access`,ok(await req(a,'/api/account')).account.child_access);
 check(`${a.name} webhook replay is idempotent`,ok(await webhook(e)).duplicate===true);
}
async function spend(a,kind,usd,units={},extra={}){return req(a,'/api/account/test/spend',{method:'POST',internal:true,data:{kind,usd,units,...extra}});}
async function cleanup(a){
 if(a.deleted)return;
 let r=await req(a,'/api/account',{method:'DELETE',internal:true,data:{confirmation:'DELETE'}});
 if(r.status===403){ok(await req(a,'/auth/parent',{method:'POST',data:{password:a.password}}));r=await req(a,'/api/account',{method:'DELETE',internal:true,data:{confirmation:'DELETE'}});}
 if(r.status===204)a.deleted=true;
 return r;
}
try {
 check('health identifies hosted Worker',ok(await req(null,'/health')).mode==='hosted');
 check('public signup remains closed during test', (await req(null,'/auth/signup',{method:'POST',data:{}})).status===403);
 const A=await signup('a'),B=await signup('b');
 for(const [route,data] of [['/api/stories',{author:'Not collected',text:'Blocked'}],['/api/upload',{}],['/api/stt',{}],['/api/chat',{messages:[]}],['/api/account/profiles',{name:'Blocked'}]]) {
  const r=await req(A,route,{method:'POST',data});check(`prepayment blocks ${route}`,r.status===403&&r.value.error==='parental_consent_required');
 }
 const before=ok(await req(A,'/api/account'));
 const fake=event('customer.subscription.created',sub(A));
 check('bad Stripe signature rejected',(await webhook(fake,{bad:true})).status===400);
 check('old Stripe signature rejected',(await webhook(fake,{stale:true})).status===400);
 check('invalid webhooks do not change subscription',ok(await req(A,'/api/account')).account.plan===before.account.plan);
 await paidConsent(A);await paidConsent(B);
 const waitEmail=`saybook-e2e-wait-${at.toLowerCase()}@example.invalid`;
 const full=await req(null,'/auth/signup',{method:'POST',internal:true,headers:{'x-hosted-test-max-accounts':'1'},data:{email:waitEmail}});
 check('full paid cohort becomes email-only waitlist without account or payment',full.status===202&&full.value.waitlisted===true);
 check('waitlist stores only the synthetic email and can be cleaned',ok(await req(A,'/api/account/test/waitlist',{method:'DELETE',internal:true,data:{email:waitEmail}})).deleted===true);

 ok(await req(A,'/api/account/profiles',{method:'POST',data:{name:'Writer A',color:'#92734d'}}),201);
 ok(await req(B,'/api/account/profiles',{method:'POST',data:{name:'Writer B',color:'#53817a'}}),201);
 check('writer profiles use the same settings rows',JSON.stringify(ok(await req(A,'/api/settings')).writers).includes('Writer A'));
 check('profiles cannot be selected by another account id',!JSON.stringify(ok(await req(B,`/api/account/profiles?account_id=${A.id}`))).includes('Writer A'));
 check('saved child voice recording starts disabled',(await req(A,`/api/stories/nonexistent/narration`,{method:'POST',raw:Buffer.from('blocked'),headers:{'content-type':'audio/wav'}})).status===403);
 const text='A small blue boat floated across a quiet pond. Its paper flag fluttered in the breeze. At sunset the boat rested beside a lily pad.';
 const storyA=ok(await req(A,'/api/stories',{method:'POST',data:{author:'Writer A',title:'The paper flag',text}}),201);
 const storyB=ok(await req(B,'/api/stories',{method:'POST',data:{author:'Writer B',title:'A different shelf',text:'A cloud drifted over a green hill.'}}),201);
 A.story=storyA.id;B.story=storyB.id;
 check('B cannot read A story',(await req(B,`/api/stories/${A.story}`)).status===404);
 check('B cannot update A story',(await req(B,`/api/stories/${A.story}`,{method:'PUT',data:{text:'Not permitted'}})).status===404);
 await req(B,`/api/stories/${A.story}`,{method:'DELETE'});
 check('B delete cannot alter A story',ok(await req(A,`/api/stories/${A.story}`)).text===text);
 check('B cannot upload into A story',(await req(B,`/api/upload?story=${A.story}`,{method:'POST',raw:Buffer.from('not an image'),headers:{'content-type':'image/png'}})).status===404);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII=','base64');
 const upload=ok(await req(A,`/api/upload?story=${A.story}`,{method:'POST',raw:png,headers:{'content-type':'image/png'}}));
 A.upload=upload.url;const uploaded=await req(A,upload.url);ok(uploaded);
 check('B cannot read A reference image',(await req(B,upload.url)).status===404);
 check('unauthenticated media access is blocked',(await req(null,upload.url)).status===401);
 if(process.env.HOSTED_SKIP_GENERATION!=='true') {
  const book=await req(A,`/api/stories/${A.story}/book`,{method:'POST',data:{text,settled_upto:text.length}});ok(book);
  report.provider_work.push({operation:'book',story_id:A.story,scenes:book.value.scenes?.length});
  let story=book.value;
  const deadline=Date.now()+180000;
  while(Date.now()<deadline&&!story.scenes?.some(p=>p.image_url)){
   if(story.scenes?.some(p=>p.error&&/limit|429|quota/i.test(p.error))){hubStopped=true;throw Error('Hub limit observed; stopped generation');}
   await new Promise(resolve=>setTimeout(resolve,5000));story=ok(await req(A,`/api/stories/${A.story}`));
  }
  const page=story.scenes?.find(p=>p.image_url);check('queue paints a real hosted story image',!!page?.image_url);
  A.image=page.image_url;const image=await req(A,A.image);ok(image);await fs.writeFile(path.join(out,'storybook-image.bin'),image.bytes);
  report.provider_work.push({operation:'image',bytes:image.bytes.length,sha256:createHash('sha256').update(image.bytes).digest('hex')});
  check('B cannot read A generated image',(await req(B,A.image)).status===404);
  check('B cannot modify A scene',(await req(B,`/api/stories/${A.story}/scenes/${page.sid}`,{method:'PUT',data:{feedback:'blocked'}})).status===404);
  const tts=ok(await req(A,'/api/tts',{method:'POST',data:{story_id:A.story,sid:page.sid}}));A.audio=tts.audio_url;
  const audio=await req(A,A.audio);ok(audio);await fs.writeFile(path.join(out,'read-aloud.mp3'),audio.bytes);
  report.provider_work.push({operation:'tts',chars:tts.chars,usd:tts.usd,bytes:audio.bytes.length,sha256:createHash('sha256').update(audio.bytes).digest('hex')});
  check('B cannot read A generated audio',(await req(B,A.audio)).status===404);
  check('B cannot synthesize A story',(await req(B,'/api/tts',{method:'POST',data:{story_id:A.story,sid:page.sid}})).status===404);
  check('cached playback is free',ok(await req(A,'/api/tts',{method:'POST',data:{story_id:A.story,sid:page.sid}})).cached===true);
  const ledger=ok(await req(A,'/api/account/ledger'));
  check('ledger records actual text, image and TTS units',['text','image','tts'].every(kind=>ledger.entries.some(e=>e.kind===kind)));
  check('text ledger includes provider token counts',ledger.entries.some(e=>e.kind==='text'&&e.tokens>0));
  check('read aloud ledger includes characters and dollars',ledger.entries.some(e=>e.kind==='tts'&&e.characters>0&&e.usd>0));
  await fs.writeFile(path.join(out,'provider-ledger.json'),JSON.stringify(ledger,null,2));
 }else {report.limitations.push('Real book/image/TTS generation explicitly skipped');ok(await spend(A,'image',0,{images:1}));ok(await spend(A,'tts',0.01,{characters:1}));}
 check('B cannot see A cost rows',ok(await req(B,`/api/account/ledger?account_id=${A.id}`)).entries.every(e=>e.story_id!==A.story));
 for(const [name,kind,config,reason] of [
  ['kill switch','text',{HOSTED_PAUSE:true},'breaker'],
  ['account token reservation','text',{HOSTED_MONTHLY_TOKENS:1},'allowance'],
  ['account image allowance','image',{HOSTED_MONTHLY_IMAGES:1},'allowance'],
  ['account dollar allowance','tts',{HOSTED_MONTHLY_ALLOWANCE_USD:0.01},'allowance'],
  ['global image breaker','image',{HOSTED_GLOBAL_DAILY_IMAGES:1},'breaker'],
  ['global token breaker','text',{HOSTED_GLOBAL_DAILY_TOKENS:1},'breaker'],
  ['per-minute account rate','text',{HOSTED_RATE_PER_MINUTE:1},'rate_limit'],
 ]) {
  const r=await spend(A,kind,0,{}, {config});
  check(`${name} denies work with test-scoped config`,r.status===402&&r.value.reason===reason);
 }

 const exportRes=await req(A,'/api/account/export',{method:'POST',data:{}});ok(exportRes);
 const exported=exportRes.bytes.toString().trim().split('\n').map(x=>JSON.parse(x));
 check('export has completion marker and own story',exported.at(-1).type==='complete'&&exported.some(e=>e.table==='stories'&&e.data.id===A.story));
 check('export includes owned media bytes',exported.some(e=>e.type==='media_chunk'));
 check('export excludes foreign story and credential hashes',!exportRes.bytes.toString().includes(B.story)&&!/(password_hash|password_salt|recovery_hash|token_hash)/.test(exportRes.bytes.toString()));
 await fs.writeFile(path.join(out,'account-export.ndjson'),exportRes.bytes);
 ok(await req(A,'/auth/lock-parent',{method:'POST',data:{}}));
 check('child session cannot open parent ledger',(await req(A,'/api/account/ledger')).value.error==='parent_auth');
 check('foreign Origin parent change rejected',(await req(A,'/auth/parent',{method:'POST',data:{password:A.password},headers:{origin:'https://attacker.invalid'}})).status===403);
 ok(await req(A,'/auth/parent',{method:'POST',data:{password:A.password}}));
 // Concurrent reservations: each 1.5s operation holds its slot, and no more than four are admitted.
 const parallel=await Promise.all(Array.from({length:8},()=>spend(B,'text',0,{total_tokens:1},{delay_ms:1500})));
 check('concurrent admission enforces per-account max four',parallel.filter(r=>r.status===200).length<=4&&parallel.some(r=>r.value?.reason==='rate_limit'));
 // Reach the character warning and limit with signed/secret-bound synthetic usage; no provider spending.
 let usage=ok(await req(A,'/api/account/usage'));
 while(usage.tts_characters<40000){const amount=Math.min(10000,40000-usage.tts_characters);const r=await spend(A,'tts',amount*0.00004,{characters:amount});ok(r);usage=r.value.usage;}
 check('80 percent character usage warns parent',usage.warning&&usage.state==='warn');
 const final=await spend(A,'tts',0.001,{characters:1});
 check('allowance refuses next bounded TTS call gently',final.status===402&&final.value.reason==='allowance'&&/printing press/i.test(final.value.message));
 const cancel=event('customer.subscription.deleted',sub(A,'canceled'));ok(await webhook(cancel));
 const denied=await spend(A,'text',0,{total_tokens:1});check('canceled subscription cannot make paid calls',denied.status===402&&denied.value.reason==='billing');
 ok(await webhook(event('customer.subscription.updated',sub(A),cancel.created-10)));
 check('out of order event cannot revive cancellation',ok(await req(A,'/api/account')).account.plan==='canceled');
 ok(await req(B,'/auth/logout',{method:'POST',data:{}}),204);
 check('sign out revokes session',(await req(B,'/api/stories')).status===401);
 const recovered=ok(await req(B,'/auth/recover',{method:'POST',data:{email:B.email,recovery_code:B.recovery,password:B.password}}));B.recovery=recovered.recovery_code;
 check('recovery rotates code and starts fresh parent session',!!B.recovery);
 const C=await signup('retention');
 ok(await req(C,'/api/account/test/retention',{method:'POST',internal:true,data:{days:8}}));
 check('daily retention deletes unverified accounts older than seven days',(await req(C,'/api/account')).status===401);C.deleted=true;
 for(const a of actors.filter(a=>!a.deleted)){const r=await cleanup(a);check(`${a.name} deletion completes`,r.status===204);check(`${a.name} deleted session fails`,(await req(a,'/api/stories')).status===401);}
 for(const url of [A.upload,A.image,A.audio].filter(Boolean))check('deleted media unavailable without session',(await req(null,url)).status===401);
 report.finished=new Date().toISOString();report.passed=true;
}catch(e){report.passed=false;report.failure=String(e.message);report.hub_stopped=hubStopped;process.exitCode=1;}
finally{
 for(const a of actors){try{await cleanup(a);}catch{report.limitations.push(`Cleanup retry required for synthetic account ${a.id}`);}}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,artifact:path.join(out,'report.json'),failure:report.failure||null,hub_stopped:hubStopped},null,2));
}
