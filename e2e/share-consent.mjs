// Full Worker HTTP E2E using isolated local D1/R2 and a seeded paid-parent fixture.
// Failure cases: password mistaken for consent, stale/wrongly typed consent, author
// disclosure expansion, non-atomic journaling, legacy links, and sharing during deletion.
// No provider calls, real Stripe requests, production bindings or live credentials.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
const exec = promisify(execFile), root = path.resolve(new URL('..', import.meta.url).pathname);
process.chdir(root);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'saybook-share-consent-'));
const config = path.join(root, 'wrangler.consent.local.toml');
const output = path.join(root, 'e2e/out', new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '-share-consent');
await fs.mkdir(output, { recursive: true });
const checks = [], report = { fixture: 'Local D1 paid-parent/session seed; no live billing or provider work', checks };
const check = (name, value) => { checks.push({ name, pass: !!value }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); if (!value) throw new Error(name); };
let worker;
async function sql(query) {
 const { stdout } = await exec('wrangler',['d1','execute','DB','--local','--config',config,'--persist-to',temp,'--command',query,'--json'],{maxBuffer:4e6});
 return JSON.parse(stdout)[0].results;
}
const server = net.createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port = server.address().port; await new Promise(resolve=>server.close(resolve));
const base = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex'), childToken = randomBytes(32).toString('hex');
const hash = x => createHash('sha256').update(x).digest('hex');
async function request(method, route, body, identity = 'parent') {
 const cookie = identity === 'parent' ? `__Host-storybook=${token}` : identity === 'child' ? `__Host-storybook=${childToken}` : '';
 const res = await fetch(base + route,{method,headers:{cookie,origin:base,...(body === undefined ? {} : {'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const raw = await res.text(); let data;try { data=JSON.parse(raw); } catch {}
 return { status:res.status,data };
}
try {
 let toml = (await fs.readFile('wrangler.toml','utf8')).replace('MODE = "self"','MODE = "hosted"\nHOSTED_OPEN = "false"').replaceAll('storybook','saybook-consent-local').replace('REPLACE_WITH_D1_ID','00000000-0000-0000-0000-000000000001');
 await fs.writeFile(config,toml);
 for (const file of ['migrations/0001-core.sql','migrations/0002-shares.sql','migrations/hosted-001.sql'])
  await exec('wrangler',['d1','execute','DB','--local','--config',config,'--persist-to',temp,'--file',file],{maxBuffer:4e6});
 const at=Date.now(), expiry=at+86400000;
 await sql(`INSERT INTO hosted_accounts(account_id,email,password_hash,password_salt,recovery_hash,created,last_active,consent_version,consent_at,parent_verified_at,subscription_status,subscription_end) VALUES('democonsent','demo@example.invalid','local-fixture','local-fixture','local-fixture',${at},${at},'2026-11-02',${at},${at},'active',${expiry}); INSERT INTO hosted_sessions(token_hash,account_id,created,expires,parent_until) VALUES('${hash(token)}','democonsent',${at},${expiry},${expiry}),('${hash(childToken)}','democonsent',${at},${expiry},0);`);
 worker=spawn('wrangler',['dev','--local','--config',config,'--persist-to',temp,'--port',String(port)],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 let logs='';
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Local Worker startup timeout')),45000);
  const read=chunk=>{logs+=chunk.toString();if(logs.includes('Ready on')){clearTimeout(timer);resolve();}};
  worker.stdout.on('data',read);worker.stderr.on('data',read);worker.once('exit',code=>{clearTimeout(timer);reject(new Error(`Local Worker exited ${code}`));});
 });
 const made=await request('POST','/api/stories',{author:'Demo',title:'Separate sharing choice',text:'A paper lantern lit the quiet path home.'});
 check('verified parent fixture can create a Demo story',made.status===201);const id=made.data.id,route=`/api/stories/${id}/share`;
 const yes={disclosure_consent:true,notice_version:'2026-11-02',show_author:false};
 check('anonymous sharing is refused',(await request('POST',route,yes,'none')).status===401);
 const child=await request('POST',route,yes,'child');check('disclosure consent does not replace parent reauthentication',child.status===403&&child.data.error==='parent_auth');
 for(const [label,body] of [['absent',{}],['false',{...yes,disclosure_consent:false}],['string',{...yes,disclosure_consent:'true'}],['missing version',{disclosure_consent:true}],['stale version',{...yes,notice_version:'old'}]]) {
  const r=await request('POST',route,body);check(`fresh parent session alone cannot grant disclosure (${label})`,r.status===403&&r.data.error==='sharing_consent_required'&&r.data.notice_version==='2026-11-02');
 }
 check('rejected choices create neither consent nor link',(await sql("SELECT (SELECT COUNT(*) FROM hosted_consent WHERE account_id='democonsent') consent,(SELECT COUNT(*) FROM shares WHERE account_id='democonsent') links"))[0].consent===0&&(await sql("SELECT COUNT(*) n FROM shares WHERE account_id='democonsent'"))[0].n===0);
 const granted=await request('POST',route,yes);check('affirmative versioned choice creates a share',granted.status===200&&granted.data.show_author===false);const share=granted.data;
 const journal=await sql(`SELECT version,action,at FROM hosted_consent WHERE account_id='democonsent' AND action='share_disclosure:${id}:without_author'`);
 check('scoped consent is durable before the link is returned',journal.length===1&&journal[0].version==='2026-11-02'&&journal[0].at===share.created);
 const publicBook=await request('GET',`/api/shared/${share.token}`,undefined,'none');check('consented public reader hides the author',publicBook.status===200&&publicBook.data.author===null);
 check('author disclosure cannot expand without a new affirmative choice',(await request('POST',route,{show_author:true})).status===403);
 const withAuthor=await request('POST',route,{...yes,show_author:true});check('affirmative author choice preserves link and records its scope',withAuthor.status===200&&withAuthor.data.token===share.token&&(await sql(`SELECT id FROM hosted_consent WHERE account_id='democonsent' AND action='share_disclosure:${id}:with_author'`)).length===1);
 check('only the newly consented author is shown',(await request('GET',`/api/shared/${share.token}`,undefined,'none')).data.author==='Demo');
 check('revocation needs no disclosure consent',(await request('DELETE',route)).status===204);
 check('revocation is durable and removes public access',(await sql(`SELECT id FROM hosted_consent WHERE account_id='democonsent' AND action='share_revoked:${id}'`)).length===1&&(await request('GET',`/api/shared/${share.token}`,undefined,'none')).status===404);
 const second=await request('POST','/api/stories',{author:'Demo',text:'A second book stays inside the family.'}),sid=second.data.id;
 const legacy=`democonsent.${'a'.repeat(48)}`;
 await sql(`INSERT INTO shares(account_id,story_id,token,show_author,created) VALUES('democonsent','${sid}','${legacy}',0,1)`);
 check('legacy public link without disclosure journal is refused',(await request('GET',`/api/shared/${legacy}`,undefined,'none')).status===404);
 await sql(`DELETE FROM shares WHERE account_id='democonsent' AND story_id='${sid}'; CREATE TRIGGER share_failure_fixture BEFORE INSERT ON shares BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
 const before=(await sql("SELECT COUNT(*) n FROM hosted_consent WHERE account_id='democonsent'"))[0].n;
 check('simulated share storage failure aborts request',(await request('POST',`/api/stories/${sid}/share`,yes)).status===500);
 check('failed share transaction rolls back the consent insert',(await sql("SELECT COUNT(*) n FROM hosted_consent WHERE account_id='democonsent'"))[0].n===before);
 await sql('DROP TRIGGER share_failure_fixture');
 const reopened=await request('POST',route,yes);
 check('new consented link is publicly readable before account freeze',(await request('GET',`/api/shared/${reopened.data.token}`,undefined,'none')).status===200);
 await sql("UPDATE hosted_accounts SET status='deleting' WHERE account_id='democonsent'");
 check('deletion freeze immediately disables an existing public link',(await request('GET',`/api/shared/${reopened.data.token}`,undefined,'none')).status===404);
 check('frozen account cannot create new shares',(await request('POST',`/api/stories/${sid}/share`,yes)).status===401);
 report.passed=checks.length;report.total=checks.length;
} catch(e) { report.error=e.message;process.exitCode=1; }
finally {
 if(worker){worker.kill('SIGTERM');await new Promise(resolve=>{if(worker.exitCode!==null)resolve();else{worker.once('exit',resolve);setTimeout(resolve,3000);}});}
 await fs.rm(config,{force:true});await fs.rm(temp,{recursive:true,force:true});
 report.passed=checks.filter(c=>c.pass).length;report.total=checks.length;
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
 await fs.writeFile(path.join(output,'report.md'),'# Sharing disclosure consent E2E\n\n'+report.fixture+'\n\n'+checks.map(c=>`${c.pass?'PASS':'FAIL'} ${c.name}`).join('\n')+(report.error?'\n\nError: '+report.error:'')+'\n');
 console.log(output);
}
