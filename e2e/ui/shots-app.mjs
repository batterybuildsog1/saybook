// The app's new screens at the four sizes (mock API unless BASE is set): passcode, first run, bookcase with writers'
// colours, the share sheet, the printing press resting. Usage: node e2e/ui/shots-app.mjs [outdir]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, open, VIEWPORTS } from './harness.mjs';

const out = process.argv[2] || join(import.meta.dirname, 'out', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const tag = (process.env.UI_FIXTURE_API ? 'served-fixtures' : process.env.BASE ? 'real' : 'mock') + (process.env.THEME ? '_' + process.env.THEME.split('-')[0] : '');
const results = [];
const shareEvidence = [];
const W = [{ name: 'Ada', color: '#d9603b' }, { name: 'Theo', color: '#3577a8' }];
const story = (id, author, title, text, extra = {}) => ({ id, author, title, text, voice_id: null, cost: {}, book: { chapters: [], settled_paragraphs: 0 }, cast: [], scenes: [], share: null, updated: Date.now(), ...extra });
const STORIES = [
  story('s1', 'Ada', 'The Moon Fell in Our Pond', 'Last night the moon fell in our pond. I heard it go SPLOOSH.\n\nI put my rain boots on over my pajamas.'),
  story('s2', 'Ada', '', 'A dragon who was scared of the dark lived under our stairs.'),
  story('s3', 'Ada', 'Pickles Goes to Space', 'My dog Pickles built a rocket out of cardboard.'),
];

async function shot(page, name) {
  const f = join(out, `${name}.png`);
  await page.screenshot({ path: f });
  return f;
}

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  const run = async (label, state, fn) => {
    const { page, ctx, S, base, errors } = await open(browser, vp, { state });
    try {
      await fn(page, base, S, vpName);
      results.push({ vp: vpName, label, file: await shot(page, `${tag}-${vpName}-${label}`), errors });
    } catch (e) {
      results.push({ vp: vpName, label, error: String(e).slice(0, 300), errors });
      await shot(page, `${tag}-${vpName}-${label}-FAILED`).catch(() => {});
    }
    await ctx.close();
  };
  await run('1-lock', { passcode: '4242' }, async (page, base) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.lock.on'); await page.keyboard.type('42'); await page.waitForTimeout(300);
  });
  await run('2-first-run', {}, async (page, base) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.writers.on'); await page.waitForTimeout(400);
  });
  await run('3-writers-added', {}, async (page, base) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.writers.on');
    await page.fill('#wf-input', 'Ada'); await page.press('#wf-input', 'Enter'); await page.waitForSelector('.wf-writer');
    await page.fill('#wf-input', 'Theo'); await page.click('#wf-swatches .swatch:nth-child(4)'); await page.click('#wf-add');
    await page.waitForFunction(() => document.querySelectorAll('.wf-writer').length === 2);
    await page.fill('#wf-input', 'Juniper'); await page.waitForTimeout(300);
  });
  await run('4-shelf', { writers: W, stories: STORIES.map((s) => ({ ...s })) }, async (page, base) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.shelf.on'); await page.click('.tag[data-author="Ada"]'); await page.waitForSelector('.spine'); await page.waitForTimeout(500);
  });
  await run('5-share-sheet', { writers: W, stories: STORIES.map((s) => ({ ...s })) }, async (page, base) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.shelf.on'); await page.click('.tag[data-author="Ada"]');
    await page.click('.spine >> nth=0'); await page.waitForSelector('.screen.desk.on'); await page.waitForTimeout(600);
    await page.click('#share-btn'); await page.waitForSelector('#share[open]'); await page.check('#share-consent'); await page.waitForTimeout(200);
  });
  await run('6-share-made', { writers: W, stories: STORIES.map((s) => ({ ...s })) }, async (page, base, S) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.shelf.on'); await page.click('.tag[data-author="Ada"]');
    await page.click('.spine >> nth=0'); await page.waitForSelector('.screen.desk.on');
    await page.click('#share-btn');
    if (!(await page.isDisabled('#share-make'))) throw new Error('Make a link is enabled before the disclosure box is ticked');
    await page.check('#share-consent'); await page.click('#share-make'); await page.waitForSelector('#share-on:not([hidden])'); await page.waitForTimeout(200);
    const sent = S.shareBodies || [];
    if (!(sent.length === 1 && sent[0].disclosure_consent === true && sent[0].notice_version === '2026-11-02' && sent[0].show_author === false)) throw new Error('share POST body: ' + JSON.stringify(sent));
    shareEvidence.push({ vp: vpName, body: sent[0] });
  });
  await run('7-resting-shelf', { writers: W, stories: STORIES.map((s) => ({ ...s })), paused: true }, async (page, base) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.shelf.on'); await page.click('.tag[data-author="Ada"]'); await page.waitForSelector('#press-note:not([hidden])'); await page.waitForTimeout(300);
  });
  await run('8-resting-desk', { writers: W, stories: STORIES.map((s) => ({ ...s })), paused: true }, async (page, base) => {
    await page.goto(base + '/' + (process.env.THEME ? '?theme=' + process.env.THEME : '')); await page.waitForSelector('.screen.shelf.on'); await page.click('.tag[data-author="Ada"]');
    await page.click('.spine >> nth=0'); await page.waitForSelector('.screen.desk.on'); await page.waitForTimeout(600);
  });
}
await browser.close();
await writeFile(join(out, `results-app-${tag}.json`), JSON.stringify({ results, shareEvidence }, null, 1));
for (const r of results) console.log(r.error ? 'FAIL' : 'ok  ', r.vp, r.label, r.error || '', r.errors && r.errors.length ? 'ERRORS: ' + r.errors.join(' | ').slice(0, 300) : '');
console.log(out);
