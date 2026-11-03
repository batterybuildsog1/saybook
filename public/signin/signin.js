// Sign in, a new family account (parent email + password + the parent notice), or a new password with the recovery
// code. Hosted API: POST /auth/login, /auth/signup, /auth/recover (src/hosted/auth.js). After sign-up the recovery
// code shows once, then the parent goes to /account/ to start the plan (the payment is also the consent check).
import { analyticsChoice } from '/analytics.js';
import { brand, config, SELLER, REPO_URL, priceText } from '/kit.js';

const $ = (s) => document.querySelector(s);
brand();
document.querySelectorAll('[data-seller]').forEach((el) => { el.textContent = SELLER; });
document.querySelectorAll('[data-price]').forEach((el) => { el.textContent = priceText(); });
$('#repo').href = REPO_URL;
$('#wait-repo').href = REPO_URL;

const params = new URLSearchParams(location.search);
const next = (() => { const n = params.get('next') || '/'; return n.startsWith('/') && !n.startsWith('//') ? n : '/'; })();
const NOTICE_VERSION = '2026-11-02';

const panels = ['#f-in', '#f-new', '#f-recover', '#saved', '#closed', '#f-wait', '#waited'];
function show(id) {
  panels.forEach((p) => { $(p).hidden = p !== id; });
  $('.tabs').hidden = !(id === '#f-in' || id === '#f-new');
  $('#t-in').setAttribute('aria-selected', String(id === '#f-in'));
  $('#t-new').setAttribute('aria-selected', String(id === '#f-new'));
  window.scrollTo(0, 0);
  const f = $(id).querySelector('input');
  if (f) f.focus({ preventScroll: true });
}
$('#t-in').onclick = () => show('#f-in');
$('#t-new').onclick = () => show('#f-new');
$('#to-recover').onclick = () => { $('#f-recover').email.value = $('#f-in').email.value; show('#f-recover'); };
$('#back-in').onclick = () => show('#f-in');
$('#closed-back').onclick = () => show('#f-in');

const cfg = await config();
$('#f-new').analytics_consent.checked = analyticsChoice.get();
if (cfg.mode !== 'hosted') location.replace('/'); // a self-hosted copy has no accounts
if (cfg.signed_in && !params.has('new')) location.replace(next === '/' ? '/account/' : next);
// GET /auth/enrollment {waitlist_only, paid_families, max_accounts, painting_notice}: when every family place is taken,
// new families get an email-only waitlist (no password, no payment, nothing about children).
const enroll = await fetch('/auth/enrollment', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const newFamily = () => show(enroll.waitlist_only ? '#f-wait' : cfg.signup_open === false ? '#closed' : '#f-new');
$('#t-new').onclick = newFamily;
if (params.has('new') || params.has('waitlist')) newFamily(); else show('#f-in');
function waited(msg) { if (msg) $('#waited-p').textContent = msg; show('#waited'); }

function fail(form, msg) { const e = form.querySelector('.err'); e.textContent = msg; e.hidden = false; }
async function post(path, body) {
  let r;
  try { r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { return { status: 0, data: { error: "Can't reach the server. Check the connection." } }; }
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function busy(form, fn) {
  const b = form.querySelector('[type="submit"]');
  b.disabled = true; form.querySelector('.err').hidden = true;
  try { await fn(); } finally { b.disabled = false; }
}

$('#f-in').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.email.value || !f.password.value) { fail(f, 'Enter your email and password.'); return; }
  busy(f, async () => {
    const { status, data } = await post('/auth/login', { email: f.email.value.trim(), password: f.password.value });
    if (status === 200) { location.replace(next === '/' && !(data.account && data.account.child_access) ? '/account/' : next); return; }
    fail(f, status === 401 ? 'That email and password don’t match.' : status === 429 ? 'Too many tries. Wait a few minutes, then try again.' : data.error || 'That didn’t work. Try again.');
  });
};

$('#f-new').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  if (!/^\S+@\S+\.\S+$/.test(f.email.value.trim())) { fail(f, 'Enter your email address.'); f.email.focus(); return; }
  if (f.password.value.length < 8) { fail(f, 'Your password needs at least 8 characters.'); f.password.focus(); return; }
  if (!f.parent.checked || !f.consent.checked) { fail(f, 'Tick both boxes to make the account.'); return; }
  busy(f, async () => {
    const { status, data } = await post('/auth/signup', { email: f.email.value.trim(), password: f.password.value, consent: true, parent: true, notice_version: NOTICE_VERSION, recordings_enabled: false, analytics_consent: f.analytics_consent.checked });
    if (status === 202 || data.waitlisted) { waited(data.message); return; } // full: on the waitlist, no account yet
    if (status === 201 || status === 200) { analyticsChoice.set(f.analytics_consent.checked); savedCode(data.recovery_code, f.email.value.trim()); return; }
    if (data.error === 'signup_closed') { show('#closed'); return; }
    if (data.error === 'weak_password') { fail(f, 'Choose a longer password: at least 8 characters.'); return; }
    fail(f, status === 429 ? 'Too many tries. Wait a few minutes, then try again.' : data.error || 'That didn’t work. Try again.');
  });
};

$('#f-wait').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  if (!/^\S+@\S+\.\S+$/.test(f.email.value.trim())) { fail(f, 'Enter your email address.'); f.email.focus(); return; }
  busy(f, async () => {
    const { status, data } = await post('/auth/waitlist', { email: f.email.value.trim() });
    if (status >= 200 && status < 300) { waited(data.message); return; }
    fail(f, status === 429 ? 'Too many tries. Wait a few minutes, then try again.' : data.error || 'That didn’t work. Try again.');
  });
};

$('#f-recover').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value.length < 8) { fail(f, 'Your new password needs at least 8 characters.'); return; }
  busy(f, async () => {
    const { status, data } = await post('/auth/recover', { email: f.email.value.trim(), recovery_code: f.recovery_code.value.trim(), password: f.password.value });
    if (status === 200) { savedCode(data.recovery_code, f.email.value.trim(), true); return; }
    fail(f, status === 401 ? 'That email and recovery code don’t match.' : data.error === 'weak_password' ? 'Choose a longer password.' : data.error || 'That didn’t work. Try again.');
  });
};

// The recovery code, once. A new one replaces the old after a reset.
function savedCode(code, email, reset = false) {
  if (!code) { location.replace('/account/'); return; }
  $('#code').textContent = code;
  $('#saved-h').textContent = reset ? 'Your new recovery code' : 'Save this code';
  show('#saved');
  $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(code); $('#copy').textContent = 'Copied'; } catch { /* select by hand */ } };
  $('#dl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`${document.title.split(' · ').pop()} recovery code for ${email}\n\n${code}\n\nKeep this somewhere safe. It resets your password.\n`], { type: 'text/plain' }));
    a.download = 'recovery-code.txt'; a.click(); URL.revokeObjectURL(a.href);
  };
  $('#kept').onchange = (e) => { $('#go').disabled = !e.target.checked; };
  $('#go').onclick = () => location.replace(reset ? next : '/account/?welcome=1');
}
