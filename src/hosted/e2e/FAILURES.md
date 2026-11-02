# Hosted lifecycle E2E failure inventory (written before implementation)

The repeatable E2E must exercise deployed or local Worker HTTP routes with real D1/R2, not mock the hosted modules.

- Public signup succeeds while HOSTED_OPEN is false, or internal bypass works without the test secret.
- Signup lacks affirmative adult/guardian attestation or the exact consent notice version.
- Weak passwords, duplicate accounts, forged cookies, expired/revoked sessions or wrong recovery codes work.
- Foreign Origin state changes, sensitive controls without recent parent authentication, or child narration without recording consent work.
- A parent account exposes another parent's profile, story, scene, upload, narration, generated audio, media, ledger or export.
- Inactive/past-due/canceled subscriptions permit paid work; checkout redirects or client data can activate a plan.
- An invalid, stale, replayed or wrong-mode Stripe webhook changes billing state; out-of-order events resurrect canceled access.
- Checkout sells any amount/currency/interval other than USD 19.50/month or sends untrusted return URLs.
- Text token, image or TTS character cost disappears, is rounded to zero, or is double-booked by a retry.
- Parallel paid calls exceed the reserved account budget or global daily breaker; rate limits can be bypassed by concurrent calls.
- A failed paid call permanently retains an allowance hold; a provider error silently turns into free/unmetered work.
- The 80% warning or gentle limit response is absent; parent usage details are exposed on child routes.
- Account export omits stored stories, recordings, media or costs, or leaks password/session/Stripe secrets.
- Deletion leaves D1 personal rows, R2 objects, usable sessions, runnable queued work, or a subscription charging.
- Deletion failure reports success before cleanup; a retry cannot resume safely.
- Test-only subscription activation or budget controls exist in a production/open Worker.
- Hub 429/quota/limit failures cause retries or fallback to the reserved image key.

Artifact: e2e/out-hosted/<timestamp>/report.json, redacted route results and lifecycle media hashes. Never store cookies, passwords, recovery codes, Stripe signatures or provider keys in artifacts.
