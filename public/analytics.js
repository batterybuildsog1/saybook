// analytics.js: opt-in product analytics, following ops/analytics (LAUNCH-PLAN analytics addendum).
// OFF unless all of these hold:
//   - the server names a project key in /api/config (analytics_key). There is no key in this file, no default, and the
//     family project's key is refused outright;
//   - a parent switched it on for this device (account page in hosted, status page when self-hosting);
//   - the Analytics owner's gates in analyticsConfig() pass (hosted: parental consent and a verified budget; self: the
//     self-hoster's own key). Text and inputs are masked, kids' pictures blocked (.kid-screen), console/network off.
// Never loaded on the landing, sign-in or a shared book. Events go through captureSafe (allowlisted names and enums).
import { analyticsConfig, captureSafe, withdrawAnalytics } from './analytics-config.js';

const SDK = 'https://cdn.jsdelivr.net/npm/posthog-js@1.444.4/dist/array.full.no-external.js'; // pinned: the version ops checked
const SRI = 'sha384-N14ALV1z2AwdfrvAZ4xqgvBnZ9i/slMYuxsQkS2Dfch9BBOwOcmE5PRrCbSJNb1S';
const REFUSED = [883182322]; // Fingerprint of an unrelated private project; never route this app there.
const fingerprint = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const LS_KEY = 'saybook.analytics';

export const analyticsChoice = {
  get() { try { return localStorage.getItem(LS_KEY) === 'on'; } catch { return false; } },
  set(on) { try { if (on) localStorage.setItem(LS_KEY, 'on'); else localStorage.removeItem(LS_KEY); } catch { /* private mode */ } },
};
export const analyticsOffered = (cfg) => typeof (cfg && cfg.analytics_key) === 'string' && cfg.analytics_key.startsWith('phc_') && !REFUSED.includes(fingerprint(cfg.analytics_key));

let ph = null;
function loadSdk() {
  if (window.posthog && window.posthog.__loaded) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = SDK; s.integrity = SRI; s.crossOrigin = 'anonymous'; s.async = true; s.referrerPolicy = 'no-referrer';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
}

// surface: 'kid' (the app) or 'parent' (account). Returns the client, or null when it stays off.
export async function startAnalytics(cfg, { surface = 'parent', parentalConsent = false, accountId = '' } = {}) {
  if (ph) return ph;
  if (!analyticsOffered(cfg)) return null;
  const options = analyticsConfig({
    mode: cfg.mode, key: cfg.analytics_key, analyticsConsent: analyticsChoice.get(), parentalConsent, surface,
    publicReader: false, budgetVerified: cfg.analytics_budget_verified === true, replayApproved: cfg.analytics_replay === true,
    ownKey: cfg.mode === 'self',
  });
  if (!options) return null;
  await loadSdk();
  if (!window.posthog || typeof window.posthog.init !== 'function') return null;
  ph = window.posthog.init(cfg.analytics_key, options) || window.posthog;
  if (accountId && /^[a-zA-Z0-9_-]{8,80}$/.test(accountId)) ph.identify(accountId); // the opaque adult account, nothing else
  window.saybookAnalytics = { capture: (event, props) => captureSafe(ph, event, props) };
  return ph;
}
export function capture(event, props) { if (ph) captureSafe(ph, event, props); }
// Switching it off: stop recording, opt out, forget this device's ids.
export function stopAnalytics() {
  analyticsChoice.set(false);
  const p = ph || (window.posthog && window.posthog.__loaded ? window.posthog : null);
  if (p) withdrawAnalytics(p);
  ph = null; window.saybookAnalytics = undefined;
}
