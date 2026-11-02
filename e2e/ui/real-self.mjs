// Real browser E2E against the self-host test Worker (default storybook-selftest): this checkout's public/ files over
// the deployed API (LOCAL=1 behaviour; set SERVED=1 to use the Worker's own files). One short story is made and deleted.
// Passcode: E2E_PASSCODE, or the file Core keeps at /tmp/storybook-selftest-passcode (never printed).
// Usage: node e2e/ui/real-self.mjs [outdir]
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, open, VIEWPORTS } from './harness.mjs';

const BASE = process.env.BASE;
if (!BASE) throw new Error('Set BASE to your isolated test Worker URL');
const out = process.argv[2] || join(import.meta.dirname, 'out', 'real-self-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
await mkdir(out, { recursive: true });
const PASS = process.env.E2E_PASSCODE || (await readFile('/tmp/storybook-selftest-passcode', 'utf8')).trim();
const browser = await chromium.launch();
const log = [], shots = [];
const step = (name, ok, detail = '') => { log.push({ name, ok, detail: String(detail).slice(0, 300) }); console.log(ok ? 'ok  ' : 'FAIL', name, detail ? String(detail).slice(0, 160) : ''); };
const shot = async (page, name) => { const f = join(out, `real-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };

async function unlocked(vpName) {
  const vp = VIEWPORTS[vpName];
  const o = await open(browser, vp, { base: BASE, local: !process.env.SERVED, state: { mode: 'self' } });
  await o.page.goto(BASE + '/');
  await o.page.waitForSelector('.screen.lock.on, .screen.shelf.on, .screen.writers.on', { timeout: 20000 });
  if (await o.page.isVisible('.screen.lock.on')) {
    if (await o.page.isVisible('#code-form')) { await o.page.fill('#code-input', PASS); await o.page.press('#code-input', 'Enter'); }
    else for (const ch of PASS) await o.page.keyboard.press(ch);
  }
  // unlocked: the bookcase, "Who's writing?", or (first run, keys missing) the status page
  await o.page.waitForFunction(() => location.pathname.startsWith('/setup/') || document.querySelector('.screen.shelf.on, .screen.writers.on'), null, { timeout: 30000 });
  return o;
}

// 1. Lock screen, typed passcode (the test passcode isn't digits), at Alan's size
{
  const o = await open(browser, VIEWPORTS['laptop-1280x529'], { base: BASE, local: !process.env.SERVED, state: { mode: 'self' } });
  await o.page.goto(BASE + '/');
  await o.page.waitForSelector('.screen.lock.on', { timeout: 20000 });
  step('lock shows a passcode field for a non-digit passcode', await o.page.isVisible('#code-form'));
  await o.page.fill('#code-input', 'wrong-passcode'); await o.page.press('#code-input', 'Enter'); await o.page.waitForTimeout(900);
  step('wrong passcode stays locked', await o.page.isVisible('.screen.lock.on'));
  await shot(o.page, 'laptop-1280x529-lock');
  await o.ctx.close();
}

// 2. Status page, writers, shelf at all four sizes (read-only)
for (const vpName of Object.keys(VIEWPORTS)) {
  const o = await unlocked(vpName);
  const { page } = o;
  await page.goto(BASE + '/setup/'); await page.waitForSelector('#lines li', { timeout: 20000 });
  const h = await page.textContent('#status-h');
  step(`${vpName} status page`, !!h, h);
  await shot(page, `${vpName}-setup`);
  await page.goto(BASE + '/');
  await page.waitForSelector('.screen.shelf.on, .screen.writers.on', { timeout: 20000 });
  if (await page.isVisible('.screen.writers.on')) {
    await shot(page, `${vpName}-writers-first-run`);
    await page.fill('#wf-input', 'Ada'); await page.press('#wf-input', 'Enter'); await page.waitForSelector('.wf-writer');
    await page.click('#wf-done'); await page.waitForSelector('.screen.shelf.on');
  }
  const tags = await page.$$eval('.tag[data-author]', (t) => t.map((x) => x.dataset.author));
  step(`${vpName} shelf with writers`, tags.length > 0, tags.join(', '));
  if (tags.length) await page.click(`.tag[data-author="${tags[0]}"]`);
  await page.waitForTimeout(1200);
  await shot(page, `${vpName}-shelf`);
  step(`${vpName} no page errors`, o.errors.filter((e) => !/status of (401|404)/.test(e)).length === 0, o.errors.join(' | '));
  await o.ctx.close();
}

// 3. One short story: write, it forms, Read, share (consent), the shared link, stop sharing, delete
{
  const o = await unlocked('laptop-1280x529');
  const { page } = o;
  await page.goto(BASE + '/'); await page.waitForSelector('.screen.shelf.on, .screen.writers.on');
  const tag = await page.$('.tag[data-author]'); if (tag) await tag.click();
  await page.click('.faceout.new'); await page.waitForSelector('.screen.desk.on', { timeout: 20000 });
  const storyId = await page.evaluate(() => window.App.S.story.id);
  step('new story', !!storyId, storyId);
  const text = 'The UI test fox found a small blue door in the hill.\n\nBehind the door was a library made of leaves, and every book whispered its title when the fox walked past.\n\n';
  await page.evaluate(async (t) => { const w = window.App.S.story; w.text = t; await fetch('/api/stories/' + w.id, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t, title: 'The Leaf Library' }) }); }, text);
  await page.reload(); await page.waitForSelector('.screen.desk.on', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await shot(page, 'laptop-1280x529-desk-write');
  // share: the button stays off until the disclosure box is ticked
  await page.click('#share-btn'); await page.waitForSelector('#share[open]');
  step('Make a link disabled before consent', await page.isDisabled('#share-make'));
  await shot(page, 'laptop-1280x529-share-sheet');
  await page.check('#share-consent');
  const [req] = await Promise.all([page.waitForRequest((r) => r.url().endsWith('/share') && r.method() === 'POST'), page.click('#share-make')]);
  const body = JSON.parse(req.postData() || '{}');
  step('share POST carries disclosure_consent and notice_version', body.disclosure_consent === true && body.notice_version === '2026-11-02' && body.show_author === false, JSON.stringify(body));
  await page.waitForSelector('#share-on:not([hidden])', { timeout: 20000 });
  const link = await page.inputValue('#share-link');
  step('share link made', /\/b\/[^/]+$/.test(link), link.replace(/\/b\/.+$/, '/b/<token>'));
  await shot(page, 'laptop-1280x529-share-made');
  await page.click('#share-close');
  // the shared book, signed out, at each size (served from this checkout, data from the Worker)
  for (const vpName of Object.keys(VIEWPORTS)) {
    const v = await open(browser, VIEWPORTS[vpName], { base: BASE, local: !process.env.SERVED, state: { mode: 'self' } });
    await v.page.goto(link);
    await v.page.waitForSelector('#cover:not([hidden]), #gone:not([hidden])', { timeout: 20000 });
    step(`${vpName} shared book opens without a passcode`, await v.page.isVisible('#cover'), await v.page.textContent('#c-title'));
    await v.page.waitForTimeout(800);
    await shot(v.page, `${vpName}-shared-cover`);
    if (await v.page.isVisible('#open')) { await v.page.click('#open'); await v.page.waitForTimeout(800); await shot(v.page, `${vpName}-shared-page`); }
    await v.ctx.close();
  }
  // Read view
  await page.click('.ribbon[data-step="read"]'); await page.waitForTimeout(2500);
  await shot(page, 'laptop-1280x529-read');
  // stop sharing: the link stops working
  await page.click('#share-btn'); await page.waitForSelector('#share-on:not([hidden])'); await page.click('#share-stop');
  await page.waitForSelector('#share-off:not([hidden])', { timeout: 20000 });
  const gone = await (await fetch(BASE + '/api/shared/' + link.split('/b/')[1])).status;
  step('stopped link returns 404', gone === 404, gone);
  await page.keyboard.press('Escape');
  const del = await page.evaluate(async (id) => (await fetch('/api/stories/' + id, { method: 'DELETE', credentials: 'same-origin' })).status, storyId);
  step('test story deleted', del === 204, del);
  step('no page errors in the story run', o.errors.filter((e) => !/status of (401|404)/.test(e)).length === 0, o.errors.join(' | '));
  await o.ctx.close();
}
await browser.close();
await writeFile(join(out, 'real-self.json'), JSON.stringify({ base: BASE, local_files: !process.env.SERVED, at: new Date().toISOString(), log, shots }, null, 1));
console.log(out, log.filter((l) => !l.ok).length ? 'FAILURES' : 'all ok');
