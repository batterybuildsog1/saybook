// Contact us: a short form to support (POST /api/contact, src/contact.js). A signed-in parent is never sent back to the
// sales page: the bar offers Account and the footer opens Saybook (Aside report 2026-11-03 #7).
import { config } from '/kit.js';
const form=document.querySelector('#contact'),button=form.querySelector('button'),status=document.querySelector('#status');
let started;
try{const r=await fetch('/api/contact');if(!r.ok)throw Error();started=(await r.json()).started_at;setTimeout(()=>button.disabled=false,3000);}catch{status.textContent='Please email support@saybook.app.';}
form.onsubmit=async e=>{e.preventDefault();button.disabled=true;status.textContent='Sending…';try{const r=await fetch('/api/contact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:form.email.value,message:form.message.value,website:form.website.value,started_at:started})});const d=await r.json();if(!r.ok)throw Error(d.error);status.textContent=d.message;form.reset();}catch(e){status.textContent=e.message||'Please email support@saybook.app.';button.disabled=false;}};
const cfg=await config();
if(cfg.mode==='hosted'&&cfg.signed_in){
 const who=document.querySelector('#who-link'),home=document.querySelector('#home-link');
 who.textContent='Account';who.href='/account/';
 home.textContent='Open Saybook';home.href='/';
 document.querySelector('[data-home]').href='/';
}
