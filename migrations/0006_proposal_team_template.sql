-- Governance 0.3.0 (C373, RULES-INTERFACE §5): the template `hold_outward_for_team` (params {"team": "<team id>"}).
-- Forward-only; 0001 to 0005 are never edited. SQLite cannot change a CHECK, so fleet_proposals is rebuilt with the same
-- columns, the same constraints and one more template value; every row is copied as it is, then the indexes are made again.
CREATE TABLE fleet_proposals_v6 (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL CHECK (template IN ('hold_outward_for_agent', 'deny_outward_for_agent', 'hold_on_behalf_of_sender', 'deny_on_behalf_of_sender', 'hold_outward_for_team')),
  -- the ONLY parameters: {"agent": "agt_..."}, {"handle": "<channel>:<value>"} canonical, or {"team": "<team id>"}
  params_json TEXT NOT NULL CHECK (length(params_json) <= 400),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  rules_json TEXT NOT NULL CHECK (length(rules_json) <= 8192),
  rules_draft_id TEXT CHECK (rules_draft_id IS NULL OR length(rules_draft_id) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('sent', 'held', 'failed')),
  error TEXT CHECK (error IS NULL OR length(error) <= 80),
  error_final INTEGER NOT NULL DEFAULT 0 CHECK (error_final IN (0, 1)),
  in_doubt INTEGER NOT NULL DEFAULT 0 CHECK (in_doubt IN (0, 1)),
  rules_status TEXT CHECK (rules_status IS NULL OR rules_status IN ('pending', 'approved', 'rejected', 'gone', 'unknown')),
  rules_decided_at INTEGER,
  rules_checked_at INTEGER,
  review_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((status = 'sent') = (rules_draft_id IS NOT NULL)),
  CHECK ((status = 'sent') = (error IS NULL)),
  CHECK ((status = 'sent') = (rules_status IS NOT NULL)),
  CHECK (error_final = 0 OR status = 'failed')
);
INSERT INTO fleet_proposals_v6 (id, template, params_json, text, rules_json, rules_draft_id, status, error, error_final, in_doubt, rules_status, rules_decided_at, rules_checked_at, review_id, created_by, created_at, updated_at)
  SELECT id, template, params_json, text, rules_json, rules_draft_id, status, error, error_final, in_doubt, rules_status, rules_decided_at, rules_checked_at, review_id, created_by, created_at, updated_at FROM fleet_proposals;
DROP TABLE fleet_proposals;
ALTER TABLE fleet_proposals_v6 RENAME TO fleet_proposals;
CREATE INDEX fleet_proposals_created ON fleet_proposals (created_at, id);
CREATE INDEX fleet_proposals_open ON fleet_proposals (status, rules_status);
