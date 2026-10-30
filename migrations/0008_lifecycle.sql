-- Governance 0.4.0 (C380, DESIGN-C380 §2, §11): one lifecycle per person and agent. Forward-only; 0001 to 0007 are never
-- edited. There is no CHECK on a lifecycle value: src/lifecycle/states.ts is the one place that knows the states, and
-- src/lifecycle/transitions.ts is the one writer (a test scans for other writers).
--
-- 0.3.2 data stays: no row is deleted, and name, owner, trust, handles, teams, reviews and proposals are not touched.
--   agents:  `removed` becomes `archived` with the note no_card (no floor; a card that comes back raises a finding);
--            every other agent is `active` (it already works; nothing starts to refuse by this step).
--   people:  `departed` becomes `leaving` with the reason `migrated` and no plan (finding leaving_no_plan);
--            every other person is `active`. Outside agents have no lifecycle (NULL): they use trust.
ALTER TABLE fleet_agents ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE fleet_agents ADD COLUMN lifecycle_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_agents ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE fleet_agents ADD COLUMN lifecycle_note TEXT;
ALTER TABLE fleet_agents ADD COLUMN lifecycle_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_agents ADD COLUMN valid_from INTEGER;
ALTER TABLE fleet_agents ADD COLUMN valid_until INTEGER;
ALTER TABLE fleet_agents ADD COLUMN keep_running INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_agents ADD COLUMN keep_reason TEXT;
ALTER TABLE fleet_agents ADD COLUMN migrated_note TEXT;

ALTER TABLE fleet_people ADD COLUMN lifecycle TEXT;
ALTER TABLE fleet_people ADD COLUMN lifecycle_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_people ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE fleet_people ADD COLUMN lifecycle_note TEXT;
ALTER TABLE fleet_people ADD COLUMN lifecycle_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_people ADD COLUMN valid_from INTEGER;
ALTER TABLE fleet_people ADD COLUMN valid_until INTEGER;

-- Every state change, in order. Append-only: a row is never changed or deleted. `seq` is the chain order. `prev_hash` is the
-- hash of the row before it (src/lifecycle/events.ts); rows written by this migration carry NULL, the chain starts after them.
CREATE TABLE fleet_lifecycle_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  plan_id TEXT,
  draft_id TEXT,
  receipt_id TEXT,
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR length(snapshot_json) <= 8192),
  snapshot_digest TEXT,
  prev_hash TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX fleet_lifecycle_events_subject ON fleet_lifecycle_events (subject_kind, subject_id, seq);
CREATE INDEX fleet_lifecycle_events_stop ON fleet_lifecycle_events (kind, to_state, at);

CREATE TRIGGER fleet_lifecycle_events_no_replace BEFORE INSERT ON fleet_lifecycle_events
WHEN EXISTS (SELECT 1 FROM fleet_lifecycle_events WHERE id = NEW.id OR seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle_events_append_only');
END;
CREATE TRIGGER fleet_lifecycle_events_no_update BEFORE UPDATE ON fleet_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'lifecycle_events_append_only');
END;
CREATE TRIGGER fleet_lifecycle_events_no_delete BEFORE DELETE ON fleet_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'lifecycle_events_append_only');
END;

-- Workspace settings of the lifecycle. cooling_days: days before an entry can be closed. stop_cap: stops per 10 minutes
-- before a confirm naming the count is needed (S2-7). default_owner: absent until the owner picks one.
CREATE TABLE fleet_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO fleet_settings (key, value) VALUES ('cooling_days', '30'), ('stop_cap', '5');

-- The feed revision moves once, so a reader sees the new fields at its next read.
UPDATE fleet_meta SET value = value + 1 WHERE key = 'revision';

-- Migrated rows that change meaning get one event each, in a stable order. `lifecycle_rev` is the feed revision of the last change.
INSERT INTO fleet_lifecycle_events (id, subject_kind, subject_id, subject_name, kind, from_state, to_state, actor_kind, reason, at)
  SELECT 'lev_m_a_' || id, 'agent', id, name, 'migrated', 'removed', 'archived', 'system', 'migrated', unixepoch() * 1000
  FROM fleet_agents WHERE status = 'removed' ORDER BY id;
INSERT INTO fleet_lifecycle_events (id, subject_kind, subject_id, subject_name, kind, from_state, to_state, actor_kind, reason, at)
  SELECT 'lev_m_p_' || id, 'person', id, name, 'migrated', 'departed', 'leaving', 'system', 'migrated', unixepoch() * 1000
  FROM fleet_people WHERE kind = 'person' AND status = 'departed' ORDER BY id;

UPDATE fleet_agents SET
  lifecycle = CASE WHEN status = 'removed' THEN 'archived' ELSE 'active' END,
  migrated_note = CASE WHEN status = 'removed' THEN 'no_card' END,
  lifecycle_reason = 'migrated',
  lifecycle_rev = (SELECT value FROM fleet_meta WHERE key = 'revision'),
  lifecycle_at = unixepoch() * 1000;

UPDATE fleet_people SET
  lifecycle = CASE WHEN status = 'departed' THEN 'leaving' ELSE 'active' END,
  lifecycle_reason = 'migrated',
  lifecycle_rev = (SELECT value FROM fleet_meta WHERE key = 'revision'),
  lifecycle_at = unixepoch() * 1000
WHERE kind = 'person';
