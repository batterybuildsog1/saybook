// Real browser E2E against the hosted test Worker (storybook-hosted, Stripe TEST mode): this checkout's public/ files
// over the deployed API. A parent signs up (closed sign-up: the internal test token goes on /auth/signup only, never
// printed), saves the recovery code, starts the plan in Stripe Checkout with the 4242 test card (aborts unless checkout
// reports mode "test"), waits for the webhook to confirm consent, adds a writer, opens the studio, makes a book,
// shares it behind the parent password and the disclosure tick, opens the link signed out, then deletes the account.
// Usage: node e2e/ui/real-hosted.mjs [outdir]
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, open, VIEWPORTS } from './harness.mjs';

const BASE = process.env.BASE;
if (!BASE) throw new Error('Set BASE to your isolated test Worker URL');
const out = process.argv[2] || join(import.meta.dirname, 'out', 'real-hosted-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
await mkdir(out, { recursive: true });
const TOKEN = (await readFile(process.env.HOME + '/.config/saybook/hosted-test-token.key', 'utf8')).trim();
const EMAIL = `ui-e2e+${Date.now()}@example.com`;
const PW = 'ui test ' + randomBytes(9).toString('hex');
const browser = await chromium.launch();
const log = [], shots = [];
const step = (name, ok, detail = '') => { log.push({ name, ok, detail: String(detail).slice(0, 300) }); console.log(ok ? 'ok  ' : 'FAIL', name, detail ? String(detail).slice(0, 160) : ''); };
const shot = async (page, name) => { const f = join(out, `real-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };
const local = !process.env.SERVED;

// 1. Public pages at every size: landing, sign in, new family
for (const vpName of Object.keys(VIEWPORTS)) {
  const o = await open(browser, VIEWPORTS[vpName], { base: BASE, local, state: { mode: 'hosted' } });
  await o.page.goto(BASE + '/home/'); await o.page.waitForSelector('.title-card'); await o.page.waitForTimeout(1200);
  await shot(o.page, `${vpName}-landing`);
  await o.page.goto(BASE + '/signin/'); await o.page.waitForSelector('#f-in:not([hidden])'); await shot(o.page, `${vpName}-signin`);
  await o.page.goto(BASE + '/signin/?new=1'); await o.page.waitForSelector('#f-new:not([hidden]), #f-wait:not([hidden]), #closed:not([hidden])'); await o.page.waitForTimeout(300);
  await shot(o.page, `${vpName}-new-family`);
  step(`${vpName} public pages, no page errors`, o.errors.filter((e) => !/status of (401|404)/.test(e)).length === 0, o.errors.join(' | '));
  await o.ctx.close();
}

// 2. The parent's whole path, at Alan's size
const o = await open(browser, VIEWPORTS['laptop-1280x529'], { base: BASE, local, state: { mode: 'hosted' } });
const { page, ctx } = o;
await ctx.route(BASE + '/auth/signup', (route) => route.continue({ headers: { ...route.request().headers(), 'x-hosted-test-token': TOKEN } }));
// Pay only in Stripe TEST mode: the checkout session URL must be a cs_test_ session, checked before the page can follow it.
let testMode = null;
await ctx.route(BASE + '/api/billing/checkout', async (route) => {
  const r = await route.fetch(); const j = await r.json().catch(() => ({}));
  testMode = typeof j.url === 'string' && /checkout\.stripe\.com\/.*\/cs_test_/.test(j.url);
  if (!testMode) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'UI E2E guard: not a Stripe test session' }) });
  return route.fulfill({ response: r, body: JSON.stringify(j) });
});
// Until the account is deleted, its sign-in lives in a private temp file (for manual cleanup if a run dies).
const CRED = '/tmp/saybook-ui-e2e-account.json';
await writeFile(CRED, JSON.stringify({ base: BASE, email: EMAIL, password: PW }), { mode: 0o600 });
let deleted = false;
try {
  await page.goto(BASE + '/signin/?new=1'); await page.waitForSelector('#f-new:not([hidden])');
  await page.fill('#f-new [name=email]', EMAIL); await page.fill('#f-new [name=password]', PW);
  await page.check('#f-new [name=parent]'); await page.check('#f-new [name=consent]');
  await page.click('#f-new [type=submit]');
  await page.waitForSelector('#saved:not([hidden]), #waited:not([hidden]), #f-new .err:not([hidden])', { timeout: 20000 });
  const saved = await page.isVisible('#saved');
  step('sign-up shows the one-time recovery code', saved, saved ? '' : await page.textContent('#f-new .err, #waited'));
  await page.screenshot({ path: join(out, 'real-laptop-1280x529-recovery-code.png'), mask: [page.locator('#code')] }); // never keep a recovery code
  if (!saved) throw new Error('no account');
  step('Continue waits for "I saved it"', await page.isDisabled('#go'));
  await page.check('#kept'); await page.click('#go');
  await page.waitForSelector('#start:not([hidden])', { timeout: 20000 });
  step('account starts with the plan (no kid features before paying)', true);
  await shot(page, 'laptop-1280x529-account-start');
  // Before paying, kid routes are closed
  const pre = await page.evaluate(async () => (await fetch('/api/stories', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'x' }) })).status);
  step('a story can’t be started before the paid consent check', pre === 403, pre);

  // Stripe Checkout, TEST mode only
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/billing/checkout')), page.click('#checkout')]);
  step('checkout is a Stripe TEST session (cs_test_)', testMode === true, `test=${testMode}`);
  if (testMode !== true) throw new Error('not test mode: stopped before paying');
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
  await page.waitForSelector('#cardNumber', { timeout: 30000 });
  await shot(page, 'laptop-1280x529-stripe-checkout');
  await page.fill('#cardNumber', '4242424242424242'); await page.fill('#cardExpiry', '12 / 34'); await page.fill('#cardCvc', '123');
  if (await page.isVisible('#billingName')) await page.fill('#billingName', 'UI Test Parent');
  if (await page.isVisible('#billingPostalCode')) await page.fill('#billingPostalCode', '83702');
  if (await page.isVisible('#billingCountry')) await page.selectOption('#billingCountry', 'US').catch(() => {});
  await page.click('.SubmitButton, button[type=submit]');
  await page.waitForURL(/\/account\/\?checkout=done|\/account\/\?welcome=1/, { timeout: 90000 });
  await shot(page, 'laptop-1280x529-confirming');
  await page.waitForSelector('#writers-sec:not([hidden])', { timeout: 60000 });
  step('webhook confirmed: writers, month, plan shown', true);
  await page.fill('#addw [name=name]', 'Ada'); await page.click('#addw [type=submit]');
  await page.waitForSelector('#writers li', { timeout: 20000 });
  await page.waitForTimeout(600);
  await shot(page, 'laptop-1280x529-account');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(300);
  await shot(page, 'laptop-1280x529-account-end');

  // The studio: the parent's grown-up session ends on the way in
  await page.click('#to-studio');
  await page.waitForSelector('.screen.shelf.on, .screen.writers.on', { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot(page, 'laptop-1280x529-studio-shelf');
  await page.click('.faceout.new'); await page.waitForSelector('.screen.desk.on', { timeout: 20000 });
  const storyId = await page.evaluate(() => window.App.S.story.id);
  const text = 'A hedgehog named Button wanted to see the sea.\n\nShe packed one apple and a map drawn on a leaf, and set off before breakfast.\n\n';
  await page.evaluate(async ([id, t]) => { await fetch('/api/stories/' + id, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t, title: 'Button Goes to the Sea' }) }); }, [storyId, text]);
  await page.reload(); await page.waitForSelector('.screen.desk.on', { timeout: 20000 }); await page.waitForTimeout(1500);
  await shot(page, 'laptop-1280x529-desk');
  // Share: parent password (the grown-up session was locked on entering the studio), then the disclosure tick
  await page.click('#share-btn'); await page.waitForSelector('#share[open]');
  await page.check('#share-consent'); await page.click('#share-make');
  const gate = await page.waitForSelector('dialog.gate[open]', { timeout: 15000 }).then(() => true).catch(() => false);
  step('sharing asks for the parent password', gate);
  if (gate) { await shot(page, 'laptop-1280x529-share-gate'); await page.fill('dialog.gate input[name=pw]', PW); await page.click('dialog.gate [type=submit]'); }
  await page.waitForSelector('#share-on:not([hidden])', { timeout: 20000 });
  const link = await page.inputValue('#share-link');
  step('share link made', /\/b\/[^/]+$/.test(link), link.replace(/\/b\/.+$/, '/b/<token>'));
  await shot(page, 'laptop-1280x529-share-made');
  const v = await open(browser, VIEWPORTS['phone-390x844'], { base: BASE, local, state: { mode: 'hosted' } });
  await v.page.goto(link); await v.page.waitForSelector('#cover:not([hidden]), #gone:not([hidden])', { timeout: 20000 });
  step('a friend opens the book signed out', await v.page.isVisible('#cover'), await v.page.textContent('#c-title'));
  await shot(v.page, 'phone-390x844-shared'); await v.ctx.close();
  await page.click('#share-stop'); await page.waitForSelector('#share-off:not([hidden])', { timeout: 20000 });
  await page.keyboard.press('Escape');
  step('no page errors in the studio', o.errors.filter((e) => !/status of (401|403|404)/.test(e)).length === 0, o.errors.join(' | '));
} catch (e) {
  step('hosted path', false, e.message);
  await shot(page, 'laptop-1280x529-FAILED').catch(() => {});
} finally {
  // Delete the test account (cancels the test subscription, frees the slot), from a page on the hosted origin
  // Use the context's cookie jar without a sign-in page redirect racing the cleanup fetches.
  const r = await (async () => {
    const headers = { origin: BASE };
    await ctx.request.post(BASE + '/auth/login', { headers, data: { email: EMAIL, password: PW } });
    await ctx.request.post(BASE + '/auth/parent', { headers, data: { password: PW } });
    const d = await ctx.request.delete(BASE + '/api/account', { headers, data: { confirmation: 'DELETE' } });
    return d.status() + ' ' + (await d.text()).slice(0, 120);
  })().catch((e) => String(e));
  deleted = /^20[04]/.test(String(r));
  if (deleted) await import('node:fs/promises').then((f) => f.rm(CRED, { force: true }));
  step('test account deleted', deleted, r);
  await ctx.close();
}
await browser.close();
await writeFile(join(out, 'real-hosted.json'), JSON.stringify({ base: BASE, local_files: local, email: EMAIL.replace(/\+\d+/, '+<time>'), at: new Date().toISOString(), log, shots }, null, 1));
console.log(out, log.filter((l) => !l.ok).length ? 'FAILURES' : 'all ok');
