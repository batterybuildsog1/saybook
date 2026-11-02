// The grown-ups' pages and a shared book at the four sizes (mock API unless BASE is set).
// Usage: node e2e/ui/shots-grown.mjs [outdir] [filter]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, open, VIEWPORTS } from './harness.mjs';

const out = process.argv[2] || join(import.meta.dirname, 'out', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const only = process.argv[3] ? new RegExp(process.argv[3]) : null;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const tag = process.env.UI_FIXTURE_API ? 'served-fixtures' : process.env.BASE ? 'real' : 'mock';
const results = [];

const ACCOUNT = { email: 'parent@example.com', status: 'active', subscription_status: 'active', subscription_end: Date.now() + 26 * 864e5, cancel_at_period_end: false, plan: 'active', created: Date.now() - 5 * 864e5, child_access: true, parent_verified_at: Date.now() - 5 * 864e5, recordings_enabled: false, monthly_price_usd: 19.5 };
const USAGE = { period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z', resets_at: '2026-12-01T00:00:00Z', pct: 0.83, state: 'warn', images: 166, image_allowance: 200, breakdown: { pictures: 166, readings: 41250 } };
const SETUP_MISSING = { ready: false, command: 'npm run setup', providers: { text: { ok: true, model: 'gpt-4.1-mini', host: 'api.openai.com', missing: [] }, vision: { ok: true, model: 'gpt-4.1-mini', host: 'api.openai.com', missing: [] }, image: { ok: false, model: 'gpt-image-1', host: 'api.openai.com', missing: ['IMAGE_API_KEY'] }, voice: { ok: false, provider: 'openai', missing: ['OPENAI_API_KEY'] }, stt: { ok: true, provider: 'workers-ai', missing: [] } }, storage: { db: true, media: true, queue: true }, passcode: false, month: { usd: 0, since: '2026-11-01T00:00:00Z' } };
const SETUP_READY = { ...SETUP_MISSING, ready: true, providers: { ...SETUP_MISSING.providers, image: { ok: true, model: 'gpt-image-1', host: 'api.openai.com', missing: [] }, voice: { ok: true, provider: 'elevenlabs', missing: [] } }, passcode: true, month: { usd: 3.4172, since: '2026-11-01T00:00:00Z' } };
const T = 'acct.' + 'a1'.repeat(24);
const SHARED = {
  app_name: 'Saybook', title: 'The Moon Fell in Our Pond', first_line: 'Last night the moon fell in our pond.', author: 'Ada', chapters: [{ start: 0, title: '' }], updated: Date.now(),
  pages: [
    { sid: 'a1', ord: 0, from: 0, to: 0, text: 'Last night the moon fell in our pond. I heard it go SPLOOSH. I looked out my window and the whole pond was glowing like a giant night light, and all the frogs were sitting around the edge looking very surprised.', image_url: `/s/${T}/img/page-0.jpg`, audio_url: null, alignment: null },
    { sid: 'a2', ord: 1, from: 1, to: 1, text: 'I put my rain boots on over my pajamas and went outside with a bucket. The moon was way too big for the bucket. It was even too big for the bathtub. The biggest frog said we need a better plan.', image_url: `/s/${T}/img/page-1.jpg`, audio_url: null, alignment: null },
    { sid: 'a3', ord: 2, from: 2, to: 3, text: 'So we made a plan. My dog Pickles held the flashlight in his mouth. The frogs pushed with their tummies and I pushed with a broom. The moon was slippery like soap and it giggled and said that tickles.\n\nWe rolled it all the way up the hill behind our house. Then the moon took a big breath and bounced back up into the sky. It said thank you and goodnight, and the frogs clapped with their feet.', image_url: `/s/${T}/img/page-2.jpg`, audio_url: null, alignment: null },
  ],
};

async function shot(page, name) { const f = join(out, `${name}.png`); await page.screenshot({ path: f }); return f; }
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  const run = async (label, state, fn) => {
    if (only && !only.test(label)) return;
    const { page, ctx, base, errors } = await open(browser, vp, { state });
    try { await fn(page, base); results.push({ vp: vpName, label, file: await shot(page, `${tag}-${vpName}-${label}`), errors }); }
    catch (e) { results.push({ vp: vpName, label, error: String(e).slice(0, 300), errors }); await shot(page, `${tag}-${vpName}-${label}-FAILED`).catch(() => {}); }
    await ctx.close();
  };
  const hosted = { mode: 'hosted' };
  await run('g1-signin', hosted, async (p, b) => { await p.goto(b + '/signin/'); await p.waitForSelector('#f-in:not([hidden])'); await p.waitForTimeout(500); });
  await run('g2-signup', hosted, async (p, b) => { await p.goto(b + '/signin/?new=1'); await p.waitForSelector('#f-new:not([hidden])'); await p.fill('#f-new [name=email]', 'parent@example.com'); await p.waitForTimeout(400); });
  await run('g3-recovery-code', hosted, async (p, b) => {
    await p.goto(b + '/signin/?new=1'); await p.waitForSelector('#f-new:not([hidden])');
    await p.fill('#f-new [name=email]', 'parent@example.com'); await p.fill('#f-new [name=password]', 'correct horse battery');
    await p.check('#f-new [name=parent]'); await p.check('#f-new [name=consent]'); await p.click('#f-new [type=submit]');
    await p.waitForSelector('#saved:not([hidden])'); await p.waitForTimeout(300);
  });
  await run('g4-closed', { ...hosted, signupOpen: false }, async (p, b) => { await p.goto(b + '/signin/?new=1'); await p.waitForSelector('#closed:not([hidden])'); await p.waitForTimeout(300); });
  await run('g4b-waitlist', { ...hosted, full: true }, async (p, b) => { await p.goto(b + '/signin/?new=1'); await p.waitForSelector('#f-wait:not([hidden])'); await p.fill('#f-wait [name=email]', 'parent@example.com'); await p.waitForTimeout(300); });
  await run('g4c-waitlisted', { ...hosted, full: true }, async (p, b) => { await p.goto(b + '/signin/?new=1'); await p.waitForSelector('#f-wait:not([hidden])'); await p.fill('#f-wait [name=email]', 'parent@example.com'); await p.click('#f-wait [type=submit]'); await p.waitForSelector('#waited:not([hidden])'); });
  await run('g5-account-start', { ...hosted, signedIn: true, parentFresh: true, account: { ...ACCOUNT, child_access: false, parent_verified_at: null, subscription_status: null }, usage: USAGE }, async (p, b) => { await p.goto(b + '/account/?welcome=1'); await p.waitForSelector('#start:not([hidden])'); await p.waitForTimeout(400); });
  await run('g6-account', { ...hosted, signedIn: true, parentFresh: true, account: ACCOUNT, usage: USAGE, writers: [{ name: 'Ada', color: '#d9603b' }, { name: 'Theo', color: '#3577a8' }] }, async (p, b) => { await p.goto(b + '/account/'); await p.waitForSelector('#writers li'); await p.waitForTimeout(500); });
  await run('g7-account-gate', { ...hosted, signedIn: true, parentFresh: false, account: ACCOUNT, usage: USAGE }, async (p, b) => { await p.goto(b + '/account/'); await p.waitForSelector('dialog.gate[open]'); await p.waitForTimeout(300); });
  await run('g8-setup-missing', { setup: SETUP_MISSING }, async (p, b) => { await p.goto(b + '/setup/?first=1'); await p.waitForSelector('#lines li'); await p.waitForTimeout(400); });
  await run('g9-setup-ready', { setup: SETUP_READY }, async (p, b) => { await p.goto(b + '/setup/'); await p.waitForSelector('#lines li'); await p.waitForTimeout(400); });
  await run('b1-cover', { shared: SHARED }, async (p, b) => { await p.goto(b + '/b/' + T); await p.waitForSelector('#cover:not([hidden])'); await p.waitForTimeout(900); });
  await run('b2-page', { shared: SHARED }, async (p, b) => { await p.goto(b + '/b/' + T); await p.waitForSelector('#cover:not([hidden])'); await p.click('#open'); await p.click('#next'); await p.click('#next'); await p.waitForTimeout(900); });
  await run('b3-end', { shared: SHARED }, async (p, b) => { await p.goto(b + '/b/' + T + '#3'); await p.waitForSelector('#spread:not([hidden])'); await p.click('#next'); await p.waitForTimeout(300); });
  await run('b4-gone', {}, async (p, b) => { await p.goto(b + '/b/' + T); await p.waitForSelector('#gone:not([hidden])'); });
}
await browser.close();
await writeFile(join(out, `results-grown-${tag}.json`), JSON.stringify(results, null, 1));
for (const r of results) console.log(r.error ? 'FAIL' : 'ok  ', r.vp, r.label, r.error || '', (r.errors || []).filter((x) => !/status of (401|404)/.test(x)).join(' | ').slice(0, 300));
console.log(out);
