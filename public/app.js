// app.js: the app. Layout: "The Storybook Desk".
// (Self-host: the passcode, if one is set; first run: the providers' status page, then "Who's writing?") → bookcase
// (pick a writer) → the desk, with two ribbons: Write (write.js, the dense manuscript) and Read (read.js, the finished
// book: big pictures, distinct pages, read aloud word by word with automatic page turns, or the writer's own recorded
// reading). The reader's style is a grown-ups setting. A book can be shared as a read-only link (/b/<token>).
// State lives in the API: the writers are /api/settings. localStorage only remembers the writer, the open story and
// step, the theme, the reader style and the live-words switch, so a reload lands where the writer was.
import { mount as mountWrite } from './write.js';
import { mountRead, SKINS } from './read.js';
import { createReader } from './reader.js';
import { fallback, imgAttrs } from './pic.js';
import { APP_NAME, SWATCHES, nextSwatch, normWriters, config, limitNote, askParent } from './kit.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $('#app');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const phoneQ = matchMedia('(max-width: 760px)');
const later = (ms, fn) => setTimeout(fn, reduce ? 0 : ms);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('stories.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem('stories.' + k); else localStorage.setItem('stories.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
// 0.15 s of silence: played from the first tap so iPad Safari lets this <audio> start later without a tap
// (a new reading takes ~15 s to arrive, long after the tap).
const SILENT = 'data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAyAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAASW5mbwAAAA8AAAAIAAAD+gBHR0dHR0dHR0dHR0diYmJiYmJiYmJiYmJ8fHx8fHx8fHx8fHx8lpaWlpaWlpaWlpaWsbGxsbGxsbGxsbGxscvLy8vLy8vLy8vLy+Xl5eXl5eXl5eXl5eX///////////////8AAAAATGF2YzYzLjEuAAAAAAAAAAAAAAAAJALUAAAAAAAAA/pQa94hAAAAAAAAAAAAAAAAAP/zQMQAAAADSAAAAABMQU1FNC4wVVVVVVVVVVVVVVVVTEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxFsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
const THEME_NAMES = { 'paper-cut-forest': 'Paper Cut Forest', 'night-sky-lanterns': 'Night Sky Lanterns', 'watercolor-meadow': 'Watercolor Meadow' };
// Reader style: B by default, A and C selectable in the grown-ups corner. ?reader=a|b|c sets it too.
(() => { const q = new URLSearchParams(location.search).get('reader'); if (SKINS[q]) LS.set('reader', q); })();
const readerSkin = () => (SKINS[LS.get('reader')] ? LS.get('reader') : 'b');
document.addEventListener('error', fallback, true); // a resized picture that fails falls back to the original

const S = {
  screen: 'boot', step: 'write', code: '', checking: false, cfg: null,
  writers: [], kid: LS.get('kid'), list: null, listKid: null, shelfErr: null,
  story: null, writer: null, reader: null, read: null, leaving: false,
  voices: [], voice: null,
};
const hosted = () => S.cfg && S.cfg.mode === 'hosted';

/* ---------------- API ---------------- */
class ApiError extends Error { constructor(msg, status, detail) { super(msg); this.status = status; this.detail = detail; } }
// The printing press is resting: a quiet note on the shelf and the desk, not a toast that comes and goes.
function rest(on) {
  S.resting = !!on;
  app.classList.toggle('resting', S.resting);
  $('#press-note').hidden = !S.resting;
}
$('#press-x').onclick = () => { $('#press-note').hidden = true; }; // until the next refused call or reload
async function api(method, path, body, opt = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof Blob) { init.body = body; init.headers['content-type'] = body.type || 'application/octet-stream'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  if (opt.keepalive) init.keepalive = true;
  let res;
  try { res = await fetch(path, init); }
  catch { throw new ApiError("Can't reach the story studio. Is the Wi-Fi on?", 0); }
  if (res.status === 401 && path !== '/api/unlock') { lockUp(); throw new ApiError('locked', 401); }
  if (opt.raw && res.status !== 402 && res.status !== 403) return res;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  // Hosted: nothing for kids until a parent has finished the first paid checkout (it is also the consent check).
  if (res.status === 403 && data && data.error === 'parental_consent_required') {
    location.replace('/account/?verify=1');
    throw new ApiError('consent', 403);
  }
  // Hosted: some grown-up actions ask for the parent password again, then go ahead once.
  if (res.status === 403 && data && data.error === 'parent_auth' && !opt.gated) {
    if (await askParent()) return api(method, path, body, { ...opt, gated: true });
    throw new ApiError('cancelled', 403);
  }
  // A paid call the account can't make right now (allowance used, paused, billing): the printing press rests; the
  // words are always saved. Never retried.
  if (res.status === 402 || (res.status === 503 && data && data.error === 'paused')) {
    rest(true);
    throw new ApiError(limitNote(), 402, data);
  }
  if (opt.raw) return res;
  if (!res.ok) throw new ApiError((data && data.error) || 'Something went wrong', res.status, data && data.detail);
  return data;
}

/* ---------------- toast: one short note, sometimes with "Try again" ---------------- */
let toastT = 0;
function toast(msg, { retry } = {}) {
  const t = $('#toast');
  $('#toast-msg').textContent = msg;
  const rb = $('#toast-retry');
  rb.hidden = !retry;
  rb.onclick = () => { hideToast(); retry(); };
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastT);
  if (!retry) toastT = setTimeout(hideToast, 6000);
}
function hideToast() { $('#toast').hidden = true; clearTimeout(toastT); }
$('#toast-x').onclick = hideToast;

/* ---------------- screens ---------------- */
function go(name) {
  if (name !== S.screen) stopReading();
  S.screen = name;
  app.dataset.screen = name;
  $$('.screen').forEach((el) => {
    const on = el.dataset.s === name;
    el.classList.toggle('on', on);
    if (on && !reduce && name !== 'boot') { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); setTimeout(() => el.classList.remove('enter'), 600); }
  });
  if (name === 'shelf') loadShelf();
  if (name === 'writers') { renderWriters(); setTimeout(() => $('#wf-input').focus({ preventScroll: true }), 50); }
  closeChat();
  renderChatLog();
  remember();
}
function remember() {
  if (S.screen === 'desk' && S.story) { LS.set('story', S.story.id); LS.set('step', S.step); }
}

/* ---------------- 1. passcode (self-host, only when one is set) / sign in (hosted) ---------------- */
function lockUp() {
  if (hosted()) { // the hosted service has accounts: a grown-up signs in on /signin/
    const next = location.pathname + location.search;
    location.replace(LS.get('was-in') ? '/signin/?next=' + encodeURIComponent(next) : '/home/');
    return;
  }
  if (S.screen === 'lock') return;
  stopReading();
  S.code = '';
  paintClasp();
  go('lock');
  if (typedCode()) setTimeout(() => $('#code-input').focus(), 60);
}
// The clasp has one stud per digit when the server says how long the passcode is (passcode_length); otherwise it grows
// as the code is typed and the pad's spare key becomes "Open".
const codeLen = () => (S.cfg && S.cfg.passcode_length > 0 ? Math.min(12, S.cfg.passcode_length) : 0);
// A passcode that isn't all digits (the server sends no passcode_length) is typed into a field instead of the keypad.
const typedCode = () => !!(S.cfg && S.cfg.passcode_required && !codeLen());
$('#code-form').onsubmit = (e) => {
  e.preventDefault();
  if (S.checking) return;
  S.code = $('#code-input').value;
  if (!S.code) return;
  S.checking = true;
  checkCode();
};
function paintClasp() {
  $('#code-form').hidden = !typedCode();
  $('.pad').hidden = typedCode();
  const c = $('.clasp'), n = typedCode() ? 4 : codeLen() || Math.max(4, S.code.length);
  if (c.children.length !== n) c.innerHTML = '<i></i>'.repeat(n);
  $$('.clasp i').forEach((g, i) => g.classList.toggle('on', typedCode() ? S.checking : i < S.code.length));
  const ok = $('.pad [data-k="ok"]');
  if (ok) ok.hidden = !!codeLen();
}
function key(k) {
  if (S.screen !== 'lock' || S.checking) return;
  const b = $(`.pad [data-k="${k}"]`);
  if (b) { b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 110); }
  const len = codeLen();
  if (k === 'del') S.code = S.code.slice(0, -1);
  else if (k === 'ok') { if (S.code) { S.checking = true; setTimeout(checkCode, 120); } return; }
  else if (S.code.length < (len || 12)) S.code += k;
  paintClasp();
  if (len && S.code.length === len) { S.checking = true; setTimeout(checkCode, 200); }
}
async function checkCode() {
  const book = $('#closed-book');
  let ok = false;
  try { await api('POST', '/api/unlock', { code: S.code }); ok = true; }
  catch (e) { if (e.status === 0) toast(e.message); }
  if (ok) {
    book.classList.add('open');
    later(1100, () => { S.code = ''; S.checking = false; book.classList.remove('open'); paintClasp(); boot(); });
  } else {
    $('.clasp').classList.add('bad');
    setTimeout(() => { $('.clasp').classList.remove('bad'); S.code = ''; S.checking = false; paintClasp(); if (typedCode()) { $('#code-input').value = ''; $('#code-input').focus(); } }, 480);
  }
}
$$('.pad button').forEach((b) => b.addEventListener('click', () => key(b.dataset.k)));
document.addEventListener('keydown', (e) => {
  if (S.screen === 'lock' && !typedCode()) { if (/^\d$/.test(e.key)) key(e.key); if (e.key === 'Backspace') key('del'); if (e.key === 'Enter') key('ok'); }
  if (e.key === 'Escape') { closeChat(); $('#grownups-panel').hidden = true; }
});

/* ---------------- boot: who's here, and where were they ---------------- */
async function boot() {
  if (!S.cfg) { S.cfg = await config(); dress(); }
  try { S.voices = await api('GET', '/api/voices'); }
  catch (e) { if (e.status === 401) return; go('shelf'); toast(e.message, { retry: boot }); return; }
  if (hosted()) {
    LS.set('was-in', true);
    // Entering the studio ends the parent's 15-minute grown-up session, so a kid at the keyboard can't reach it.
    fetch('/auth/lock-parent', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  }
  // Self-host first run: until the providers are connected, the status page says what's missing and the one command
  // that fixes it. "Open anyway" there skips it for this visit.
  if (!hosted() && !sessionStorage.getItem('setup-skip')) {
    const st = await api('GET', '/api/setup').catch(() => null);
    if (st && st.ready === false) { location.replace('/setup/?first=1'); return; }
  }
  try { await loadWriters(); }
  catch (e) { if (e.status === 401) return; go('shelf'); toast(e.message, { retry: boot }); return; }
  // Child screens never load client analytics or replay.
  if (!S.writers.length) { go('writers'); return; } // first run: "Who's writing?"
  await flushSave(); // anything typed just before a lock-out
  const last = LS.get('story');
  if (last) {
    try { await openStory(last, { step: LS.get('step') === 'write' ? 'write' : LS.get('step') ? 'read' : 'write' }); return; }
    catch (e) { if (e.status === 401) return; LS.set('story', null); }
  }
  go('shelf');
}

/* The name and the grown-ups corner follow the server's config: passcode or none, self-host or hosted. */
function dress() {
  document.title = APP_NAME;
  $$('[data-app-name]').forEach((el) => { el.textContent = APP_NAME; });
  app.classList.toggle('hosted', hosted()); // hosted: no per-book cost lines (one monthly price)
  $('#gp-status').hidden = hosted();
  $('#gp-account').hidden = !hosted();
  $('#gp-signout').hidden = !hosted();
  if (S.cfg.paused) rest(true);
  paintClasp();
}

/* ---------------- first run: who's writing? (also: the + on the shelf) ---------------- */
// The family's writers live on the server (/api/settings {writers:[{name,color}]}), so every device shows the same
// shelves and speech-to-text knows their names.
const kids = () => S.writers.map((w) => w.name);
const colorOf = (name) => (S.writers.find((w) => w.name === name) || {}).color || SWATCHES[0];
async function loadWriters() {
  const d = await api('GET', '/api/settings');
  S.writers = normWriters(d && d.writers);
  if (S.kid && !kids().includes(S.kid)) { S.kid = null; LS.set('kid', null); }
  if (!S.kid && S.writers.length === 1) S.kid = S.writers[0].name;
}
async function saveWriters(next) {
  const d = await api('PUT', '/api/settings', { writers: next });
  // An older server keeps names only: keep the colours chosen here for this visit.
  const back = normWriters(d && d.writers);
  S.writers = back.length === next.length ? back.map((w, i) => ({ ...w, color: typeof (d.writers[i]) === 'string' ? next[i].color : w.color })) : next;
}
function cleanName(v) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 24); }

let wfColor = SWATCHES[0];
function renderWriters() {
  const list = $('#wf-list');
  list.innerHTML = '';
  S.writers.forEach((w) => {
    const li = document.createElement('li');
    li.className = 'wf-writer';
    li.style.setProperty('--tag', w.color);
    li.innerHTML = `<span class="wf-name"></span><button type="button" class="wf-rm" aria-label="Remove"><svg><use href="#i-close"/></svg></button>`;
    li.querySelector('.wf-name').textContent = w.name;
    li.querySelector('.wf-rm').setAttribute('aria-label', `Remove ${w.name}`);
    li.querySelector('.wf-rm').onclick = async () => {
      try { await saveWriters(S.writers.filter((x) => x.name !== w.name)); } catch (e) { if (e.status !== 401 && e.status !== 403) toast(e.message); }
      renderWriters();
    };
    list.appendChild(li);
  });
  wfColor = nextSwatch(S.writers.map((w) => w.color));
  const sw = $('#wf-swatches');
  sw.innerHTML = '';
  SWATCHES.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (c === wfColor ? ' on' : '');
    b.style.setProperty('--sw', c);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === wfColor));
    b.setAttribute('aria-label', ['Fox', 'Honey', 'Fern', 'Lake', 'Berry', 'Pine'][i]);
    b.onclick = () => { wfColor = c; $$('#wf-swatches .swatch').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); };
    sw.appendChild(b);
  });
  $('#wf-done').disabled = !S.writers.length;
  $('#wf-title').textContent = S.writers.length ? 'Anyone else?' : 'Who’s writing?';
}
$('#wf-form').onsubmit = async (e) => {
  e.preventDefault();
  const inp = $('#wf-input'), name = cleanName(inp.value);
  if (!name) { inp.focus(); return; }
  if (kids().some((k) => k.toLowerCase() === name.toLowerCase())) { inp.value = ''; inp.focus(); return; }
  const btn = $('#wf-add');
  btn.disabled = true;
  try { await saveWriters([...S.writers, { name, color: wfColor }]); inp.value = ''; window.saybookAnalytics?.capture('writer_created', { surface: 'kid', operation: 'writer', ok: true }); }
  catch (err) { if (err.status !== 401 && err.status !== 403) toast(err.message, { retry: () => $('#wf-form').requestSubmit() }); }
  btn.disabled = false;
  renderWriters();
  inp.focus();
};
$('#wf-done').onclick = () => {
  if (!S.writers.length) return;
  if (!S.kid || !kids().includes(S.kid)) { S.kid = S.writers[S.writers.length === 1 ? 0 : 0].name; LS.set('kid', S.kid); }
  go('shelf');
};

/* ---------------- 2. the bookcase ---------------- */
async function loadShelf() {
  renderTags();
  const kid = S.kid;
  $('#case-title').textContent = kid ? `${kid}’s shelf` : 'Whose shelf?';
  if (S.listKid !== kid) { S.list = null; S.shelfErr = null; }
  renderShelf(false);
  if (!kid) return;
  try {
    const list = await api('GET', '/api/stories?author=' + encodeURIComponent(kid));
    if (S.kid !== kid) return;
    S.list = list; S.listKid = kid; S.shelfErr = null;
  } catch (e) {
    if (e.status === 401) return;
    S.shelfErr = e.message;
  }
  if (S.screen === 'shelf' && S.kid === kid) renderShelf(true);
}

function renderTags() {
  const box = $('#tags');
  box.innerHTML = '';
  S.writers.forEach((w, i) => {
    const k = w.name, b = document.createElement('button');
    b.className = 'tag' + (k === S.kid ? ' on' : '');
    b.dataset.author = k;
    b.style.setProperty('--tag', w.color);
    b.style.setProperty('--rot', (i % 2 ? -1.5 : 1.5) + 'deg');
    b.innerHTML = `<span>${esc(k)}</span>` + (k === S.kid && S.writers.length > 1 ? `<span class="rm" role="button" aria-label="Remove ${esc(k)}">✕</span>` : '');
    b.onclick = (e) => { if (e.target.closest('.rm')) removeKid(k); else pickKid(k); };
    box.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'tag add';
  add.setAttribute('aria-label', 'Add a name');
  add.innerHTML = '<svg><use href="#i-plus"/></svg>';
  add.onclick = () => addKidForm(add);
  box.appendChild(add);
}
function pickKid(k) {
  if (S.kid === k) return;
  S.kid = k; LS.set('kid', k);
  loadShelf();
}
function addKidForm(btn) {
  const f = document.createElement('form');
  f.className = 'tag-new';
  f.innerHTML = `<input maxlength="24" placeholder="Name" aria-label="New writer's name" autocapitalize="words" autocomplete="off" enterkeyhint="done">
    <button type="submit" aria-label="Add"><svg><use href="#i-check"/></svg></button><button type="button" class="cancel" aria-label="Cancel"><svg><use href="#i-close"/></svg></button>`;
  btn.replaceWith(f);
  const inp = f.querySelector('input');
  inp.focus();
  f.querySelector('.cancel').onclick = () => renderTags();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const name = cleanName(inp.value);
    if (!name) { renderTags(); return; }
    const existing = kids().find((k) => k.toLowerCase() === name.toLowerCase());
    if (!existing) {
      try { await saveWriters([...S.writers, { name, color: nextSwatch(S.writers.map((w) => w.color)) }]); }
      catch (err) { if (err.status !== 401 && err.status !== 403) toast(err.message); renderTags(); return; }
    }
    S.kid = null;
    pickKid(existing || name);
  };
}
async function removeKid(k) {
  if (!confirm(`Take ${k} off the bookcase? Their books stay saved.`)) return;
  try { await saveWriters(S.writers.filter((w) => w.name !== k)); }
  catch (err) { if (err.status !== 401 && err.status !== 403) toast(err.message); return; }
  if (S.kid === k) { S.kid = null; LS.set('kid', null); }
  loadShelf();
}

const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
function renderShelf(deal) {
  const phone = phoneQ.matches;
  const caseEl = $('#case');
  const fw = phone ? 108 : 190, fh = phone ? 150 : 250;
  const items = [];
  if (S.kid) items.push({ kind: 'new', w: fw });
  (S.list || []).forEach((s, i) => {
    if (s.cover_url) { items.push({ kind: 'face', s, w: fw }); return; }
    const t = s.title || s.first_line || 'Untitled';
    items.push({ kind: 'spine', s, i, w: (phone ? 44 : 60) + (t.length % 4) * (phone ? 4 : 6), h: (phone ? 150 : 236) + ((t.length * 7 + i * 13) % (phone ? 34 : 26)) });
  });
  caseEl.innerHTML = '';
  const avail = (caseEl.clientWidth || innerWidth - 72) - (phone ? 26 : 50);
  const rows = [[]];
  let used = 0;
  items.forEach((it) => {
    if (used + it.w + 6 > avail && rows[rows.length - 1].length) { rows.push([]); used = 0; }
    rows[rows.length - 1].push(it); used += it.w + 6;
  });
  while (rows.length < (phone ? 3 : 2)) rows.push([]);
  let note = null;
  if (!S.kid) note = 'Choose your name above to see your shelf.';
  else if (S.shelfErr) note = "The bookcase didn't load.";
  else if (S.list && !S.list.length) note = 'Your first story goes here.';
  let n = 0, noted = false;
  rows.forEach((row, ri) => {
    const r = document.createElement('div');
    r.className = 'row';
    row.forEach((it) => {
      const el = bookEl(it, fw, fh);
      if (deal && !reduce) { el.classList.add('shelved'); el.style.animationDelay = 60 + n++ * 50 + 'ms'; }
      r.appendChild(el);
    });
    const left = avail - row.reduce((a, it) => a + it.w + 6, 0);
    if (note && !noted && (!row.length || left > 420)) {
      noted = true;
      const p = document.createElement('p');
      p.className = 'row-empty';
      p.textContent = note;
      if (S.shelfErr && S.kid) { const b = document.createElement('button'); b.className = 'btn small primary'; b.innerHTML = '<svg><use href="#i-redo"/></svg>Try again'; b.onclick = loadShelf; p.append(document.createElement('br'), b); }
      r.appendChild(p);
    } else if (!row.length) {
      r.insertAdjacentHTML('beforeend', '<span class="toy first" aria-hidden="true">🪴</span><span class="toy" aria-hidden="true">🕯️</span>');
    } else if (left > 90) r.insertAdjacentHTML('beforeend', `<span class="toy" aria-hidden="true">${ri === 0 ? '🌍' : '🪴'}</span>`);
    caseEl.appendChild(r);
  });
}
function bookEl(it, fw, fh) {
  const b = document.createElement('button');
  if (it.kind === 'new') {
    b.className = 'faceout new';
    b.style.cssText = `--fw:${fw}px;--fh:${fh}px`;
    b.innerHTML = '<span class="plus"><svg><use href="#i-plus"/></svg></span><b>New story</b>';
    b.setAttribute('aria-label', 'New story');
    b.onclick = () => newStory(b);
    return b;
  }
  const title = it.s.title || it.s.first_line || 'Untitled'; // first_line: the kid's own short first line, when the list sends it
  b.dataset.id = it.s.id;
  b.setAttribute('aria-label', title);
  b.onclick = () => openStory(it.s.id, { fromEl: b }).catch(() => {});
  if (it.kind === 'face') {
    b.className = 'faceout';
    b.style.cssText = `--fw:${fw}px;--fh:${fh}px`;
    b.innerHTML = `<img ${imgAttrs(it.s.cover_url, `${fw}px`, { src: 480 })} alt="" loading="lazy" decoding="async"><span class="ft">${esc(title)}</span>`; // ~25 KB, not a 3.5 MB PNG
  } else {
    const t = ['--accent', '--accent-2', '--accent-3'][hash(it.s.id) % 3];
    const col = it.i % 2 ? `color-mix(in srgb, var(${t}) 78%, var(--ink))` : `var(${t})`;
    b.className = 'spine';
    b.style.cssText = `--w:${it.w}px;--h:${it.h}px;--col:${col};--lean:${it.i % 3 === 2 ? -2 : 0}deg`;
    b.innerHTML = `<span class="band"></span><span class="label">${esc(title)}</span>`;
  }
  return b;
}
addEventListener('resize', () => { if (S.screen === 'shelf') renderShelf(false); });

/* grown-ups corner: theme, live words, the design gallery */
function renderThemes() {
  const box = $('#gp-themes');
  box.innerHTML = '';
  for (const t of window.STORY_THEMES.list) {
    const b = document.createElement('button');
    b.textContent = THEME_NAMES[t] || t;
    b.dataset.theme = t;
    b.classList.toggle('on', t === window.STORY_THEMES.current);
    b.onclick = () => setTheme(t);
    box.appendChild(b);
  }
  $('#gp-live').checked = LS.get('live', true);
  const rb = $('#gp-reader');
  rb.innerHTML = '';
  for (const [k, name] of Object.entries(SKINS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.dataset.reader = k;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === readerSkin()));
    b.classList.toggle('on', k === readerSkin());
    b.onclick = () => { LS.set('reader', k); if (S.read) S.read.setSkin(k); renderThemes(); };
    rb.appendChild(b);
  }
}
function setTheme(t) {
  try { localStorage.setItem('stories.theme', t); } catch { /* private mode */ }
  const link = $('#theme-css');
  link.addEventListener('load', () => { if (S.screen === 'shelf') renderShelf(false); }, { once: true });
  link.href = '/themes/' + t + '.css';
  const html = document.documentElement;
  [...html.classList].filter((c) => c.startsWith('theme-')).forEach((c) => html.classList.remove(c));
  html.classList.add('theme-' + t);
  window.STORY_THEMES.current = t;
  const u = new URL(location.href);
  if (u.searchParams.has('theme')) { u.searchParams.delete('theme'); history.replaceState(null, '', u); }
  renderThemes();
}
$('#grownups-btn').onclick = () => {
  const p = $('#grownups-panel');
  p.hidden = !p.hidden;
  $('#grownups-btn').setAttribute('aria-expanded', String(!p.hidden));
};
$('#gp-live').onchange = (e) => LS.set('live', e.target.checked);

/* ---------------- 3. the desk ---------------- */
async function openStory(id, { fromEl = null, step = 'write' } = {}) {
  if (fromEl && !reduce) fromEl.classList.add('pull');
  let st;
  try { st = await api('GET', '/api/stories/' + encodeURIComponent(id)); }
  catch (e) {
    if (fromEl) fromEl.classList.remove('pull');
    if (e.status === 404) { LS.set('story', null); if (fromEl) { toast('That story is missing.'); loadShelf(); } }
    else if (e.status !== 401 && fromEl) toast(e.message, { retry: () => openStory(id, { step }).catch(() => {}) });
    throw e;
  }
  if (fromEl && !reduce) setTimeout(() => showDesk(st, step), 360); else showDesk(st, step);
}
async function newStory(fromEl) {
  if (!S.kid) { toast('Choose your name first.'); return; }
  if (fromEl && !reduce) fromEl.classList.add('pull');
  let st;
  try { st = await api('POST', '/api/stories', { author: S.kid }); }
  catch (e) { if (fromEl) fromEl.classList.remove('pull'); if (e.status !== 401) toast(e.message, { retry: () => newStory() }); return; }
  window.saybookAnalytics?.capture('story_started', { surface: 'kid', operation: 'story', ok: true });
  showDesk(st, 'write');
}
function showDesk(st, step) {
  closeStory();
  S.story = st;
  S.voice = st.voice_id && S.voices.some((v) => v.id === st.voice_id) ? st.voice_id : (S.voices[0] && S.voices[0].id) || null;
  $('#me-name').textContent = st.author;
  $('.name-tag').style.setProperty('--tag', colorOf(st.author));
  paintShare();
  // One reader per open story, shared by Write and Read: a page read in one is free and instant in the other.
  S.reader = createReader({ api, player, storyId: st.id, onCost: (d) => addCost(st, d) });
  S.writer = mountWrite($('#write-surface'), st, {
    api, toast, kid: S.kid || st.author, live: LS.get('live', true),
    onChange: () => { if (S.read && S.story === st) S.read.refresh(); },
    onText: (t) => { st.text = t; queueSave(st, 'text'); },
    onTitle: (t) => { st.title = t; queueSave(st, 'title'); },
    flush: () => flushSave(),
    audio: { player, prime: primeAudio },
    reader: S.reader,
    voices: () => S.voices,
    voice: () => (S.voice && S.voice !== 'own' ? S.voice : (S.voices[0] || {}).id),
    setVoice: (id) => { S.voice = id; },
  });
  S.read = mountRead($('#read-surface'), st, {
    api, reader: S.reader, player, prime: primeAudio, writer: S.writer, toast, kid: S.kid || st.author, skin: readerSkin(),
    voices: () => S.voices,
    voice: () => S.voice,
    setVoice: (id) => { S.voice = id; if (id !== 'own' && S.writer) S.writer.refreshVoices(); },
    chrome: (on) => { app.dataset.chrome = on ? 'on' : 'off'; },
    onWrite: () => setStep('write'),
  });
  S.step = null;
  go('desk');
  setStep(step === 'read' ? 'read' : 'write', { instant: true });
}
function closeStory() {
  stopReading();
  if (S.read) { S.read.unmount(); S.read = null; }
  if (S.writer) { S.writer.unmount(); S.writer = null; }
  if (S.reader) { S.reader.dispose(); S.reader = null; }
  S.story = null;
}
function setStep(step, { instant = false } = {}) {
  const prev = S.step;
  if (step !== prev) {
    if (step === 'read' && S.writer) S.writer.stop(); // finish typing; a recording keeps transcribing
    if (step === 'write') { if (S.read) S.read.leave(); if (S.writer) S.writer.refreshVoices(); }
  }
  S.step = step;
  app.dataset.step = step;
  app.dataset.chrome = 'on';
  $$('.ribbon').forEach((r) => r.classList.toggle('on', r.dataset.step === step));
  if (!instant && !reduce && prev && step !== prev) {
    const rib = $(`.ribbon[data-step="${step}"]`);
    rib.classList.remove('swing'); void rib.offsetWidth; rib.classList.add('swing');
  }
  if (step === 'read') { flushSave(); if (S.read) S.read.enter(); closeChat(); }
  remember();
}
$$('.ribbon').forEach((r) => r.addEventListener('click', () => { if (r.dataset.step !== S.step) setStep(r.dataset.step); }));

async function toShelf() {
  if (S.leaving) return;
  const st = S.story, w = S.writer;
  stopReading();
  if (S.read) S.read.leave();
  if (w && w.state !== 'idle') {
    // Words are still being written down: wait so none are lost.
    S.leaving = true;
    $('#desk-back').classList.add('busy');
    try { await w.stop(); } catch { /* the writer reports its own trouble */ }
    $('#desk-back').classList.remove('busy');
    S.leaving = false;
  }
  await flushSave();
  if (w && st && st.text.trim()) w.settleAll(); // the last paragraph joins the book; its pictures are painted next time it's opened
  if (st && !st.text.trim() && !st.title.trim() && !st.own_audio_url && !(st.scenes || []).length) {
    await api('DELETE', '/api/stories/' + encodeURIComponent(st.id)).catch(() => {}); // an empty story: tidy it away
  }
  closeStory();
  LS.set('story', null);
  go('shelf');
}
$('#desk-back').onclick = toShelf;

/* saving: one PUT at a time, with the newest values at send time */
let pend = null, saveT = 0, saveFails = 0, chain = Promise.resolve();
function queueSave(st, field, delay = 900) {
  if (pend && pend.st !== st) flushSave();
  if (!pend) pend = { st, f: new Set() };
  pend.f.add(field);
  clearTimeout(saveT);
  saveT = setTimeout(flushSave, delay);
}
function flushSave(keepalive = false) {
  clearTimeout(saveT);
  const p = pend;
  pend = null;
  if (!p) return chain;
  chain = chain.then(async () => {
    const body = {};
    p.f.forEach((k) => { body[k] = p.st[k]; });
    try { await api('PUT', '/api/stories/' + encodeURIComponent(p.st.id), body, { keepalive }); saveFails = 0; }
    catch (e) {
      if (!pend) pend = p; else if (pend.st === p.st) p.f.forEach((f) => pend.f.add(f));
      if (e.status === 401) return; // retried after the passcode (boot flushes first)
      if (++saveFails === 2) toast("Can't save right now. Keep going; it will keep trying.");
      clearTimeout(saveT);
      saveT = setTimeout(flushSave, 4000);
    }
  });
  return chain;
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(true); });
addEventListener('pagehide', () => flushSave(true));

/* ---------------- read-aloud, shared by Write (a page, "Read my book") and Read (read.js) ---------------- */
const player = $('#player');

// What reading aloud has cost (ElevenLabs, exact credits): the grown-ups' line at the end of the book.
function addCost(st, d) {
  if (!d || !(d.usd > 0)) return;
  const c = st.cost || { elevenlabs_usd: 0, readings: 0 };
  st.cost = { elevenlabs_usd: +(c.elevenlabs_usd + d.usd).toFixed(4), readings: (c.readings || 0) + 1 };
  if (S.story === st && S.writer && S.writer.refreshCost) S.writer.refreshCost();
}
function primeAudio() {
  if (player.dataset.primed) return;
  player.dataset.primed = '1';
  try { player.src = SILENT; const p = player.play(); if (p) p.catch(() => {}); } catch { /* best effort */ }
}
function stopReading() { if (S.read) S.read.stop(); if (S.writer && S.writer.stopReading) S.writer.stopReading(); }

/* ---------------- share: a read-only link to the book (/b/<token>) ---------------- */
// Anyone with the link can read the book and hear pages already read aloud; nobody can change it. In the hosted
// service making or stopping a link asks for the parent password (it shows a child's book outside the family).
const shareDlg = $('#share');
const shareUrl = (s) => new URL(s.url, location.origin).href;
function paintShare() {
  const st = S.story, s = st && st.share;
  $('#share-btn').classList.toggle('on', !!s);
  $('#share-btn').setAttribute('aria-label', s ? 'Shared. Change sharing' : 'Share this book');
  if (!shareDlg.open) return;
  $('#share-off').hidden = !!s; $('#share-on').hidden = !s;
  $('#share-title').textContent = (st && (st.title || st.text.trim().split('\n')[0].slice(0, 70))) || 'Your book';
  if (s) {
    $('#share-link').value = shareUrl(s);
    $('#share-who').textContent = s.show_author ? `The link shows that ${st.author} wrote it.` : 'The link doesn’t say who wrote it.';
  }
  $('#share-make').disabled = !$('#share-consent').checked;
  $('#share-send').hidden = !navigator.share;
}
$('#share-btn').onclick = () => {
  if (!S.story) return;
  if (!S.story.text.trim()) { toast('Write your story first, then you can share it.'); return; }
  $('#share-consent').checked = false; $('#share-author-0').checked = false; $('#share-err').hidden = true; // every link is a fresh, deliberate choice
  shareDlg.showModal();
  paintShare();
};
$('#share-consent').onchange = paintShare;
// Making a link needs the grown-up's own tick on the disclosure box (sent as disclosure_consent with the notice version;
// the hosted server records it with the link). Who wrote it is a separate choice. Changing it later: stop, then share again.
const SHARE_NOTICE = '2026-11-02';
async function setShare(on) {
  const st = S.story;
  if (!st) return;
  if (on && !$('#share-consent').checked) return;
  $$('#share button').forEach((b) => { b.disabled = true; });
  $('#share-err').hidden = true;
  try {
    if (on) st.share = await api('POST', `/api/stories/${encodeURIComponent(st.id)}/share`, { show_author: $('#share-author-0').checked, disclosure_consent: true, notice_version: SHARE_NOTICE });
    else { await api('DELETE', `/api/stories/${encodeURIComponent(st.id)}/share`); st.share = null; $('#share-consent').checked = false; }
    if (on) window.saybookAnalytics?.capture('story_shared', { surface: 'kid', operation: 'share', ok: true });
  } catch (e) {
    const msg = e.status === 404 || e.status === 405 ? 'Sharing isn’t switched on for this server yet.'
      : e.detail === 'sharing_consent_required' || e.message === 'sharing_consent_required' ? 'Tick the box to share this book outside the family.'
      : e.status !== 401 && e.message !== 'cancelled' && e.status !== 402 ? e.message : '';
    if (msg) { $('#share-err').textContent = msg; $('#share-err').hidden = !!st.share; if (st.share) toast(msg); }
  }
  $$('#share button').forEach((b) => { b.disabled = false; });
  paintShare();
}
$('#share-make').onclick = () => setShare(true);
$('#share-stop').onclick = () => setShare(false);
$('#share-copy').onclick = async () => {
  const inp = $('#share-link');
  try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand('copy'); }
  const b = $('#share-copy'), was = b.lastChild.textContent;
  b.lastChild.textContent = 'Copied'; b.classList.add('done');
  setTimeout(() => { b.lastChild.textContent = was; b.classList.remove('done'); }, 1600);
};
$('#share-send').onclick = () => {
  const st = S.story;
  navigator.share({ title: st.title || APP_NAME, text: 'I made a book. Read it here:', url: $('#share-link').value }).catch(() => {});
};
$('#share-close').onclick = () => shareDlg.close();
shareDlg.addEventListener('click', (e) => { if (e.target === shareDlg) shareDlg.close(); });

/* grown-ups corner links: writers, the self-host status page or the hosted account, sign out */
$('#gp-writers').onclick = () => { $('#grownups-panel').hidden = true; go('writers'); };
$('#gp-signout').onclick = async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  LS.set('story', null); LS.set('kid', null);
  location.replace('/signin/');
};

/* ---------------- the story helper (chat bar) ---------------- */
const chats = new Map(); // story id ('' on the shelf) → [{role, content}], kept in memory for this visit
const chatKey = () => (S.screen === 'desk' && S.story ? S.story.id : '');
const chatEl = $('#chat');
// On the desk the open helper is docked (beside the book on wide screens, under it on narrow ones): the book makes
// room for it instead of being covered (app.css, #app.helper-open).
function openChat() { chatEl.classList.add('open'); app.classList.add('helper-open'); $('#chat-open').setAttribute('aria-expanded', 'true'); }
function closeChat() { chatEl.classList.remove('open'); app.classList.remove('helper-open'); $('#chat-open').setAttribute('aria-expanded', 'false'); }
function say(who, text, html) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  if (html) d.innerHTML = text; else d.textContent = text;
  $('#chat-log').appendChild(d);
  scrollLog();
  return d;
}
function scrollLog() { const l = $('#chat-log'); l.scrollTop = l.scrollHeight; }
function renderChatLog() {
  $('#chat-log').innerHTML = '';
  const hi = S.kid ? `Hi ${S.kid}. ` : '';
  say('bot', chatKey() ? `${hi}Ask me about your story: what could happen next, a name for someone, a better word.` : `${hi}Stuck for an idea? Ask me for a story starter.`);
  for (const m of chats.get(chatKey()) || []) say(m.role === 'user' ? 'me' : 'bot', m.content);
}
async function ask(q) {
  const key = chatKey();
  if (!chats.has(key)) chats.set(key, []);
  const hist = chats.get(key);
  hist.push({ role: 'user', content: q });
  const me = say('me', q);
  const bot = say('bot', '<span class="dots"><i></i><i></i><i></i></span>', true);
  let out = '';
  try {
    const res = await api('POST', '/api/chat', { messages: hist.slice(-16), story_id: key || undefined }, { raw: true });
    if (!res.ok || !res.body) throw new Error('chat ' + res.status);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (p === '[DONE]') continue;
        try { out += JSON.parse(p).t || ''; } catch { /* a partial line */ }
        if (out) { bot.textContent = out; scrollLog(); }
      }
    }
  } catch (e) { if (e.status === 401) return; }
  if (out.trim()) { hist.push({ role: 'assistant', content: out }); return; }
  hist.pop();
  bot.classList.add('err');
  bot.innerHTML = 'The story helper didn\'t answer.<br><button class="btn small"><svg><use href="#i-redo"/></svg>Try again</button>';
  bot.querySelector('button').onclick = () => { me.remove(); bot.remove(); ask(q); };
}
$('#chat-input').addEventListener('focus', openChat);
$('#chat-ico').addEventListener('click', () => { openChat(); $('#chat-input').focus(); });
$('#chat-close').addEventListener('click', closeChat);
$('#chat-open').addEventListener('click', () => { if (chatEl.classList.contains('open')) closeChat(); else { openChat(); $('#chat-input').focus({ preventScroll: true }); scrollLog(); } });
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#chat-input'), q = inp.value.trim();
  openChat();
  if (!q) return;
  inp.value = '';
  ask(q);
});

/* ---------------- start ---------------- */
renderThemes();
boot();

// For the browser E2E (e2e/ui.mjs) and debugging in the console.
window.App = { S, player, get writer() { return S.writer; }, get read() { return S.read; } };
