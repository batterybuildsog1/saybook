-- Free-first pricing (Alan, 2026-11-02): five free books per family, then $19.50/month or $140.40/year.
-- Consent is the signup checkbox; payment no longer unlocks the app.
-- Apply together with the code that reads it (src/hosted/books.js, billing.js).

-- One row per counted book. Rows outlive story deletion and go with the account.
CREATE TABLE IF NOT EXISTS hosted_books (
 account_id TEXT NOT NULL, story_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id,story_id)
);
-- Books that already have pages have already counted.
INSERT OR IGNORE INTO hosted_books(account_id,story_id,at)
 SELECT s.account_id,s.story_id,MIN(s.updated) FROM scenes s JOIN hosted_accounts a ON a.account_id=s.account_id GROUP BY s.account_id,s.story_id;

-- 'monthly' or 'annual', from the validated Stripe price on the latest subscription event.
ALTER TABLE hosted_accounts ADD COLUMN billing_plan TEXT NOT NULL DEFAULT '';
UPDATE hosted_accounts SET billing_plan='monthly' WHERE stripe_subscription_id IS NOT NULL AND subscription_status<>'invalid_price';

-- Parents who ticked the signup boxes but never paid get the same access a new signup gets now.
UPDATE hosted_accounts SET parent_verified_at=consent_at WHERE parent_verified_at=0 AND consent_at>0 AND status='active';

-- Paid-place reservations made at checkout. The family cap now counts accounts at signup.
DROP TABLE IF EXISTS hosted_enrollment;
