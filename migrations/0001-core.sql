-- Fresh core schema. All data belongs to one account.
CREATE TABLE IF NOT EXISTS stories (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  voice_id TEXT,
  audio_key TEXT,          -- R2 key of the last narration
  audio_hash TEXT,         -- sha of text+voice+model, so replay is free
  alignment TEXT,          -- JSON {chars,starts,ends}
  bible TEXT,              -- JSON from the scenes skill (style, characters, setting)
  cast_key TEXT,           -- JSON {character name: R2 key of their portrait}; pages get only who is in them
  own_audio_key TEXT,      -- "Read it to me": the kid's own reading of the story
  own_alignment TEXT,      -- JSON {chars,starts,ends} mapped from Whisper word timings
  own_by TEXT,
  cast_lock INTEGER,       -- set while portraits are being drawn (one run at a time)
  book TEXT,               -- JSON {chapters:[{start,title}], settled_paragraphs, settled_hash}
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS stories_author ON stories(account_id, author, updated);

CREATE TABLE IF NOT EXISTS scenes (
  account_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  sid TEXT NOT NULL,
  ord INTEGER NOT NULL,
  para_from INTEGER NOT NULL,
  para_to INTEGER NOT NULL,
  text TEXT NOT NULL,
  image_prompt TEXT NOT NULL DEFAULT '',
  present TEXT NOT NULL DEFAULT '[]',
  image_key TEXT,           -- the picture shown now
  versions TEXT NOT NULL DEFAULT '[]',  -- every picture ever made for this page [{key,how,feedback,at}]
  refs TEXT NOT NULL DEFAULT '[]',
  feedback TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  stale INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (account_id, story_id, sid)
);

-- Every paid or slow operation: the production benchmark (speed + cost per part).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,       -- stt | tts | book | punctuation | cast | image | chat | narration
  story_id TEXT,
  ok INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  units REAL,               -- seconds of audio, characters, tokens or images
  unit TEXT,
  cost_usd REAL,            -- configurable marginal cost estimate
  meta TEXT
);
CREATE INDEX IF NOT EXISTS events_kind ON events(account_id, kind, at);

CREATE TABLE IF NOT EXISTS settings (account_id TEXT PRIMARY KEY, writers TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS usage_ledger (
 id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, at INTEGER NOT NULL,
 kind TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, units REAL NOT NULL DEFAULT 0, story_id TEXT
);
CREATE INDEX IF NOT EXISTS usage_account ON usage_ledger(account_id, at);
