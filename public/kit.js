// kit.js: shared by the app and the grown-ups pages (setup, sign-in, account, a shared book).
// The app's name, the writers' colours, the server's public config, a small JSON API helper and the grown-up gate:
// in the hosted service some actions ask for the parent password again (403 {error:"parent_auth"} → /auth/parent).
import { APP_NAME } from './config.js'; // the one name (mirrors src/config.js)
export { APP_NAME };
// The hosted service: where it lives, who sells it, the one plan (checkout itself is set on the server),
// and where the code lives (placeholder until the repo is published). Legal copy is Hosted's.
export const SITE = 'saybook.app';
export const SELLER = 'HVAC Calc LLC';
export const PRICE = { amount: '19.50', currency: 'USD', per: 'month' };
export const REPO_URL = 'https://github.com/batterybuildsog1/saybook';

// Writer colours: mid-tones that read on all three themes and on the grown-ups pages.
export const SWATCHES = ['#d9603b', '#d99a2b', '#5f8f3e', '#3577a8', '#b9466a', '#2b8379'];
export const nextSwatch = (taken = []) => SWATCHES.find((c) => !taken.includes(c)) || SWATCHES[taken.length % SWATCHES.length];
// /api/settings writers: [{name, color}] (legacy: plain names).
export const normWriters = (list) => (Array.isArray(list) ? list : []).map((w, i, all) => {
  const name = String(typeof w === 'string' ? w : (w && w.name) || '').trim();
  const color = w && typeof w === 'object' && /^#[0-9a-f]{6}$/i.test(w.color || '') ? w.color : SWATCHES[i % SWATCHES.length];
  return name ? { name, color } : null;
}).filter(Boolean);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The name goes wherever the page asks for it: [data-app-name] elements, and after the page's own <title>.
export function brand(root = document) {
  root.querySelectorAll('[data-app-name]').forEach((el) => { el.textContent = APP_NAME; });
  const t = document.title.trim();
  document.title = t && t !== APP_NAME ? `${t} · ${APP_NAME}` : APP_NAME;
}

// GET /api/config is public: {app_name, mode:"self"|"hosted", passcode_required, passcode_length?, signed_in?, signup_open?}.
let cfg = null;
export function config() {
  cfg = cfg || fetch('/api/config', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
    .then((c) => ({ mode: 'self', passcode_required: false, ...c }));
  return cfg;
}

// A refused paid call (402 {error:"limit", reason: allowance|billing|breaker|paused}, or HOSTED_PAUSE) means the same
// thing to a kid: the printing press is resting, keep writing. The grown-up sees why on the account page.
export const RESTING = { h: 'The printing press is resting', p: 'Keep writing. Your words are saved, and pictures and reading aloud will be back soon.' };
export function limitNote() { return `${RESTING.h}. ${RESTING.p}`; }

export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }

// JSON in, JSON out. A 403 parent_auth asks for the parent password once and retries.
export async function call(method, path, body, { gate = true } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, init); } catch { throw new ApiError("Can't reach the server. Check the connection.", 0); }
  const data = res.status === 204 ? null : await res.clone().json().catch(() => null);
  if (res.status === 403 && gate && data && data.error === 'parent_auth') {
    if (await askParent()) return call(method, path, body, { gate: false });
    throw new ApiError('cancelled', 403, data);
  }
  if (!res.ok) throw new ApiError((data && (data.message || data.error)) || `Something went wrong (${res.status})`, res.status, data);
  return data === null && res.status !== 204 ? res : data;
}

// The grown-up gate: a small dialog, themed by whatever page it sits on.
let gateEl = null;
export function askParent({ why = 'Enter the parent password to continue.' } = {}) {
  if (!gateEl) {
    gateEl = document.createElement('dialog');
    gateEl.className = 'gate';
    gateEl.innerHTML = `<form method="dialog" class="gate-form">
      <h2 class="gate-h">Grown-ups only</h2>
      <p class="gate-why"></p>
      <label class="gate-field"><span>Parent password</span><input type="password" name="pw" autocomplete="current-password" required minlength="1"></label>
      <p class="gate-err" role="alert" hidden></p>
      <div class="gate-act"><button type="button" class="gate-btn" value="cancel">Cancel</button><button type="submit" class="gate-btn primary">Continue</button></div>
    </form>`;
    document.body.appendChild(gateEl);
  }
  const d = gateEl, f = d.querySelector('form'), inp = f.pw, err = d.querySelector('.gate-err'), ok = f.querySelector('[type="submit"]');
  d.querySelector('.gate-why').textContent = why;
  inp.value = ''; err.hidden = true;
  return new Promise((resolve) => {
    const done = (v) => { f.onsubmit = null; d.onclose = null; if (d.open) d.close(); resolve(v); };
    f.querySelector('[value="cancel"]').onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); done(false); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      ok.disabled = true;
      try {
        const r = await fetch('/auth/parent', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: inp.value }) });
        if (r.ok) { done(true); return; }
        err.textContent = r.status === 401 || r.status === 403 ? 'That password doesn’t match.' : 'That didn’t work. Try again.';
      } catch { err.textContent = "Can't reach the server."; }
      err.hidden = false; ok.disabled = false; inp.select();
    };
    d.showModal();
    inp.focus();
  });
}

// "$19.50" from config.js
export const priceText = () => `$${PRICE.amount}`;
