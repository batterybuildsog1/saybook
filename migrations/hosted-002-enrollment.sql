CREATE TABLE IF NOT EXISTS hosted_enrollment (
 account_id TEXT PRIMARY KEY, expires INTEGER NOT NULL, state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hosted_enrollment_expires ON hosted_enrollment(expires);
-- A waitlist holds only an adult email and its expiry, no account/password/payment/child content.
CREATE TABLE IF NOT EXISTS hosted_waitlist (
 account_id TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
);
