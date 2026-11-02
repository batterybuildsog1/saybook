// e2e/ui/harness.mjs (UI agent): open the UI in a real browser.
// Two ways:
//   mock: local public/ files + an in-memory API that follows docs/HOSTED.md's shapes (for building screens before a
//         Worker has the endpoint). Every screenshot taken this way is labelled "mock" in its file name.
//   real: BASE=https://your-test-worker.workers.dev — the deployed Worker serves the API; LOCAL=1 also swaps in
//         this checkout's public/ files (to see unreleased UI against the real API). Without LOCAL the Worker serves it all.
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
export const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC = join(HERE, '../../public');
export const MOCK_ORIGIN = 'https://saybook.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.woff2': 'font/woff2' };

export const VIEWPORTS = {
  'laptop-1280x529': { width: 1280, height: 529 },
  'ipad-1180x820': { width: 1180, height: 820, isMobile: false, hasTouch: true },
  'ipad-820x1180': { width: 820, height: 1180, isMobile: false, hasTouch: true },
  'phone-390x844': { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

// Static files the way the Worker's assets binding serves them (html_handling = auto-trailing-slash).
export async function staticFile(pathname) {
  let p = decodeURIComponent(pathname);
  if (/^\/b\/[^/]+\/?$/.test(p)) p = '/b/'; // a shared book: the Worker serves the /b/ page for every token
  const cands = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
  for (const c of cands) {
    const f = join(PUBLIC, c);
    if (!f.startsWith(PUBLIC)) break;
    try { if ((await stat(f)).isFile()) return { body: await readFile(f), type: TYPES[extname(f)] || 'application/octet-stream' }; } catch { /* next */ }
  }
  return null;
}

// ---------------- the mock API ----------------
export function mockState(over = {}) {
  return {
    mode: 'self', passcode: '', passcode_length: 0, unlocked: false, paused: false, signupOpen: true,
    setup: null, // null → 404 (endpoint not built); else the /api/setup body
    writers: [], stories: [], shares: {}, nextId: 1,
    signedIn: false, parentFresh: false, account: null, usage: null, consentNeeded: false,
    shared: null, // the /api/shared/:token body
    calls: [],
    ...over,
  };
}
const json = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', body: body === null ? '' : JSON.stringify(body), headers });

export async function mockApi(route, S, url) {
  const p = url.pathname, m = route.request().method();
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* none */ }
  S.calls.push(`${m} ${p}`);
  const hosted = S.mode === 'hosted';
  const authed = hosted ? S.signedIn : (!S.passcode || S.unlocked);
  // public
  if (p === '/api/config') return json(route, 200, { app_name: 'Saybook', mode: S.mode, passcode_required: !!S.passcode, ...(S.passcode_length ? { passcode_length: S.passcode_length } : {}), ...(hosted ? { signed_in: S.signedIn, signup_open: S.signupOpen } : {}), ...(S.paused ? { paused: true } : {}) });
  if (p === '/api/unlock') { if (body && body.code === S.passcode) { S.unlocked = true; return json(route, 204, null); } return json(route, 401, { error: 'Incorrect passcode' }); }
  if (p.startsWith('/api/shared/')) return S.shared ? json(route, 200, S.shared) : json(route, 404, { error: 'not found' });
  if (p.startsWith('/media/') || p.startsWith('/s/')) {
    const name = p.split('/').pop();
    const f = await readFile(join(HERE, 'fixtures', name)).catch(() => null);
    return f ? route.fulfill({ status: 200, contentType: TYPES[extname(name)] || 'application/octet-stream', body: f }) : route.fulfill({ status: 404, body: 'no' });
  }
  if (p === '/auth/enrollment') return json(route, 200, { waitlist_only: !!S.full, paid_families: S.full ? 10 : 3, max_accounts: 10, painting_notice: 'Pictures can take a few minutes to paint, longer when lots of families are writing. Kids keep writing while they paint.' });
  if (p === '/auth/waitlist') return json(route, 202, { waitlisted: true, message: 'You’re on the list. We’ll email you when there’s room.' });
  if (p === '/auth/signup') {
    if (!S.signupOpen) return json(route, 403, { error: 'signup_closed' });
    if (S.full) return json(route, 202, { waitlisted: true, message: 'Every family place is taken right now. You’re on the waitlist.' });
    if (!body || String(body.password || '').length < 14) return json(route, 400, { error: 'weak_password' });
    S.signedIn = true; S.parentFresh = true;
    S.account = { email: body.email, status: 'active', subscription_status: null, plan: null, created: Date.now(), child_access: false, parent_verified_at: null, recordings_enabled: false, monthly_price_usd: 19.5 };
    return json(route, 201, { account: S.account, recovery_code: 'k3Jd-82Hs-Qp0x-Lm4Z-9vYt-Ae1w' });
  }
  if (p === '/auth/login') { if (body && body.password === 'correct horse battery') { S.signedIn = true; S.parentFresh = true; return json(route, 200, { account: S.account }); } return json(route, 401, { error: 'Email or password did not match' }); }
  if (p === '/auth/recover') return json(route, 401, { error: 'Recovery details did not match' });
  if (p === '/auth/logout') { S.signedIn = false; return json(route, 204, null); }
  if (p === '/auth/parent') { if (body && body.password === 'correct horse battery') { S.parentFresh = true; return json(route, 200, { ok: true }); } return json(route, 401, { error: 'Password did not match' }); }
  if (p === '/auth/lock-parent') { S.parentFresh = false; return json(route, 200, { ok: true }); }
  if (!authed) return json(route, 401, { error: 'locked' });
  if (hosted && p.startsWith('/api/account')) {
    if (!S.parentFresh) return json(route, 403, { error: 'parent_auth' });
    if (p === '/api/account' && m === 'GET') return json(route, 200, { account: S.account, usage: S.usage });
    if (p === '/api/account' && m === 'PUT') { if (!S.account.parent_verified_at) return json(route, 403, { error: 'parental_consent_required' }); S.account.recordings_enabled = !!body.recordings_enabled; return json(route, 200, { ok: true, recordings_enabled: S.account.recordings_enabled }); }
    if (p === '/api/account/export') return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-disposition': 'attachment; filename="saybook-export.json"' }, body: JSON.stringify({ account: S.account, stories: S.stories }) });
    if (p === '/api/account' && m === 'DELETE') return body && body.confirmation === 'DELETE' ? json(route, 200, { ok: true, deleted: true }) : json(route, 400, { error: 'Type DELETE to confirm account deletion' });
  }
  if (hosted && p.startsWith('/api/billing/')) {
    if (!S.parentFresh) return json(route, 403, { error: 'parent_auth' });
    if (p === '/api/billing/checkout') return json(route, 200, { url: MOCK_ORIGIN + '/account/?checkout=done', mode: 'test' });
    if (p === '/api/billing/portal') return json(route, 200, { url: MOCK_ORIGIN + '/account/' });
  }
  if (hosted && S.consentNeeded && !p.startsWith('/api/settings') && p !== '/api/voices' && !(S.account && S.account.parent_verified_at)) return json(route, 403, { error: 'parental_consent_required' });
  if (p === '/api/setup') return S.setup ? json(route, 200, S.setup) : json(route, 404, { error: 'not found' });
  if (p === '/api/voices') return json(route, 200, [{ id: 'v1', name: 'Coral', vibe: 'warm and bright', kind: 'storyteller' }, { id: 'v2', name: 'Sage', vibe: 'calm and low', kind: 'storyteller' }]);
  if (p === '/api/settings') {
    if (m === 'PUT') {
      if (hosted && !(S.account && S.account.parent_verified_at)) return json(route, 403, { error: 'parental_consent_required' });
      S.writers = body.writers; return json(route, 200, { writers: S.writers });
    }
    return json(route, 200, { writers: S.writers });
  }
  if (p === '/api/stories' && m === 'GET') { const a = url.searchParams.get('author'); return json(route, 200, S.stories.filter((s) => !a || s.author === a).map(({ id, title, author, updated, cover_url, text }) => ({ id, title, author, updated, cover_url, first_line: (text || '').split('\n')[0].slice(0, 70), words: (text || '').split(/\s+/).length }))); }
  if (p === '/api/stories' && m === 'POST') { const s = { id: 'st' + S.nextId++, title: '', author: body.author, text: '', voice_id: null, cost: {}, book: { chapters: [], settled_paragraphs: 0 }, cast: [], scenes: [], share: null, updated: Date.now() }; S.stories.unshift(s); return json(route, 200, s); }
  let r;
  if ((r = p.match(/^\/api\/stories\/([\w-]+)$/))) {
    const s = S.stories.find((x) => x.id === r[1]);
    if (!s) return json(route, 404, { error: 'not found' });
    if (m === 'GET') return json(route, 200, s);
    if (m === 'PUT') { Object.assign(s, body); return json(route, 200, s); }
    if (m === 'DELETE') { S.stories = S.stories.filter((x) => x !== s); return json(route, 204, null); }
  }
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/share$/))) {
    const s = S.stories.find((x) => x.id === r[1]);
    if (hosted && !S.parentFresh) return json(route, 403, { error: 'parent_auth' });
    if (m === 'POST' && !(body && body.disclosure_consent === true && body.notice_version === '2026-11-02')) return json(route, 403, { error: 'sharing_consent_required', notice_version: '2026-11-02' });
    if (m === 'POST') { S.shareBodies = [...(S.shareBodies || []), body]; s.share = { token: 'acct.' + 'a1'.repeat(24), url: '/b/acct.' + 'a1'.repeat(24), show_author: !!body.show_author, created: Date.now() }; return json(route, 200, s.share); }
    if (m === 'DELETE') { s.share = null; return json(route, 204, null); }
  }
  if ((r = p.match(/^\/api\/stories\/([\w-]+)\/book$/))) { if (S.paused) return json(route, 402, { error: 'limit', reason: 'breaker' }); const s = S.stories.find((x) => x.id === r[1]); return json(route, 200, { ...s, applied: true, ms: 10 }); }
  if (p === '/api/tts' || p === '/api/chat' || p.endsWith('/image') || p.endsWith('/cast')) return json(route, 402, { error: 'limit', reason: 'allowance' });
  return json(route, 404, { error: 'not found' });
}

// One page per (viewport, scenario). Returns { page, ctx, S, base }.
export async function open(browser, vp, { state = {}, base = process.env.BASE, local = !!process.env.LOCAL } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor || 1, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, reducedMotion: 'reduce' });
  const S = mockState(state);
  const origin = base || MOCK_ORIGIN;
  if (base && !local && process.env.UI_FIXTURE_API === 'true') {
    // Exercise assets actually served by a Worker, with explicit scenario fixtures for the API.
    await ctx.route(origin + '/**', async (route) => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/media/') || p.startsWith('/s/')) return mockApi(route, S, url);
      return route.continue();
    });
  }
  if (!base || local) {
    await ctx.route(origin + '/**', async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      if (!base && (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/media/') || p.startsWith('/s/'))) return mockApi(route, S, url);
      if (base && (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/media/') || p.startsWith('/s/') || p === '/health')) return route.continue();
      if (base && p === '/' && S.mode === 'hosted' && !S.signedIn) { /* the Worker decides */ }
      const f = await staticFile(p);
      if (f) return route.fulfill({ status: 200, contentType: f.type, body: f.body });
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return { page, ctx, S, base: origin, errors };
}
