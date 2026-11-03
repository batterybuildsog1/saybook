// The parent's account (hosted, signed in), drawn as the family's library card (redesign B, 2026-11-02). The signup
// ticks are the consent, so kids can write straight away. The card lists every book in the family (the ledger:
// stamped once its pages form, with Stop sharing and Delete book); its stub holds the money: free books left with a
// quiet Plans link, the plan choice once the free books are made (beside the books they made, with the run-it-yourself
// path), or the plan itself. Below: writers, recordings, this month's allowance in books, export and delete.
import { brand, config, call, SELLER, PLANS, FREE_BOOKS, REFUND_NOTE, REPO_URL, SWATCHES, nextSwatch, normWriters, esc, APP_NAME } from '/kit.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
brand();
$$('[data-seller]').forEach((el) => { el.textContent = SELLER; });
$$('[data-repo]').forEach((el) => { el.href = REPO_URL; });
$$('[data-plan-price]').forEach((el) => { el.textContent = PLANS[el.dataset.planPrice].price; });
$$('[data-plan-month]').forEach((el) => { el.textContent = PLANS[el.dataset.planMonth].monthly; });
const params = new URLSearchParams(location.search);
const NOTICE_VERSION = '2026-11-02.2';
const DAY = 864e5;
const SECTIONS = ['#loading', '#load-err', '#confirming', '#card', '#writers-sec', '#panels', '#gone'];
const only = (...ids) => SECTIONS.forEach((s) => { $(s).hidden = !ids.includes(s); });
const day = (v, utc = false) => { const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', ...(utc ? { timeZone: 'UTC' } : {}) }); };
let A = null, writers = [];

const cfg = await config();
if (cfg.mode !== 'hosted') location.replace('/setup/');

async function load() {
  only('#loading');
  let d;
  try { d = await call('GET', '/api/account'); }
  catch (e) {
    if (e.status === 401) { location.replace('/signin/?next=/account/'); return; }
    $('#load-err-p').textContent = e.message;
    only('#load-err'); $('#retry').focus(); return;
  }
  A = d;
  render();
}
$('#retry').onclick = load;

const paid = (a) => a.subscription_status === 'active' && a.subscription_end > Date.now();
// A complimentary plan has no Stripe subscription; the server marks it active until 2100. No paid Stripe period runs
// more than about 13 months ahead, so an end date past 400 days means there's nothing to bill.
const comped = (a) => paid(a) && a.subscription_end > Date.now() + 400 * DAY;
function render() {
  const a = A.account || {}, u = A.usage || {};
  if (params.get('checkout') === 'done' && !paid(a)) { confirmPayment(); return; }
  const free = !paid(a), stripe = !!a.subscription_status && a.subscription_status !== 'none';
  only('#card', '#writers-sec', '#panels');
  $('#who').textContent = a.email || '';
  $('#books-sec').hidden = !free;
  $('#plan-sec').hidden = !stripe;
  if (free) renderBooks(A.books || {}, u);
  else { $('#books-h').textContent = 'Your library card'; $('#card-say').hidden = true; $('#diy').hidden = true; }
  if (stripe) renderPlan(a);
  $('#month-sec').hidden = false;
  renderMonth(u, paid(a));
  $('#rec').checked = !!a.recordings_enabled;
  $('#rec-say').textContent = a.recordings_enabled ? 'On. Recordings are kept with their books and deleted with them.' : 'Off.';
  loadWriters();
}

/* ---- the free books, then a plan ---- */
function renderBooks(b, u) {
  const total = b.free_books || FREE_BOOKS, left = Math.max(0, b.free_books_left ?? total);
  const out = left === 0;
  $('#books-h').textContent = out ? 'The free books are made' : 'Your library card';
  $('#card-say').hidden = false;
  $('#card-say').textContent = out
    ? 'Kids keep writing, and every book and draft stays saved. Pick a plan to make new ones.'
    : 'A book is stamped once its first pages form. Kids keep writing either way.';
  $('#books-say').innerHTML = `<span class="stub-fig">${left}</span> of ${total} free books left.<br>No card.`;
  $('#books-say').hidden = out;
  $('#plan-small').innerHTML = `About ${Number(u.about_books) || 8} picture books a month on either plan. Sold by ${esc(SELLER)}.`;
  const open = out || params.has('plan');
  $('#plan-form').hidden = !open; $('#show-plans').hidden = open;
  $('#diy').hidden = !out;
  planTerms();
}
const chosen = () => ($('#plan-form').plan.value === 'monthly' ? 'monthly' : 'annual');
function planTerms() {
  $('#plan-terms').innerHTML = `${esc(PLANS[chosen()].terms)} ${esc(REFUND_NOTE)} <a href="/legal/refunds" target="_blank">Refund policy</a>`;
}
$('#plan-form').onchange = planTerms;
$('#show-plans').onclick = () => { $('#plan-form').hidden = false; $('#show-plans').hidden = true; $('#plan-form').plan[0].focus(); };
$('#plan-form').onsubmit = async (e) => {
  e.preventDefault();
  const b = $('#checkout'), err = $('#plan-err');
  b.disabled = true; err.hidden = true;
  try { const d = await call('POST', '/api/billing/checkout', { plan: chosen() }); if (d && d.url) { location.href = d.url; return; } throw new Error('No checkout link came back.'); }
  catch (er) { err.textContent = er.message; err.hidden = false; }
  b.disabled = false;
};

// Stripe tells the server (webhook); the return URL itself changes nothing. Wait for the server to say so.
async function confirmPayment() {
  only('#confirming');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, i ? 2500 : 600));
    try { A = await call('GET', '/api/account'); } catch { continue; }
    if (A.account && paid(A.account)) {
      history.replaceState(null, '', '/account/');
      params.delete('checkout');
      render();
      return;
    }
  }
  $('#confirming-p').textContent = 'Stripe hasn’t confirmed it yet. Refresh this page in a minute. If it was cancelled, nothing was charged.';
}

/* ---- writers: the same list the kids pick from (/api/settings) ---- */
let placed = false;
async function loadWriters() {
  try { const d = await call('GET', '/api/settings'); writers = normWriters(d && d.writers); }
  catch (e) { writers = []; }
  // A new family's first job is naming the writers, so Writers leads until there are some; otherwise the card leads.
  // Decided once per visit, so adding the first writer doesn't move the form away.
  if (!placed) { placed = true; if (!writers.length) $('#main').insertBefore($('#writers-sec'), $('#card')); else $('#panels').prepend($('#writers-sec')); }
  renderWriters();
  loadLibrary();
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
    li.querySelector('.rm').onclick = () => removeWriter(w.name);
    ul.appendChild(li);
  });
}
async function saveWriters(next, deleteBooks) {
  const err = $('#writers-err');
  err.hidden = true;
  try {
    const d = await call('PUT', '/api/settings', { writers: next, delete_books: deleteBooks });
    const back = normWriters(d && d.writers);
    writers = back.length === next.length ? back.map((w, i) => (typeof d.writers[i] === 'string' ? next[i] : w)) : next;
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  }
  renderWriters();
  if (deleteBooks) loadLibrary();
}
// Removing a writer deletes their books and turns off their share links (the server does it, src/worker.js).
async function removeWriter(name) {
  let n;
  try { n = (await call('GET', '/api/stories?author=' + encodeURIComponent(name))).length; }
  catch (e) { $('#writers-err').textContent = e.message; $('#writers-err').hidden = false; return; }
  const what = n === 1 ? 'their 1 book and turns off its share link' : `their ${n} books and turns off their share links`;
  if (!confirm(n ? `Remove ${name}? This deletes ${what}. It can’t be undone.` : `Remove ${name}?`)) return;
  saveWriters(writers.filter((w) => w.name !== name), [name]);
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

/* ---- books: every book in the family, for the grown-up. The kids' studio has no delete. ---- */
let library = [];
async function loadLibrary() {
  try { library = await call('GET', '/api/stories'); } catch (e) { library = []; }
  renderLibrary();
}
function renderLibrary() {
  const ul = $('#library');
  ul.innerHTML = '';
  $('#library-empty').hidden = library.length > 0;
  library.forEach((b) => {
    const title = b.title || b.first_line || 'Untitled';
    const li = document.createElement('li');
    // The stamp: a book whose pages formed has scenes (that's when it counts as one of the free books).
    const stamp = b.scene_count == null ? '' : b.scene_count > 0 ? '<span class="stamp">Made</span>' : '<span class="stamp draft">Draft</span>';
    li.innerHTML = `${b.cover_url ? '<img class="pic" alt="" loading="lazy">' : '<span class="pic" aria-hidden="true"></span>'}<span class="nm"><span class="t"></span><span class="by"></span></span><span class="st">${stamp}</span><span class="acts">${b.shared ? '<button class="link" type="button" data-act="unshare">Stop sharing</button>' : ''}<button class="link" type="button" data-act="delete">Delete book</button></span>`;
    if (b.cover_url) li.querySelector('img').src = b.cover_url;
    li.querySelector('.t').textContent = title;
    li.querySelector('.by').textContent = b.shared ? `${b.author} · shared by link` : b.author;
    const act = (k) => li.querySelector(`[data-act="${k}"]`);
    if (b.shared) act('unshare').onclick = () => bookAction(() => call('DELETE', `/api/stories/${encodeURIComponent(b.id)}/share`));
    act('delete').onclick = () => { if (confirm(`Delete “${title}”? Its pages, pictures and share link go too. It can’t be undone.`)) bookAction(() => call('DELETE', `/api/stories/${encodeURIComponent(b.id)}`)); };
    ul.appendChild(li);
  });
}
async function bookAction(run) {
  const err = $('#library-err');
  err.hidden = true;
  $$('#library button').forEach((x) => { x.disabled = true; });
  try { await run(); } catch (e) { err.textContent = e.message; err.hidden = false; }
  loadLibrary();
}

/* ---- this month: a gentle meter, never a bill. With a plan it's said in books, since that's what a parent counts;
   before a plan the free books are the count, so it only says whether there's room. Every account has the allowance. ---- */
function renderMonth(u, withPlan) {
  const pct = Math.max(0, Math.min(1, Number(u.pct) || 0));
  const state = u.paused ? 'paused' : u.state || 'ok';
  const about = Number(u.about_books) || 8, left = Math.round(about * (1 - pct));
  const say = {
    limit: 'This month’s pictures and reading aloud are used up. Kids can keep writing, and their words are saved; the rest starts again when the month resets.',
    paused: 'The printing press is paused for everyone right now. Kids can keep writing, and their words are saved. Pictures and reading aloud will be back soon.',
  }[state] || (!withPlan ? (state === 'warn' ? 'Most of this month’s pictures and reading aloud are used.' : 'Plenty left this month.') : left >= 1 ? `About ${left} of ${about} books left this month.` : 'Less than a book left this month.');
  $('#month-say').textContent = say;
  const m = $('#meter');
  m.className = 'meter ' + (state === 'limit' || state === 'paused' ? 'limit' : state === 'warn' ? 'warn' : '');
  m.style.setProperty('--p', Math.round(pct * 100) + '%');
  m.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
  m.setAttribute('aria-valuetext', `${Math.round(pct * 100)}% of this month's allowance used`);
  const reset = u.resets_at || u.period_end;
  const pics = u.image_allowance ? `Pictures painted: ${u.images || 0} of ${u.image_allowance}, counting character portraits.` : '';
  $('#month-note').textContent = [pics, reset ? `Resets ${day(reset, true)}.` : ''].filter(Boolean).join(' '); // months run on UTC
}

/* ---- the plan, in the card's stub ---- */
function renderPlan(a) {
  const st = a.subscription_status || a.plan, comp = comped(a);
  const label = { active: a.cancel_at_period_end ? 'Active until the end of this period' : 'Active', trialing: 'Active', past_due: 'Payment due: update your card', unpaid: 'Payment due: update your card', canceled: 'Cancelled', incomplete: 'Waiting for payment' }[st] || (st ? String(st) : 'Active');
  const p = PLANS[a.billing_plan];
  const rows = comp ? [['Plan', 'Complimentary']] : [['Plan', p ? `${a.billing_plan === 'annual' ? 'Yearly' : 'Monthly'}, ${p.price} ${p.per}` : '—'], ['Status', label]];
  if (!comp && a.subscription_end) rows.push([a.cancel_at_period_end || st === 'canceled' ? 'Ends' : 'Renews', day(a.subscription_end)]);
  $('#plan-kv').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#comp-note').hidden = !comp;
  ['#portal', '#switch-note', '#seller-note'].forEach((id) => { $(id).hidden = comp; });
}
$('#portal').onclick = async () => {
  try { const d = await call('POST', '/api/billing/portal', {}); if (d && d.url) location.href = d.url; }
  catch (e) { alert(e.message); }
};

/* ---- recordings ---- */
$('#rec').onchange = async (e) => {
  const on = e.target.checked;
  try {
    await call('PUT', '/api/account', { recordings_enabled: on, notice_version: NOTICE_VERSION });
    A.account.recordings_enabled = on;
  } catch (err) { e.target.checked = !on; alert(err.message); }
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
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  b.disabled = false;
};
$('#delete').onclick = () => { $('#del-form').hidden = false; $('#del-form').confirm.focus(); };
$('#del-cancel').onclick = () => { $('#del-form').hidden = true; };
$('#del-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#data-err');
  if (e.target.confirm.value.trim() !== 'DELETE') { err.textContent = 'Type DELETE in capitals to confirm.'; err.hidden = false; return; }
  e.target.querySelector('[type="submit"]').disabled = true;
  try {
    await call('DELETE', '/api/account', { confirmation: 'DELETE' });
    // Signed out now: the bar offers the way back in, not the account.
    $('#nav').innerHTML = '<a href="/signin/">Sign in</a>'; $('.mark').href = '/home/';
    only('#gone');
  }
  catch (er) { err.textContent = er.message; err.hidden = false; }
  e.target.querySelector('[type="submit"]').disabled = false;
};

/* ---- leaving: the kids' studio, or sign out ---- */
const toStudio = () => { location.href = '/'; };
$('#open-app').onclick = toStudio;
$('#to-studio').onclick = toStudio;
$('#signout').onclick = async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); location.replace('/home/'); };

load();
