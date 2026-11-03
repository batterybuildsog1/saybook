// The parent's account (hosted). Every read here needs a fresh parent password (403 parent_auth → kit.askParent).
// Before the first payment: "Start your plan" (Stripe Checkout; the payment is also the parental-consent check, and
// nothing for kids works until it's confirmed). After: writers, this month's allowance as a gentle meter, billing,
// recordings, export and delete. "Open Saybook" ends the 15-minute grown-up session before the kids take over.
import { brand, config, call, askParent, SELLER, priceText, SWATCHES, nextSwatch, normWriters, esc, APP_NAME } from '/kit.js';


const $ = (s) => document.querySelector(s);
brand();
document.querySelectorAll('[data-seller]').forEach((el) => { el.textContent = SELLER; });
document.querySelectorAll('[data-price]').forEach((el) => { el.textContent = priceText(); });
const params = new URLSearchParams(location.search);
const NOTICE_VERSION = '2026-11-02';
const SECTIONS = ['#loading', '#locked', '#start', '#confirming', '#writers-sec', '#month-sec', '#plan-sec', '#rec-sec', '#data-sec', '#gone'];
const only = (...ids) => SECTIONS.forEach((s) => { $(s).hidden = !ids.includes(s); });
const day = (v, utc = false) => { const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', ...(utc ? { timeZone: 'UTC' } : {}) }); };
let A = null, writers = [];

const cfg = await config();
if (cfg.mode !== 'hosted') location.replace('/setup/');

$('#includes').innerHTML = [
  ['A shelf for each writer', 'up to 12'],
  ['Pictures on every page and reading aloud', 'about 8 books a month'],
  ['The story helper and punctuation help', 'when they ask'],
  ['Private links to send a book to friends', ''],
  ['No ads. Download or delete everything, any time.', ''],
].map(([w, s]) => `<li><span class="dot ok"></span><b>${esc(w)}</b><span class="st">${esc(s)}</span></li>`).join('');

// The server's own words about painting times, when it has them (GET /auth/enrollment painting_notice).
fetch('/auth/enrollment', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).then((e) => { if (e && e.painting_notice) $('#paint-note').textContent = e.painting_notice; }).catch(() => {});

async function load() {
  only('#loading');
  let d;
  try { d = await call('GET', '/api/account', undefined, { gate: false }); }
  catch (e) {
    if (e.status === 401) { location.replace('/signin/?next=/account/'); return; }
    if (e.status === 403 && e.data && e.data.error === 'parent_auth') {
      if (await askParent({ why: 'Enter the parent password to open the account.' })) return load();
      only('#locked'); return;
    }
    only('#locked'); $('#locked p').textContent = e.message; return;
  }
  A = d;
  render();
}
$('#unlock').onclick = async () => { if (await askParent({ why: 'Enter the parent password to open the account.' })) load(); };

function render() {
  const a = A.account || {};
  if (!a.child_access) {
    if (params.get('checkout') === 'done') { confirmPayment(); return; }
    only('#start');
    return;
  }
  only('#writers-sec', '#month-sec', '#plan-sec', '#rec-sec', '#data-sec');

  renderMonth(A.usage || {});
  renderPlan(a);
  $('#rec').checked = !!a.recordings_enabled;
  $('#rec-say').textContent = a.recordings_enabled ? 'On. Recordings are kept with their books and deleted with them.' : 'Off.';
  loadWriters();
}

// Stripe tells the server (webhook); the return URL itself unlocks nothing. Wait for the server to say so.
async function confirmPayment() {
  only('#confirming');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, i ? 2500 : 600));
    try { A = await call('GET', '/api/account'); } catch { continue; }
    if (A.account && A.account.child_access) {
      history.replaceState(null, '', '/account/?welcome=1');

      params.delete('checkout'); params.set('welcome', '1');
      render();
      return;
    }
  }
  $('#confirming-p').textContent = 'Stripe hasn’t confirmed it yet. Refresh this page in a minute. If it was cancelled, nothing was charged.';
}

$('#checkout').onclick = async () => {
  const b = $('#checkout'), err = $('#start-err');
  b.disabled = true; err.hidden = true;
  try { const d = await call('POST', '/api/billing/checkout', {}); if (d && d.url) { location.href = d.url; return; } throw new Error('No checkout link came back.'); }
  catch (e) { if (e.message !== 'cancelled') { err.textContent = e.message; err.hidden = false; } }
  b.disabled = false;
};

/* ---- writers: the same list the kids pick from (/api/settings) ---- */
async function loadWriters() {
  try { const d = await call('GET', '/api/settings'); writers = normWriters(d && d.writers); }
  catch (e) { writers = []; }
  renderWriters();
}
function renderWriters() {
  const welcome = params.has('welcome');
  $('#writers-h').textContent = welcome && !writers.length ? 'You’re all set. Who’s writing?' : 'Writers';
  $('#writers-p').textContent = writers.length ? 'Each writer gets a shelf. Tap a colour to change it.' : 'Add each writer. A first name or a nickname is plenty.';
  $('#to-studio-row').hidden = !writers.length;
  const ul = $('#writers');
  ul.innerHTML = '';
  writers.forEach((w, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nm"></span><span class="sw" role="radiogroup" aria-label="Colour"></span><button class="link rm" type="button">Remove</button>`;
    li.querySelector('.nm').textContent = w.name;
    li.querySelector('.rm').setAttribute('aria-label', `Remove ${w.name}`);
    const sw = li.querySelector('.sw');
    SWATCHES.forEach((c, k) => {
      const b = document.createElement('button');
      b.type = 'button'; b.style.setProperty('--c', c);
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(c === w.color));
      b.setAttribute('aria-label', ['Fox', 'Honey', 'Fern', 'Lake', 'Berry', 'Pine'][k]);
      b.onclick = () => saveWriters(writers.map((x, j) => (j === i ? { ...x, color: c } : x)));
      sw.appendChild(b);
    });
    li.querySelector('.rm').onclick = () => { if (confirm(`Take ${w.name} off the bookcase? Their books stay saved.`)) saveWriters(writers.filter((_, j) => j !== i)); };
    ul.appendChild(li);
  });
}
async function saveWriters(next) {
  const err = $('#writers-err');
  err.hidden = true;
  try {
    const d = await call('PUT', '/api/settings', { writers: next });
    const back = normWriters(d && d.writers);
    writers = back.length === next.length ? back.map((w, i) => (typeof d.writers[i] === 'string' ? next[i] : w)) : next;
  } catch (e) {
    if (e.message === 'cancelled') return;
    err.textContent = e.data && e.data.error === 'parental_consent_required' ? 'Start the plan first, then add writers.' : e.message; err.hidden = false;
  }
  renderWriters();
}
$('#addw').onsubmit = (e) => {
  e.preventDefault();
  const name = String(e.target.name.value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name) return;
  if (writers.some((w) => w.name.toLowerCase() === name.toLowerCase())) { e.target.name.value = ''; return; }
  if (writers.length >= 12) { $('#writers-err').textContent = 'A family can have up to 12 writers.'; $('#writers-err').hidden = false; return; }
  e.target.name.value = '';
  saveWriters([...writers, { name, color: nextSwatch(writers.map((w) => w.color)) }]);
};

/* ---- this month: a gentle meter, never a bill ---- */
function renderMonth(u) {
  const pct = Math.max(0, Math.min(1, Number(u.pct) || 0));
  const state = u.paused ? 'paused' : u.state || 'ok';
  const say = {
    ok: 'Plenty left this month.',
    warn: 'Most of this month’s pictures and reading aloud are used.',
    limit: 'This month’s pictures and reading aloud are used up. Kids can keep writing, and their words are saved; the rest starts again when the month resets.',
    paused: `The printing press is paused for everyone right now. Kids can keep writing, and their words are saved. Pictures and reading aloud will be back soon.`,
  }[state] || '';
  $('#month-say').textContent = say;
  const m = $('#meter');
  m.className = 'meter ' + (state === 'limit' || state === 'paused' ? 'limit' : state === 'warn' ? 'warn' : '');
  m.style.setProperty('--p', Math.round(pct * 100) + '%');
  m.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
  m.setAttribute('aria-valuetext', `${Math.round(pct * 100)}% of this month's allowance used`);
  const rows = [];
  if (u.image_allowance) rows.push(['Pictures painted', `${u.images || 0} of ${u.image_allowance}`]);
  else if (u.breakdown && u.breakdown.pictures != null) rows.push(['Pictures painted', String(u.breakdown.pictures)]);
  if (u.breakdown && u.breakdown.readings != null) rows.push(['Read aloud', `${Number(u.breakdown.readings).toLocaleString()} characters`]);
  $('#month-kv').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const reset = u.resets_at || u.period_end;
  $('#month-reset').textContent = reset ? `Resets ${day(reset, true)}.` : ''; // months run on UTC
}

/* ---- plan ---- */
function renderPlan(a) {
  const st = a.subscription_status || a.plan;
  const label = { active: a.cancel_at_period_end ? 'Active until the end of this period' : 'Active', trialing: 'Active', past_due: 'Payment due: update your card', unpaid: 'Payment due: update your card', canceled: 'Cancelled', incomplete: 'Waiting for payment' }[st] || (st ? String(st) : 'Active');
  const rows = [['Plan', `${priceText()} a month`], ['Status', label]];
  if (a.subscription_end) rows.push([a.cancel_at_period_end || st === 'canceled' ? 'Ends' : 'Renews', day(a.subscription_end)]);
  if (a.email) rows.push(['Parent', a.email]);
  if (a.created) rows.push(['Since', day(a.created)]);
  $('#plan-kv').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}
$('#portal').onclick = async () => {
  try { const d = await call('POST', '/api/billing/portal', {}); if (d && d.url) location.href = d.url; }
  catch (e) { if (e.message !== 'cancelled') alert(e.message); }
};

/* ---- recordings ---- */
$('#rec').onchange = async (e) => {
  const on = e.target.checked;
  try {
    await call('PUT', '/api/account', { recordings_enabled: on, notice_version: NOTICE_VERSION });
    A.account.recordings_enabled = on;
  } catch (err) { e.target.checked = !on; if (err.message !== 'cancelled') alert(err.message); }
  $('#rec-say').textContent = A.account.recordings_enabled ? 'On. Recordings are kept with their books and deleted with them.' : 'Off.';
};

/* ---- export and delete ---- */
$('#export').onclick = async () => {
  const b = $('#export'), err = $('#data-err');
  b.disabled = true; err.hidden = true;
  try {
    const d = await call('POST', '/api/account/export', {});
    if (d && typeof d.url === 'string' && Object.keys(d).length <= 2) { location.href = d.url; return; }
    let blob, name = `${APP_NAME.toLowerCase()}-export.json`;
    if (d instanceof Response) {
      blob = await d.blob();
      const m = /filename="?([^";]+)"?/.exec(d.headers.get('content-disposition') || '');
      if (m) name = m[1];
    } else blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { if (e.message !== 'cancelled') { err.textContent = e.message; err.hidden = false; } }
  b.disabled = false;
};
$('#delete').onclick = () => { $('#del-form').hidden = false; $('#del-form').confirm.focus(); };
$('#del-cancel').onclick = () => { $('#del-form').hidden = true; };
$('#del-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#data-err');
  if (e.target.confirm.value.trim() !== 'DELETE') { err.textContent = 'Type DELETE in capitals to confirm.'; err.hidden = false; return; }
  e.target.querySelector('[type="submit"]').disabled = true;
  try { await call('DELETE', '/api/account', { confirmation: 'DELETE' }); only('#gone'); }
  catch (er) { if (er.message !== 'cancelled') { err.textContent = er.message; err.hidden = false; } }
  e.target.querySelector('[type="submit"]').disabled = false;
};

/* ---- leaving: the kids' studio, or sign out ---- */
async function toStudio() {
  await fetch('/auth/lock-parent', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  location.href = '/';
}
$('#open-app').onclick = toStudio;
$('#to-studio').onclick = toStudio;
$('#signout').onclick = async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); location.replace('/home/'); };

load();
