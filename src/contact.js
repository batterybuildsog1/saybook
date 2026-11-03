import { EmailMessage } from 'cloudflare:email';
import { body,json,fail,sameOrigin,sha } from './hosted/util.js';
// Fixed verified destination and sender: no arbitrary recipient, subject or header forwarding.
export async function contact(req,env) {
 try {
  sameOrigin(req);
  if(env.MODE!=='hosted')fail(404,'not found');
  if(req.method==='GET')return json({started_at:Date.now()});
  if(req.method!=='POST')fail(405,'Use POST');
  const b=await body(req,12288),at=Date.now();
  if(typeof b.website!=='string'||b.website||!Number.isSafeInteger(b.started_at)||at-b.started_at<3000||at-b.started_at>3600000)fail(400,'Please reload the form and try again.');
  const email=typeof b.email==='string'?b.email.trim():'';
  const message=typeof b.message==='string'?b.message.trim():'';
  if(email.length>254||!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)||/[\r\n]/.test(email))fail(400,'Enter a valid parent email.');
  if(message.length<10||message.length>5000)fail(400,'Write between 10 and 5,000 characters.');
  // D1 upsert is atomic across isolates. IP and email never stored in this table.
  for(const [scope,limit] of [[`ip:${req.headers.get('cf-connecting-ip')||'unknown'}`,5],[`email:${email.toLowerCase()}`,3],['global',100]]) {
   const key=await sha(`saybook-contact:${Math.floor(at/3600000)}:${scope}`);
   const row=await env.DB.prepare('INSERT INTO contact_limits(key_hash,hits,expires) VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET hits=hits+1 RETURNING hits').bind(key,at+3600000).first();
   if(row.hits>limit)fail(429,'Please wait an hour, or email support@saybook.app.');
  }
  await env.DB.prepare('DELETE FROM contact_limits WHERE expires<?').bind(at).run();
  const sender=env.CONTACT_FROM,recipient=env.CONTACT_TO;
  if(!env.CONTACT_EMAIL||![sender,recipient].every(v=>typeof v==='string'&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)))fail(503,'Please email support@saybook.app.');
  const text=`A parent wrote through Saybook contact.\n\n${message}`;
  // Base64 UTF-8 body prevents user text from creating MIME/header boundaries.
  const bytes=new TextEncoder().encode(text);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  const encoded=btoa(binary).match(/.{1,76}/g).join('\r\n');
  const raw=`From: Saybook support <${sender}>\r\nTo: ${recipient}\r\nReply-To: ${email}\r\nSubject: Saybook contact\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n`;
  await env.CONTACT_EMAIL.send(new EmailMessage(sender,recipient,raw));
  return json({ok:true,message:'Thanks. Your message is on its way to us.'});
 }catch(e){return json({error:e.status?e.message:'Please email support@saybook.app.'},e.status||503);}
}
