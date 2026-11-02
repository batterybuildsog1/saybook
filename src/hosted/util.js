export const NOTICE_VERSION = '2026-11-02';
export const encoder = new TextEncoder();
export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
export const unhex = str => Uint8Array.from(str.match(/../g) || [], x => parseInt(x, 16));
export const random = (length = 32) => hex(crypto.getRandomValues(new Uint8Array(length)));
export const sha = async str => hex(await crypto.subtle.digest('SHA-256', encoder.encode(str)));
export const enabled = value => String(value) === 'true';
export const micros = value => Math.ceil(Number(value) * 1e6);
export function number(env, key, fallback, min = 0) {
 const n = Number(env[key] ?? fallback);
 if (!Number.isFinite(n) || n < min) throw new Error(`Invalid ${key}`);
 return n;
}
export function json(value, status = 200, extra = {}) {
 return new Response(JSON.stringify(value), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', ...extra,
 }});
}
export function fail(status, error) { const e = new Error(error); e.status = status; throw e; }
export async function body(req, max = 16384) {
 if (Number(req.headers.get('content-length')) > max) fail(413, 'Request too large');
 const reader = req.body?.getReader();
 if (!reader) return {};
 const parts = []; let length = 0;
 for (;;) {
  const { done, value } = await reader.read(); if (done) break;
  length += value.length;
  if (length > max) { await reader.cancel(); fail(413, 'Request too large'); }
  parts.push(value);
 }
 const bytes = new Uint8Array(length); let offset = 0;
 for (const part of parts) { bytes.set(part, offset); offset += part.length; }
 try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'Invalid JSON'); }
}
export function sameOrigin(req) {
 if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
 const origin = req.headers.get('origin');
 if (!origin || origin !== new URL(req.url).origin) fail(403, 'Same-origin request required');
 if (req.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'Same-origin request required');
}
export function safeAccount(account) {
 return { account_id: account.account_id, email: account.email,
  subscription_status: account.subscription_status, subscription_end: account.subscription_end,
  cancel_at_period_end: !!account.cancel_at_period_end, recordings_enabled: !!account.recordings_enabled,
  consent_version: account.consent_version, consent_at: account.consent_at, status: account.status,
  created:account.created, plan:account.subscription_status, child_access:!!account.parent_verified_at, parent_verified_at:account.parent_verified_at, monthly_price_usd: 19.50 };
}
export function testRequest(req, env) {
 return enabled(env.HOSTED_TEST_MODE) && env.STRIPE_MODE !== 'live' &&
  typeof env.HOSTED_TEST_TOKEN === 'string' && env.HOSTED_TEST_TOKEN.length >= 32 &&
  constantEqual(req.headers.get('x-hosted-test-token') || '', env.HOSTED_TEST_TOKEN);
}
export function requireCountry(req, env) {
 const country = env.HOSTED_ALLOWED_COUNTRY;
 if (country && req.cf?.country !== country && !testRequest(req, env)) fail(403, 'country_restricted');
}
export function constantEqual(a, b) {
 const aa = encoder.encode(String(a)), bb = encoder.encode(String(b));
 let diff = aa.length ^ bb.length;
 for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
 return diff === 0;
}
export const mediaPrefix = accountId => `accounts/${accountId}/`;
