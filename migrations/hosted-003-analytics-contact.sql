-- Optional account telemetry, no child/story identifiers or content in the analytics journal.
CREATE TABLE IF NOT EXISTS analytics_preferences(account_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_milestones(account_id TEXT NOT NULL,event TEXT NOT NULL,object_hash TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(account_id,event,object_hash));
CREATE TABLE IF NOT EXISTS contact_limits(key_hash TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires INTEGER NOT NULL);
-- Aggregate enrollment count is local only and contains no identities. Keeps the reviewer stop guard independent of opt-in/deletion.
CREATE TABLE IF NOT EXISTS analytics_population(id INTEGER PRIMARY KEY CHECK(id=1),signups INTEGER NOT NULL);
INSERT OR IGNORE INTO analytics_population(id,signups) SELECT 1,COUNT(*) FROM hosted_accounts WHERE email NOT LIKE '%@example.invalid' AND email NOT LIKE '%@example.com';
