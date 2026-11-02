-- Revocable bearer links, created explicitly by a parent in hosted mode.
CREATE TABLE IF NOT EXISTS shares (
 account_id TEXT NOT NULL, story_id TEXT NOT NULL, token TEXT NOT NULL,
 show_author INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
 PRIMARY KEY(account_id,story_id), UNIQUE(account_id,token)
);
