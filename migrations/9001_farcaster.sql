-- blygcaster: Farcaster state. Local migrations are numbered from 9000 so that
-- upstream Studio's own migrations (0001-0999) never collide with them.
--
-- Everything here is client-private. None of it reaches an item document, the
-- feed, the archive index, the manifest, content_html or a mention. A
-- Farcaster source is an ordinary row in `subscriptions` (kind 'farcaster'),
-- and its casts are ordinary L0 rows in `imported_items`.

-- Settings that are not secrets: backend choice, hub URL, the owner's FID,
-- the cast URL template, the cross-post channel and the kill switch.
CREATE TABLE farcaster_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-item opt-in. No row, or enabled = 0, means the item is never cast.
CREATE TABLE farcaster_optin (
  item_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL
);

-- One row per cast blygcaster makes or tries to make: a cross-post of one
-- version of an item, or a reply offered after stubbing a cast. The row also
-- carries that cast's deletion when the item is withdrawn or republished.
--
-- status: pending   → not yet posted; attempts/next_attempt_at drive retry
--         posted    → live on Farcaster under cast_hash
--         failed    → gave up after the last retry (15m, 1h, 4h, 12h, 24h)
--         cancelled → withdrawn or superseded before it was ever posted
--         deleting  → posted, and its deletion is pending
--         deleted   → posted, then deleted
--         skipped   → cross-posting was switched off when this was due
--         delete_failed → the deletion gave up after the last retry
-- attempt_at fixes the signed message's timestamp, so every retry of one cast
-- is byte-identical and cannot make a second cast.
CREATE TABLE farcaster_casts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('crosspost', 'reply')),
  cast_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'failed', 'cancelled', 'deleting', 'deleted', 'skipped', 'delete_failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  attempt_at TEXT NOT NULL,
  last_error TEXT,
  draft_json TEXT NOT NULL,
  backend TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  UNIQUE (item_id, version, purpose)
);
CREATE INDEX farcaster_casts_due ON farcaster_casts (status, next_attempt_at);
CREATE INDEX farcaster_casts_item ON farcaster_casts (item_id);

-- A stub made from a cast: which cast, frozen at creation. Used for the
-- "stubbed" marker in the reader, the empty-stub check at publish, and the
-- offer to reply on Farcaster. The stub's own stub_of/cited is the record
-- readers see; this row never leaves the Studio.
CREATE TABLE farcaster_stubs (
  item_id TEXT PRIMARY KEY,
  fid INTEGER NOT NULL,
  hash TEXT NOT NULL,
  cast_url TEXT NOT NULL,
  quoted TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX farcaster_stubs_cast ON farcaster_stubs (fid, hash);

-- Names for FIDs, so a hub poll does not look up the same author every time.
CREATE TABLE farcaster_accounts (
  fid INTEGER PRIMARY KEY,
  handle TEXT,
  display_name TEXT,
  fetched_at TEXT NOT NULL
);

-- The normalized casts the reader has imported, as the adapters returned
-- them. A stub quotes from here, so stubbing never waits on the network, and
-- a cast deleted at the source still has the words the owner saw (brief §7).
CREATE TABLE farcaster_cast_cache (
  fid INTEGER NOT NULL,
  hash TEXT NOT NULL,
  cast_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (fid, hash)
);
