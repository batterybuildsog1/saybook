# Operator responsibilities

MIT licensing and bringing your own API keys do not grant provider approval or satisfy children’s privacy duties. A household deployment and a service offered to other families have different obligations. Assess applicable law and every provider before enabling children’s use.

Hosted operation requires accurate parent/privacy notices, verified operator contacts, affirmative and versioned parent consent, a qualifying verification method, secure accounts, private books, separately consented sharing, parent review/export/deletion, retention and incident handling. Keep paid enrollment closed until these controls and payment notifications are verified. A checkbox, uncharged trial or Checkout return URL alone does not unlock child data.

The implementation uses the first completed positive card payment plus a signed, server-verified Checkout webhook as its parent verification method. Confirm the actual payment system notifies the primary cardholder; test cards cannot prove live notification. Publish the recurring price, allowance, cancellation and refund terms before collecting payment.

OpenAI’s under-18 API guidance calls for Zero Data Retention before processing under-13 personal data. ElevenLabs requires written approval for products directed at under-18s and prohibits cloning a minor’s voice. The hosted launch’s subscription-backed gateway and unapproved ElevenLabs child-use route are known operator-accepted provider risks, not claims of provider approval. A self-hoster must assess their own route and terms. Preserve configurable endpoints and secrets so providers can be changed without rewriting the app.

Dictation, requested model work and browser speech recognition may send content to remote providers. Saybook does not promise that self-hosting keeps data on device or that deleting local data deletes provider records. Obtain and publish accurate retention/security assurances, document backup expiry, and maintain a security program. Use synthetic demos. Never post children’s identities, stories or voices without the required authorization.

The hosted example sets `HOSTED_ALLOWED_COUNTRY=US`. Enrollment and Checkout check the edge country, and paid consent requires the matching canonical billing country. Do not advertise international eligibility until its legal requirements are reviewed. Legal templates in this repository are drafts for operator review. They are not a compliance certification.

References: [FTC children’s privacy rule](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312), [OpenAI under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance), [ElevenLabs policy](https://elevenlabs.io/use-policy), [Stripe terms](https://stripe.com/legal/ssa/us).
