// Real-deploy E2E failure cases: leaked keys, unscoped CRUD/media, public writes,
// author/recording exposure, revoked bearer links, and provider calls from public reads.
// Creates only Demo records. Uses cached art; --layout-regression makes one text call.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const BASE = process.argv[2];
if (!BASE || !process.env.E2E_PASSCODE) throw new Error('Supply isolated base URL and E2E_PASSCODE');
const OUT = path.join('e2e/out', new Date().toISOString().replace(/[:.]/g, '-').slice(0,19) + '-core');
fs.mkdirSync(OUT, { recursive: true });
const checks = [], created = [];
let cookie = '', shared;
const check = (name, pass) => { checks.push({ name, pass: !!pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); };
async function call(method, route, body, authenticated = true) {
 const res = await fetch(BASE + route, { method, headers: { ...(authenticated ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
 const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
 return { res, data };
}
const sql = query => JSON.parse(execFileSync('wrangler', ['d1','execute','storybook-selftest','--remote','--config','wrangler.selftest.toml','--command',query,'--json'], { encoding: 'utf8', maxBuffer: 2e6 }));
try {
 const unlock = await call('POST','/api/unlock',{ code: process.env.E2E_PASSCODE },false);
 cookie = unlock.res.headers.get('set-cookie').split(';')[0];
 const config = await call('GET','/api/config');
 check('Saybook config is public and contains no secret values', config.data.app_name === 'Saybook' && config.data.mode === 'self' && !JSON.stringify(config.data).includes(process.env.E2E_PASSCODE));
 const settings = await call('PUT','/api/settings',{ writers:[{ name:'Demo', color:'#cf6c46' },'Demo', {name:'Demo Two', color:'bad'}] });
 check('writer colors and legacy strings normalize and deduplicate', settings.data.writers.length === 2 && settings.data.writers[0].name === 'Demo' && settings.data.writers[1].color === '#cf6c46');
 const setup = await call('GET','/api/setup');
 check('setup reports configured providers and storage without keys', setup.data.ready && setup.data.providers.text.ok && setup.data.providers.image.ok && setup.data.providers.voice.provider === 'elevenlabs' && setup.data.storage.queue && !/sk-[a-z0-9]{20}|phc_[a-z0-9]{20}/i.test(JSON.stringify(setup.data)));
 const newStory = await call('POST','/api/stories',{ author:'Demo', title:'Core isolation E2E', text:'The paper boat sailed safely home.' });
 const id = newStory.data.id; created.push(id);
 sql(`INSERT INTO stories(account_id,id,author,title,text,created,updated) VALUES('otherdemo','${id}','Demo','Other account','Other account words',1,1),('otherdemo','otherdemo-isolation','Demo','Other only','Other account words',1,1)`);
 check('same story id in another tenant does not shadow self', (await call('GET',`/api/stories/${id}`)).data.text === newStory.data.text);
 check('another account story cannot be read', (await call('GET','/api/stories/otherdemo-isolation')).res.status === 404);
 check('another account story cannot be updated', (await call('PUT','/api/stories/otherdemo-isolation',{text:'changed'})).res.status === 404);
 await call('DELETE','/api/stories/otherdemo-isolation');
 const rows = sql("SELECT text FROM stories WHERE account_id='otherdemo' AND id='otherdemo-isolation'");
 check('another account story survives self delete', rows[0].results[0].text === 'Other account words');
 if (process.argv.includes('--layout-regression')) {
  const text = 'The little paper boat sailed safely home across the quiet pond. A bright yellow lantern lit the dock.';
  await call('PUT',`/api/stories/${id}`,{text});
  sql(`INSERT INTO scenes(account_id,story_id,sid,ord,para_from,para_to,text,image_key,updated) VALUES('self','${id}','111111111111',0,0,0,'Earlier scene','ref/${id}/existing-fixture.png',1)`);
  const layout = await call('POST',`/api/stories/${id}/book`,{text});
  check('real planner preserves words through conditional scene insertion', layout.res.ok && layout.data.applied && layout.data.text.replace(/\s+/g,' ').trim() === text);
  check('changed scene inherits its picture without a new image call', layout.data.scenes.length === 1 && layout.data.scenes[0].stale && layout.data.scenes[0].image_url === `/media/ref/${id}/existing-fixture.png`);
 }
 const ledgerBefore = sql("SELECT COUNT(*) n FROM usage_ledger WHERE account_id='self'")[0].results[0].n;
 const list = await call('GET','/api/stories');
 const book = list.data.find(s => s.id !== id && s.author === 'Demo' && s.scene_count > 0 && s.cover_url);
 if (!book) throw new Error('Run the full E2E first to create a cached Demo book');
 const share = await call('POST',`/api/stories/${book.id}/share`,{}); shared = book.id;
 const token = share.data.token;
 check('share is an explicit revocable capability and hides author by default', share.res.ok && !share.data.show_author && /^[a-z0-9_-]+\.[a-f0-9]{48}$/.test(token));
 check('repeated share preserves its token', (await call('POST',`/api/stories/${book.id}/share`,{})).data.token === token);
 const anonymous = await call('GET',`/api/shared/${token}`,null,false);
 check('public book contains pages and no author, refs or private recordings', anonymous.res.ok && anonymous.data.author === null && anonymous.data.pages.length > 0 && !('refs' in anonymous.data.pages[0]) && !('own_audio_url' in anonymous.data));
 check('shared JSON is noindex and never persistently cached', anonymous.res.headers.get('x-robots-tag') === 'noindex' && anonymous.res.headers.get('cache-control').includes('no-store'));
 const picture = anonymous.data.pages.find(p => p.image_url)?.image_url;
 const image = await fetch(BASE + picture, { headers: { range:'bytes=0-99' } }); await image.arrayBuffer();
 check('anonymous shared image supports Range', image.status === 206);
 check('shared route cannot read unreferenced uploads', (await fetch(BASE + `/s/${token}/ref/${book.id}/private.png`)).status === 404);
 const audio = anonymous.data.pages.find(p => p.audio_url)?.audio_url;
 if (audio) { const r = await fetch(BASE + audio); await r.arrayBuffer(); check('shared narration serves only an existing cache', r.ok); }
 check('public shared endpoint refuses writes', (await call('POST',`/api/shared/${token}`,{},false)).res.status === 401);
 const author = await call('POST',`/api/stories/${book.id}/share`,{show_author:true});
 check('parent can explicitly include Demo author', author.data.show_author && (await call('GET',`/api/shared/${token}`,null,false)).data.author === 'Demo');
 const after = await call('GET','/api/setup');
 check('sharing and anonymous viewing spend no provider usage', sql("SELECT COUNT(*) n FROM usage_ledger WHERE account_id='self'")[0].results[0].n === ledgerBefore);
 await call('DELETE',`/api/stories/${book.id}/share`); shared = null;
 check('revocation removes public book', (await call('GET',`/api/shared/${token}`,null,false)).res.status === 404);
 check('revocation removes public media', (await fetch(BASE + picture)).status === 404);
 const share2 = await call('POST',`/api/stories/${id}/share`,{});
 await call('DELETE',`/api/stories/${id}`);
 check('deleting a story revokes its link', (await call('GET',`/api/shared/${share2.data.token}`,null,false)).res.status === 404);
} finally {
 if (shared) await call('DELETE',`/api/stories/${shared}/share`);
 for (const id of created) await call('DELETE',`/api/stories/${id}`);
 sql("DELETE FROM stories WHERE account_id='otherdemo' AND author='Demo'");
 fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({base:BASE,at:new Date().toISOString(),checks,passed:checks.filter(c=>c.pass).length,total:checks.length},null,2));
 fs.writeFileSync(path.join(OUT,'report.md'),'# Saybook core E2E\n\n'+checks.map(c=>`${c.pass?'PASS':'FAIL'} ${c.name}`).join('\n')+'\n');
}
console.log(OUT);
process.exitCode = checks.every(c=>c.pass) ? 0 : 1;
