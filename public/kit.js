// kit.js: shared by the app and the grown-ups pages (setup, sign-in, account, a shared book).
// The app's name, the writers' colours, the server's public config and a small JSON API helper.
import { APP_NAME } from './config.js'; // the one name (mirrors src/config.js)
export { APP_NAME };
// The hosted service: where it lives, who sells it, the free books and the two plans after them (checkout validates
// the real Stripe prices on the server: src/hosted/billing.js),
// and where the code lives (placeholder until the repo is published). Legal copy is Hosted's.
export const SITE = 'saybook.app';
export const SELLER = 'HVAC Calc LLC';
export const FREE_BOOKS = 5;
export const PLANS = {
  annual: { price: '$140.40', per: 'a year', monthly: '$11.70', terms: '$140.40 today, then every year until you cancel.' },
  monthly: { price: '$19.50', per: 'a month', terms: '$19.50 today, then every month until you cancel.' },
};
export const REFUND_NOTE = 'Charges are non-refundable except where the law requires.';
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

// A refused paid call (402 {error:"limit", reason: allowance|breaker|paused}, or HOSTED_PAUSE) means the same thing to a
// kid: the printing press is resting, keep writing. The grown-up sees why on the account page. reason free_books_used
// (the five free books are made) asks for a grown-up instead; the kid never sees a price.
export const RESTING = { h: 'The printing press is resting', p: 'Keep writing. Your words are saved, and pictures and reading aloud will be back soon.' };
export const ASK = { h: 'Ask a grown-up', p: 'All the free books are made, and your words are saved. A grown-up can keep the books coming.' };
export function limitNote(reason) { const n = reason === 'free_books_used' ? ASK : RESTING; return `${n.h}. ${n.p}`; }

export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }

// JSON in, JSON out.
export async function call(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, init); } catch { throw new ApiError("Can't reach the server. Check the connection.", 0); }
  const data = res.status === 204 ? null : await res.clone().json().catch(() => null);
  if (!res.ok) throw new ApiError((data && (data.message || data.error)) || `Something went wrong (${res.status})`, res.status, data);
  return data === null && res.status !== 204 ? res : data;
}

