# Saybook cancellation and refunds

Effective November 2, 2026. Seller: HVAC Calc LLC. Support: support@saybook.app, (435) 212-0130, 2066 Grand Teton Road, Hurricane, UT 84737. [Public policy](/legal/refunds).

The hosted subscription is **US $19.50 per month**, recurring until canceled. The parent can cancel anytime through Parent settings → Billing Portal. The Portal requests cancellation at the end of the current paid period; access runs to that period's end. Cancellation stops renewal and does not itself delete the family library. The ordinary usage, safety and availability limits still apply.

The **$19.50 charge is non-refundable except where the law requires**. Send mistakes, suspected duplicate charges and other billing errors to support@saybook.app. The operator reviews them case by case and honors rights required by law. This is the reversible launch policy default specified in this task, not a claim of a previously established practice.

Account deletion differs from cancellation: it withdraws consent, immediately cancels billing and removes the account's saved data through the retryable deletion workflow. Export first. Deletion does not automatically create a refund or delete Stripe's financial records. Lost credentials require appropriate operator identity handling; never ask for the full card number, CVC, password or recovery code by email.

Operator handling: identify the affected Stripe customer/payment using the minimum information needed (account email, charge date/amount and payment reference if available), inspect duplicate/mistaken charges, document the outcome in restricted support records and apply required refunds through Stripe. No automated refund endpoint, guaranteed discretionary refund or support-response deadline is implemented. No payment or refund is executed by this policy document. Stripe receipt/refund notification configuration is a separate release check.

Implementation evidence: `src/hosted/billing.js` requests `cancel_at_period_end=true`; the Saybook Portal configuration enables period-end cancellation; `src/hosted/accounts.js` invokes immediate cancellation on account deletion. The actual Stripe TEST lifecycle verifies cancellation/deletion. Re-check the scoped production Portal after relevant billing configuration changes.
