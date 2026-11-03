# Optional analytics and parent support

Hosted analytics is off unless the operator supplies their own PostHog public project key and sets ANALYTICS_BUDGET_VERIFIED=true after verifying a capped plan. ANALYTICS_DEPLOYMENT distinguishes production from test. ANALYTICS_REPLAY=true is allowed only after a synthetic privacy audit. No key is bundled in the source or public assets. Stay within the provider's free-plan limits; sampling is not a budget cap.

Apply migrations/hosted-003-analytics-contact.sql before deploying this integration. Every account's server telemetry is optional. The parent signup choice or account-page footer saves that preference. Child milestones additionally require the recorded notice and verified parental consent. The server sends an account hash, categories and counts through waitUntil; it never forwards content, filenames, raw errors, URLs, child identifiers or arbitrary metadata. Milestone dedupe retains hashes locally. The local aggregate signup counter is independent of optional collection and contains no identities.

Client analytics is limited to the landing, sign-in and account pages. The pinned vendored SDK uses memory; the parent preference and anonymous parent ID use localStorage. No analytics cookies are created. Essential authentication cookies remain necessary. Mask all text, input values and attributes; block forms/account data/recovery codes and media, disable console/network recording, and strip URL query/fragment/referrer metadata. Never initialize the SDK on child screens or public shared books. Withdrawal stops recording/capture and clears the device preference, with the account setting stopping future server telemetry.

Before enabling real collection, use an isolated hosted TEST deployment with a synthetic paid TEST account. Put unique markers in writer/story/upload-filename/URL contexts. Inspect actual full event properties and stored replay blobs through a scoped read-only key, require a real DOM snapshot, and prove no marker leaks, no analytics cookies, no child/shared PostHog requests and no post-withdrawal capture. Do not publish credentials, raw snapshots or unmasked test content. Repeat after SDK/privacy/DOM changes. Server narration milestones prove audio delivery, not that playback was heard or completed.

The contact form at /contact/ posts to /api/contact. In the hosted config set CONTACT_FROM to your routed support sender and CONTACT_TO to a verified owner mailbox. Add a Cloudflare send_email binding named CONTACT_EMAIL restricted to that same destination_address. Example:

```toml
[vars]
CONTACT_FROM = "support@example.com"
CONTACT_TO = "owner@example.com"

[[send_email]]
name = "CONTACT_EMAIL"
destination_address = "owner@example.com"
```

Email Routing must already be active for the sender domain and the destination verified. The request cannot choose recipients or subject. The parent's validated email becomes Reply-To. UTF-8 message content is base64 MIME encoded. Same-origin checks, message/body bounds, a honeypot, 3-second minimum/1-hour maximum form age and atomic hourly IP/email/global limits reject abuse. Form messages and email addresses go to the support mailbox, not analytics. No contact data is added to story storage. A mailbox retention/deletion policy remains the operator's responsibility.

For a deployment check, submit one synthetic message, verify its original sender/destination/Reply-To and unique marker in the receiving mailbox, and retain sanitized delivery evidence. Do not claim delivery solely from an accepted form response.
