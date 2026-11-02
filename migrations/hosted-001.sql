-- Hosted-only schema. Apply AFTER Core's scoped story/scene/event schema.
CREATE TABLE IF NOT EXISTS hosted_accounts (
 account_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, recovery_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active', created INTEGER NOT NULL, last_active INTEGER NOT NULL DEFAULT 0,
 consent_version TEXT NOT NULL, consent_at INTEGER NOT NULL,
 recordings_enabled INTEGER NOT NULL DEFAULT 0,
 parent_verified_at INTEGER NOT NULL DEFAULT 0, consent_checkout_id TEXT,
 stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT UNIQUE,
 subscription_status TEXT NOT NULL DEFAULT 'none', subscription_end INTEGER NOT NULL DEFAULT 0,
 stripe_event_at INTEGER NOT NULL DEFAULT 0, cancel_at_period_end INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hosted_sessions (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL,
 created INTEGER NOT NULL, expires INTEGER NOT NULL, parent_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS hosted_sessions_account ON hosted_sessions(account_id);
CREATE TABLE IF NOT EXISTS hosted_profiles (
 account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL,
 PRIMARY KEY(account_id,id)
);
CREATE TABLE IF NOT EXISTS hosted_consent (
 account_id TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL,
 action TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id,id)
);
CREATE TABLE IF NOT EXISTS hosted_usage (
 account_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
 usd_micros INTEGER NOT NULL CHECK(usd_micros>=0), images INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, characters INTEGER NOT NULL DEFAULT 0, units TEXT NOT NULL,
 story_id TEXT, at INTEGER NOT NULL, PRIMARY KEY(account_id,id)
);
CREATE INDEX IF NOT EXISTS hosted_usage_account_at ON hosted_usage(account_id,at);
CREATE INDEX IF NOT EXISTS hosted_usage_at ON hosted_usage(at);
CREATE TABLE IF NOT EXISTS hosted_reservations (
 account_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
 usd_micros INTEGER NOT NULL CHECK(usd_micros>=0), images INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, characters INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, expires INTEGER NOT NULL,
 PRIMARY KEY(account_id,id)
);
CREATE INDEX IF NOT EXISTS hosted_reservations_account_at ON hosted_reservations(account_id,at);
CREATE INDEX IF NOT EXISTS hosted_reservations_expires ON hosted_reservations(expires);
CREATE TABLE IF NOT EXISTS hosted_stripe_events (
 account_id TEXT NOT NULL, event_id TEXT NOT NULL PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL
);
-- One-way hashes of IP + login identifier, not raw network or email identifiers.
-- This security table is not returned by any data API and expires after one hour.
CREATE TABLE IF NOT EXISTS hosted_auth_limits (
 account_id TEXT NOT NULL DEFAULT '', key_hash TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hosted_breakers (
 account_id TEXT NOT NULL, id TEXT NOT NULL, until_at INTEGER NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(account_id,id)
);
-- Aggregate circuit-breaker counters have no account/child identifiers and survive account deletion.
CREATE TABLE IF NOT EXISTS hosted_global_usage (
 account_id TEXT NOT NULL DEFAULT '__global__', day INTEGER NOT NULL,
 usd_micros INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0,
 tokens INTEGER NOT NULL DEFAULT 0, characters INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id,day)
);
