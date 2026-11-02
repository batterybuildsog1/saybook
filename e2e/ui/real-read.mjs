// Read-only check on the self-host test Worker: the bookcase's image bytes (covers must be ?w= resized, not 3.5 MB PNGs)
// and an illustrated book in Write and Read at the four sizes. Creates nothing. Usage: node e2e/ui/real-read.mjs [outdir]
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, open, VIEWPORTS } from './harness.mjs';

const BASE = process.env.BASE;
if (!BASE) throw new Error('Set BASE to your isolated test Worker URL');
const out = process.argv[2] || join(import.meta.dirname, 'out', 'real-read');
await mkdir(out, { recursive: true });
const PASS = process.env.E2E_PASSCODE || (await readFile('/tmp/storybook-selftest-passcode', 'utf8')).trim();
const browser = await chromium.launch();
const log = [];
const step = (name, ok, detail = '') => { log.push({ name, ok, detail: String(detail).slice(0, 300) }); console.log(ok ? 'ok  ' : 'FAIL', name, detail ? String(detail).slice(0, 200) : ''); };
for (const vpName of Object.keys(VIEWPORTS)) {
  const o = await open(browser, VIEWPORTS[vpName], { base: BASE, local: !process.env.SERVED, state: { mode: 'self' } });
  const { page } = o;
  const bytes = { img: 0, n: 0, big: [] };
  page.on('response', async (r) => {
    if (!/\/media\/(img|ref)\//.test(r.url())) return;
    const b = await r.body().catch(() => null); if (!b) return;
    bytes.img += b.length; bytes.n++; if (b.length > 600e3) bytes.big.push(r.url().replace(BASE, ''));
  });
  await page.goto(BASE + '/');
  await page.waitForSelector('.screen.lock.on, .screen.shelf.on', { timeout: 20000 });
  if (await page.isVisible('.screen.lock.on')) { await page.fill('#code-input', PASS); await page.press('#code-input', 'Enter'); }
  await page.waitForSelector('.screen.shelf.on', { timeout: 30000 });
  const tags = await page.$$eval('.tag[data-author]', (t) => t.map((x) => x.dataset.author));
  await page.click(`.tag[data-author="${tags[0]}"]`);
  await page.waitForSelector('.faceout:not(.new), .spine', { timeout: 20000 }); await page.waitForTimeout(2500);
  step(`${vpName} bookcase pictures are resized`, bytes.big.length === 0, `${bytes.n} pictures, ${(bytes.img / 1e6).toFixed(2)} MB${bytes.big.length ? '; full-size: ' + bytes.big.join(', ') : ''}`);
  await page.screenshot({ path: join(out, `real-${vpName}-bookcase.png`) });
  const face = await page.$('.faceout:not(.new)');
  if (!face) { step(`${vpName} an illustrated book to open`, false, 'no cover on the shelf'); await o.ctx.close(); continue; }
  await face.click(); await page.waitForSelector('.screen.desk.on', { timeout: 20000 }); await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, `real-${vpName}-write.png`) });
  await page.click('.ribbon[data-step="read"]'); await page.waitForTimeout(3500);
  await page.screenshot({ path: join(out, `real-${vpName}-read.png`) });
  step(`${vpName} Read view shows a picture`, await page.evaluate(() => [...document.querySelectorAll('#read-surface img')].some((i) => i.complete && i.naturalWidth > 0)));
  step(`${vpName} no page errors`, o.errors.filter((e) => !/status of (401|404)/.test(e)).length === 0, o.errors.join(' | '));
  await page.click('.ribbon[data-step="write"]').catch(() => {}); // leave the book as it was
  await o.ctx.close();
}
await browser.close();
await writeFile(join(out, 'real-read.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), log }, null, 1));
console.log(out, log.filter((l) => !l.ok).length ? 'FAILURES' : 'all ok');
