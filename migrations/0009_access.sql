-- Governance 0.4.0 (C380, DESIGN-C380 §3, §4, §11): what each store reports about who can reach what, and when it was read.
-- Forward-only; 0001 to 0008 are never edited. No row of an earlier table changes and the feed revision does not move: this
-- is an owner-side copy, never authority. No CHECK on a state: src/access/client.ts is the one place that knows them.

-- The shadow copy of tb.access/1 items, one row per item of a target. `target` is the product Governance called (verified by
-- the bridge), never a value in the answer, so one app cannot report for another. `label` is cleaned text, owner side only.
-- `last_sweep` is the sweep that last saw the row; a row is removed only by the deletion rule in src/access/sweep.ts.
CREATE TABLE fleet_access_items (
  target TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT,
  resource TEXT NOT NULL,
  direction TEXT NOT NULL,
  level TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  revocable INTEGER NOT NULL,
  since TEXT,
  digest TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_sweep TEXT,
  PRIMARY KEY (target, item_id)
) WITHOUT ROWID;
CREATE INDEX fleet_access_items_subject ON fleet_access_items (subject_kind, subject_id);

-- One row per full read of the stores. A row with no `finished_at` was stopped by a crash or a failed job.
CREATE TABLE fleet_sweeps (
  id TEXT PRIMARY KEY,
  started_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  calls INTEGER NOT NULL DEFAULT 0,
  stores_read INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX fleet_sweeps_finished ON fleet_sweeps (finished_at);

-- The last result per store: read, not_installed, not_read, refused or waiting. `backoff_until` survives a restart, so a
-- refused or held read does not repeat each tick. `read_at` stays when a later read fails: the old list keeps its time.
CREATE TABLE fleet_read_state (
  target TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  code TEXT,
  text TEXT,
  read_at INTEGER,
  tried_at INTEGER NOT NULL,
  backoff_until INTEGER NOT NULL DEFAULT 0,
  not_shown_json TEXT NOT NULL DEFAULT '[]'
) WITHOUT ROWID;

-- "Accept with reason until <date>": one per finding and subject. It changes no access, and the finding is shown again at `until`.
CREATE TABLE fleet_exceptions (
  code TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) <= 200),
  until INTEGER NOT NULL,
  by_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (code, subject_kind, subject_id)
) WITHOUT ROWID;
