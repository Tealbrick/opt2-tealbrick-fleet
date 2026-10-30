-- Governance 0.4.0 (C380 T2-a, DESIGN-C380 §6): flat roles and their assignments. Forward-only; 0001 to 0010 are never edited.
-- A role is a RECORD. By itself it allows and stops nothing: a Rules rule that names it (`callerRoles`) is what uses it, and ending an
-- assignment removes no Portal grant. There is no CHECK on a state or a reason: src/roles/roles.ts is the one place that knows them.
--
-- An assignment is held (in the feed) when it has started (`started_at` set) and has not ended (`ended_at` NULL). The date timer in
-- src/roles/expiry.ts sets `started_at` when a start date passes and `ended_at` when an end date passes, so time alone never changes an
-- answer at one revision. No row is ever deleted: an ended assignment is the record of who held what.
CREATE TABLE fleet_roles (
  id TEXT PRIMARY KEY,                 -- rol_<ulid>
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,                 -- NULL = in use. An archived role is left out of the feed.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- one live role per name, so the owner never picks between two of the same name
CREATE UNIQUE INDEX fleet_roles_live_name ON fleet_roles (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE fleet_role_assignments (
  id TEXT PRIMARY KEY,                 -- ras_<ulid>
  role_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,          -- agent | person (never an outside agent)
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,                -- a code from a list; the free `note` carries a warning in the UI
  note TEXT,
  valid_from INTEGER,                  -- NULL = from now
  valid_until INTEGER,                 -- NULL = until the owner ends it
  started_at INTEGER,                  -- NULL while a start date waits
  ended_at INTEGER,
  end_reason TEXT,                     -- owner | expired | closed | deleted
  created_by TEXT,                     -- the owner's id
  created_at INTEGER NOT NULL
);
CREATE INDEX fleet_role_assignments_subject ON fleet_role_assignments (subject_kind, subject_id);
CREATE INDEX fleet_role_assignments_role ON fleet_role_assignments (role_id);
-- one open assignment per role and subject
CREATE UNIQUE INDEX fleet_role_assignments_open ON fleet_role_assignments (role_id, subject_kind, subject_id) WHERE ended_at IS NULL;

-- Readers hold a copy of the feed with no roles. A new revision makes every reader read it again in full.
UPDATE fleet_meta SET value = value + 1 WHERE key = 'revision';
