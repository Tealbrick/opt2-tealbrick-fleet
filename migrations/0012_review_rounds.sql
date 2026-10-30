-- Governance 0.4.0 (C380 T2-b, DESIGN-C380 §7, §11): review rounds and the access record. Forward-only; 0001 to 0011 are never edited.
-- No row of an earlier table changes and the feed revision does not move: this adds owner-side tables only. There is no CHECK on a
-- state: src/rounds.ts and src/access/history.ts are the places that know them.
--
-- A review round links review requests. `fleet_reviews` refuses an UPDATE of a closed row (migration 0003), so the round id cannot live
-- on the review. The link table holds it, and the counts of a round are read through it.
CREATE TABLE fleet_rounds (
  id TEXT PRIMARY KEY,                  -- rnd_<ulid>
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  scope TEXT NOT NULL,                  -- agents | people | everyone | chosen
  created_by TEXT,
  created_at INTEGER NOT NULL,
  due_at INTEGER,
  closed_at INTEGER,
  closed_by TEXT
) WITHOUT ROWID;

CREATE TABLE fleet_campaign_items (
  round_id TEXT NOT NULL REFERENCES fleet_rounds (id),
  review_id TEXT NOT NULL,              -- the owner's review request about this subject; its row says open, done (verdict) or dismissed
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,           -- a snapshot: the round survives person_delete
  added_at INTEGER NOT NULL,
  seen_count INTEGER,                   -- what the owner decided on: access rows of the subject, and the digest of their identities
  seen_digest TEXT,
  wanted_json TEXT,                     -- "Remove this access" ticks waiting for a free slot (queued) or a plan (until the plan holds them)
  removal TEXT,                         -- NULL | queued | planned
  removal_note TEXT,
  plan_id TEXT,                         -- the group id of the plan the verdict opened; the plan path is src/plans, the only apply path
  PRIMARY KEY (round_id, review_id)
) WITHOUT ROWID;
-- A request belongs to one round at most.
CREATE UNIQUE INDEX fleet_campaign_items_review ON fleet_campaign_items (review_id);
CREATE INDEX fleet_campaign_items_subject ON fleet_campaign_items (subject_kind, subject_id);
CREATE INDEX fleet_campaign_items_plan ON fleet_campaign_items (plan_id);

CREATE TRIGGER fleet_campaign_items_no_delete BEFORE DELETE ON fleet_campaign_items
BEGIN
  SELECT RAISE(ABORT, 'campaign_item_append_only');
END;
-- Who and what a row is about never changes. Only the removal fields and the seen fields move, and each moves once to a value.
CREATE TRIGGER fleet_campaign_items_identity BEFORE UPDATE ON fleet_campaign_items
WHEN NEW.round_id <> OLD.round_id OR NEW.review_id <> OLD.review_id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_id <> OLD.subject_id
  OR NEW.subject_name <> OLD.subject_name OR NEW.added_at <> OLD.added_at
BEGIN
  SELECT RAISE(ABORT, 'campaign_item_append_only');
END;

-- What each store listed, as a change log: an item appeared, changed or ended at a sweep. "The list at sweep S" is the last row of each
-- item up to S, minus the ones that ended. An ended item is kept here after the shadow copy lets it go. Rows before this migration are
-- not known: the items of the shadow copy are entered now as `appeared` under the sweep id `migrated`, and `fleet_record_meta.record_since` says from when.
CREATE TABLE fleet_access_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  sweep_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  change TEXT NOT NULL,                 -- appeared | changed | ended
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
  digest TEXT NOT NULL
);
CREATE INDEX fleet_access_history_item ON fleet_access_history (target, item_id, seq);
CREATE INDEX fleet_access_history_at ON fleet_access_history (at);
CREATE TRIGGER fleet_access_history_no_update BEFORE UPDATE ON fleet_access_history
BEGIN
  SELECT RAISE(ABORT, 'access_history_append_only');
END;
CREATE TRIGGER fleet_access_history_no_delete BEFORE DELETE ON fleet_access_history
BEGIN
  SELECT RAISE(ABORT, 'access_history_append_only');
END;

-- What each store answered when a sweep ended: a copy of `fleet_read_state` per sweep. A store was read in that sweep when its `read_at`
-- is not older than the sweep and its state is `read`. `not_shown_json` is what the store said it cannot list.
CREATE TABLE fleet_sweep_stores (
  sweep_id TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  code TEXT,
  text TEXT,
  read_at INTEGER,
  not_shown_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (sweep_id, target)
) WITHOUT ROWID;

INSERT INTO fleet_access_history (sweep_id, at, change, target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, since, digest)
  SELECT 'migrated', unixepoch() * 1000, 'appeared', target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, since, digest
  FROM fleet_access_items ORDER BY target, item_id;
-- Own table, so the settings of the lifecycle keep their rows. `record_since`: the time (ms) from which the history is known.
CREATE TABLE fleet_record_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO fleet_record_meta (key, value) VALUES ('record_since', CAST(unixepoch() * 1000 AS TEXT));
