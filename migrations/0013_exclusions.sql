-- Governance 0.4.0 (C380 T2-c, DESIGN-C380 §6): "Cannot hold both". Forward-only; 0001 to 0012 are never edited.
-- A rule names two roles that must not be held together. Two kinds:
--   roles         no person or agent may hold role A and role B at the same time (unordered pair: role_a < role_b by id).
--   holder_owner  an agent may not hold role A while its owner holds role B (ordered: role_a is the agent's, role_b the owner's; they may be the same role).
-- A rule is a RECORD that Governance checks when a role is given (src/roles/exclusions.ts, with date overlap) and shows as a difference when it
-- is broken later (a rule added after the roles, a new owner). It reads roles only: Portal grants are not checked. It changes nothing a reader of
-- the feed sees, so it does not move the revision. No row is deleted: an archived rule is the record that it once existed.
CREATE TABLE fleet_exclusions (
  id TEXT PRIMARY KEY,                 -- xcl_<ulid>
  kind TEXT NOT NULL,                  -- roles | holder_owner (src/roles/exclusions.ts is the one place that knows them)
  role_a TEXT NOT NULL,                -- fleet_roles.id
  role_b TEXT NOT NULL,                -- fleet_roles.id
  note TEXT,                           -- why the owner made the rule (free text; shown as the owner's own words)
  archived_at INTEGER,                 -- NULL = checked. An archived rule is not checked and not flagged.
  created_by TEXT,                     -- the owner's id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- an unordered pair is stored once, in one order, so (A, B) and (B, A) are the same rule
  CHECK (kind = 'holder_owner' OR role_a < role_b)
);
-- one live rule per kind and pair
CREATE UNIQUE INDEX fleet_exclusions_live ON fleet_exclusions (kind, role_a, role_b) WHERE archived_at IS NULL;
