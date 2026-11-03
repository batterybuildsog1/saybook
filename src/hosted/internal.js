// The one insider rule (Alan, 2026-11-02: tell real users from us). See ops/analytics/INSIDERS.md.
// migrations/hosted-005-internal.sql repeats the domain parts in SQL for the backfill; keep the two in step.
export const INTERNAL_DOMAINS = []; // your own team's email domains go in INTERNAL_EMAIL_DOMAINS (comma-separated)
// Reserved test domains (RFC 2606/6761): every E2E suite signs up at one, and no real parent can get mail there.
const TEST_DOMAINS = ['example.com', 'example.net', 'example.org'];
const TEST_TLDS = ['test', 'invalid', 'example', 'localhost'];
export function isInternalEmail(email, env = {}) {
 const e = String(email || '').trim().toLowerCase(), at = e.lastIndexOf('@');
 if (at < 1) return false;
 const domain = e.slice(at + 1);
 const own = String(env.INTERNAL_EMAIL_DOMAINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
 if (INTERNAL_DOMAINS.includes(domain) || own.includes(domain) || TEST_DOMAINS.includes(domain) || TEST_TLDS.includes(domain.split('.').pop())) return true;
 return String(env.INTERNAL_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(e);
}
