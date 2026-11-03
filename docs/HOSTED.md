# Saybook hosted operations

Operator and seller: **HVAC Calc LLC**. Product domain: **saybook.app**. Price: **US $19.50 per month**. The published Saybook legal notices in `public/legal/` describe its implemented practices and explicit assurance gaps. Other deployment operators must substitute their own facts. Operator policies: [security program](INFORMATION-SECURITY.md), [retention schedule](DATA-RETENTION.md), [refunds and cancellation](REFUNDS.md). This document records implemented behavior and remaining launch setup; it is not a compliance certification.

## Parent account and sign-in

The account belongs to an adult parent/legal guardian. Writer nicknames and colours live in the account’s `settings.writers` row and have **no logins**. `/api/account/profiles` is a parent-only alias of that same list.

Email + a 14–256 character parent password was chosen for tonight: there is no mail sender to configure and no new identity vendor/account. Email is a contact/login identifier, **not a verified email claim**. Passwords use PBKDF2-SHA256, a random 256-bit salt and a separately stored server-side HMAC pepper (`HOSTED_AUTH_PEPPER`). PBKDF2 uses the Workers WebCrypto ceiling of 100,000 iterations. A random 192-bit recovery code is shown once; only its hash is stored. No support/email password-reset backdoor exists. Losing both password and code requires operator-assisted identity handling, not a guessed email reset.

Sessions use random 256-bit tokens, only hashes in D1, 30-day expiry, Secure/HttpOnly/SameSite=Strict `__Host-storybook` cookies. Sign-out revokes the server session. Parent-sensitive actions need a password recheck after 15 minutes; entering the child studio should call `/auth/lock-parent` immediately. Recovery revokes all prior sessions and rotates the recovery code. Origin checks and separate per-IP/per-identifier sign-in throttles protect writes and login attempts. Do not rotate the auth pepper without a deliberate password-recovery migration.

## Parental consent before any child data

The hosted implementation uses the transaction method in [16 CFR 312.5(b)(2)(ii)](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.5): a credit/debit card or online payment transaction that notifies the primary account holder. **The checkbox alone, an active subscription event, a customer object, a saved card, a free trial and the Checkout return URL do not unlock child use.**

1. The adult reads the direct parent notice (version `2026-11-02`), affirms guardian status and affirmatively consents at signup. No child nickname, story, recording or upload is requested then.
2. Stripe Checkout is restricted to card payments for the $19.50 monthly subscription, with no trial or promotional zero-dollar first payment. Checkout’s submit notice explicitly explains that payment records parental consent. The customer’s invoice footer and subscription description repeat the consent notice/version and withdrawal URL.
3. Only a signature-verified `checkout.session.completed` event, with server-retrieved canonical Checkout and subscription records, `status=complete`, `payment_status=paid`, a positive first payment of at least $19.50, the expected account/customer, correct price and matching consent-notice version records `parent_verified_at` plus the Checkout reference and versioned consent event.
4. Core gates child stories, microphone/transcription, chat, recordings, uploads and writer creation on `child_access`; hosted `allow()` independently requires consent and verified payment. Before that, only parent auth/account/billing functions work.
5. Saved “Read it to me” recordings are separately parent-enabled and off by default. Dictation audio is processed transiently and is not put in R2. A parent must separately authorize a public share; consent to private creation never automatically permits disclosure. No voice cloning.

**Stripe operator setup:** enable successful-payment receipts/transaction notices for every transaction and validate notification to the primary card account holder. Keep card-only Checkout and no uncharged trials. Stripe receipts to a self-entered email alone are not proof of primary-account-holder notification; the qualifying card/payment-system notification behavior must be verified for the actual payment method. Keep a redacted first-payment/consent/notification artifact before announcing live paid enrollment. The notice and payment together supply this implementation’s VPC method; this is not a blanket declaration of legal compliance.

The compliance brief’s VPC, optional voice, private-by-default, accepted provider risks and no-marketing-tracking guidance have been read. Saybook’s approved HVAC Calc LLC contacts are published. The linked written security program and retention/refund schedules describe current controls and unresolved assurances. Provider/recovery/log retention and primary-cardholder notification evidence remain release checks; policy publication alone does not verify them.

## Billing

`POST /api/billing/checkout` retrieves and validates the configured Price: USD, 1950 cents, recurring monthly, quantity one, and correct live/test mode. It creates a scoped Stripe customer and idempotent Checkout session. Return URLs come from the request origin, never request JSON. Checkout cannot activate access itself. `POST /api/billing/portal` opens the parent’s own Billing Portal. `POST /api/billing/cancel` requests cancellation at period end. Deletion cancels the subscription immediately before removing local account data.

Webhook endpoint: **`/api/billing/webhook`**. Signature validation uses the exact raw body, HMAC-SHA256 of `timestamp.body`, constant-time comparison and a five-minute tolerance. Event IDs are deduplicated transactionally. Live/test mismatches fail. Real deliveries re-read current Stripe state rather than trusting delivery order; account state also rejects older event timestamps and resurrection of a canceled subscription. Only `status=active`, an unexpired period and the expected price permit paid calls; past-due/unpaid/paused/canceled/incomplete/trialing do not.

Subscribe the Stripe endpoint to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`. Use the pinned API version `2026-10-28.endive`. Create/configure a Billing Portal with cancellation and payment-method updates. No Stripe account was created or signed into by this agent.

**Needed configuration/secrets:**

| Name | Meaning |
| --- | --- |
| `STRIPE_MODE` | `test` for the test Worker; `live` only on the intended production deployment |
| `STRIPE_SECRET_KEY` | HVAC Calc LLC `sk_test_…` or `sk_live_…` for that mode; Worker secret |
| `STRIPE_PRICE_ID` | That mode’s USD $19.50/month Price ID |
| `STRIPE_WEBHOOK_SECRET` | That endpoint’s `whsec_…`; distinct test/live endpoint secrets |
| `HOSTED_AUTH_PEPPER` | Random independent secret, at least 32 characters; retain securely |
| `TEXT_API_KEY`, `IMAGE_API_KEY` | Current existing provider gateway `stories` key; never browser-readable |
| `ELEVENLABS_API_KEY` | Authorized existing ElevenLabs key; dedicated product key can replace it |

No Stripe publishable key is needed: Checkout and Portal are server redirects. Test/live secret files will be read only from the paths supplied in the launch plan; never print keys or commit them.

## Usage and provider gateway protection

`allow()` atomically inserts a reservation in one conditional D1 write. Concurrent requests see each other’s held dollars/images/tokens/characters. `charge()` replaces the hold with a stable per-call ledger entry in a D1 transaction; retries with the same call ID cannot double-book it. `finish()` releases unused holds, retaining zero-value attempt rows for rate limiting. Paid provider attempts with unknown billing outcomes must be charged by Core at their conservative bound, with `estimate:true`; a provider invoice is not fabricated. Successful text records actual reported input/output tokens; images record attempts; ElevenLabs records synthesized characters/credits and configured paid-credit cost. Provider gateway marginal USD is zero, but quota usage is not free capacity.

Zero-dollar reservations for subscription-backed text/images are selected by `PROVIDER_FLAT_RATE=true`, never by a hostname. Configure actual provider tariffs explicitly when changing that flag.

Initial account limits are **120 image attempts, 1,000,000 text/vision tokens and 50,000 newly synthesized TTS characters per UTC calendar month**. Every portrait, redraw, retry and failed upstream image attempt counts. Cached playback costs zero new characters. The single dollar safety ceiling is `HOSTED_MONTHLY_ALLOWANCE_USD=2.25`, the final benchmark reserve for roughly $2 at public ElevenLabs rates plus tax/current credit conversion. Present the combined allowance as **about 8 typical books**; long books and redraws consume more. There is no rollover. **Capacity:** `HOSTED_MAX_ACCOUNTS=10` paid families is the initial launch default. Checkout atomically reserves one enrollment slot before a payment link is returned. A pending Checkout holds the slot for up to two hours (the actual Checkout expires after 30 minutes); active subscriptions hold it through their paid period. At capacity, signup becomes an email-only waitlist (30-day retention), with no password, account, payment or child data saved. `/auth/enrollment` exposes the state and painting notice; `/auth/waitlist {email}` records a request. There are no automatic emails. Parents see before paying that pictures can take a few minutes, and the first picture took around 6–11 minutes under measured shared load.

These are product allowances, not a claim that the provider gateway has proven capacity for an unlimited number of families.

My reversible operational call is a **global 100-image / 1,000,000-token UTC daily cap**, initially; account admission is 20 attempts/minute and at most four in flight. Dollar daily ceiling is $25 and global TTS character ceiling 500,000. Limits include active holds. Defaults live in `src/hosted/usage.js`; all can be overridden with the following vars:

`HOSTED_MONTHLY_IMAGES`, `HOSTED_MONTHLY_TOKENS`, `HOSTED_MONTHLY_TTS_CHARACTERS`, `HOSTED_MONTHLY_ALLOWANCE_USD`, `HOSTED_MAX_ACCOUNTS`, `HOSTED_RATE_PER_MINUTE`, `HOSTED_MAX_INFLIGHT`, `HOSTED_GLOBAL_DAILY_IMAGES`, `HOSTED_GLOBAL_DAILY_TOKENS`, `HOSTED_GLOBAL_DAILY_TTS_CHARACTERS`, `HOSTED_GLOBAL_DAILY_USD`.

Per-call bounds: `HOSTED_RESERVE_TOKENS=128000`, `HOSTED_RESERVE_IMAGES=1`, `HOSTED_RESERVE_TTS_CHARACTERS=12000`, plus `HOSTED_RESERVE_<KIND>_USD`. Core bounds input/output and TTS before admission. Holds expire after 30 minutes if a Worker dies. Near a limit, admission can pause before the exact final unit because the next operation’s full bound must fit. The parent’s usage page shows both consumed and held units. At 80% on any account allowance, `warning=true/state=warn`; a refusal uses a gentle “printing press is resting” message and preserves the child’s words.

**Voice-only pause:** `HOSTED_TTS_PAUSE=true` stops new generated narration while preserving other features.

**Kill switch:** `HOSTED_PAUSE=true` refuses paid work immediately, preserving writing, saved books and export. A provider gateway 402/429 calls `providerLimit(env)`, latching generation globally until UTC midnight; no retry loop or automatic key/provider fallback. Operator reset only after checking provider gateway health: delete the `hosted_breakers` row with `account_id='__global__' AND id='provider'` on the hosted DB, or wait until expiry.

## API contract

- `POST /auth/signup {email,password,consent:true,parent:true,notice_version:'2026-11-02',recordings_enabled:false}` → account + one-time recovery code. `HOSTED_OPEN=false` returns 403 `signup_closed`.
- `POST /auth/login {email,password}`, `/auth/logout`, `/auth/parent {password}`, `/auth/lock-parent`, `/auth/recover {email,recovery_code,password}`.
- `GET /api/account` → `{account,usage}`; `PUT /api/account {recordings_enabled,notice_version}`; `GET /api/account/usage`; `GET /api/account/ledger?limit=100&before=<milliseconds>`; `GET/POST /api/account/profiles`.
- `POST /api/account/export` streams NDJSON: account, scoped table rows, media metadata and ordered base64 chunks, ending with `{type:'complete'}`. An incomplete stream is not a valid export. Reconstruct each media file by decoding and concatenating its chunks in order. Credentials, session/recovery hashes and Stripe secrets are excluded.
- `DELETE /api/account {confirmation:'DELETE'}` locks the account, cancels billing, waits out in-flight work, deletes **all** objects under `accounts/<account_id>/` and all its D1 rows, revokes sessions/shares. Failure remains retryable; the response never reports success before cleanup. A 409 means the locked account is waiting for an operation to finish; retry with the parent session. A later login can resume deletion.

All sensitive account/billing routes require recent parent authentication: 403 `parent_auth` means prompt for password, POST `/auth/parent`, retry once. Every data query binds account_id. Global budget/security maintenance queries are server-only, never client-selected account queries. Media uses Core’s tenant wrapper; account export/deletion uses the raw bucket with the account prefix.

## Deployment and repeatable E2E

Copy `wrangler.hosted.example.toml` to the gitignored `wrangler.hosted.local.toml` and fill in your own isolated Worker, D1, R2 and queue resources. Deployment and migration commands must pass `--config wrangler.hosted.local.toml`; real resource names/IDs and private provider URLs never belong in the public template. Never reuse a household deployment’s data resources. `migrations/hosted-001.sql` and `hosted-002-enrollment.sql` follow `migrations/0001-core.sql`.

The hosted lifecycle harness is `HOSTED_URL=https://YOUR_TEST_WORKER.workers.dev node src/hosted/e2e/run.mjs`; artifacts go to `e2e/out-hosted/<timestamp>/`. It does not print/store passwords, cookies, recovery codes, keys or webhook signatures. Test-only signed fixtures require a random `HOSTED_TEST_TOKEN` + `HOSTED_TEST_MODE=true` + Stripe test mode. Disable `HOSTED_TEST_MODE` and `STRIPE_TEST_FIXTURES` after E2E, before public operation. No fixture or synthetic cost control is available with live Stripe mode. `HOSTED_OPEN` starts closed during testing and becomes true only after the agreed E2E passes, after verification; the operator owns enrollment announcements.

Verification results, exact URL/version and remaining production setup will be appended after the deployed run.


