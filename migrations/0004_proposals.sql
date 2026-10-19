-- Governance 0.2.4 (C166, DESIGN §3.3, §4): contact-rule proposals. Forward-only; 0001 to 0003 are never edited.
-- A proposal is a rule Governance DRAFTED from a fixed template and sent to Rules & Approvals with the companion call
-- `rule_draft_submit`. Governance never approves: the owner does that in Rules. `status` is about OUR call:
--   sent   Rules answered a draft id (rules_draft_id is set; only then)
--   held   Rules (or the bridge) held the call for an owner decision; nothing was created yet
--   failed Rules refused or did not answer; `error` is the exact error code (no upstream text)
-- `rules_status` is what `draft_status` last said about a sent draft (pending, approved, rejected), `gone` when Rules no
-- longer knows the draft, `unknown` when the last poll got no answer. The row is created BEFORE the call (as `failed` /
-- `interrupted`: the truth if the process dies mid-call) and its id is the idempotency key of the Rules call, so a retry
-- never makes a second draft. One state change is one UPDATE (L31).
CREATE TABLE fleet_proposals (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL CHECK (template IN ('hold_outward_for_agent', 'deny_outward_for_agent', 'hold_on_behalf_of_sender', 'deny_on_behalf_of_sender')),
  -- the ONLY parameters: {"agent": "agt_..."} or {"handle": "<channel>:<value>"}, canonical
  params_json TEXT NOT NULL CHECK (length(params_json) <= 400),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  rules_json TEXT NOT NULL CHECK (length(rules_json) <= 8192),
  rules_draft_id TEXT CHECK (rules_draft_id IS NULL OR length(rules_draft_id) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('sent', 'held', 'failed')),
  error TEXT CHECK (error IS NULL OR length(error) <= 80),
  -- 1 = Rules ANSWERED with a refusal (a 4xx other than 408/409): no draft exists, so sending the same template and
  -- parameter again starts a NEW proposal with a freshly built payload (S3-2). 0 = no answer, a hold or an ambiguous
  -- answer: a retry reuses this row and its idempotency key, so Rules never holds two drafts.
  error_final INTEGER NOT NULL DEFAULT 0 CHECK (error_final IN (0, 1)),
  -- 1 = some attempt may have reached Rules and its outcome is not known (set BEFORE every call, so a crash leaves it;
  -- kept by a timeout, transport error, 5xx, 409 or a malformed answer). While it is 1 a later 4xx is NOT final: a draft
  -- may exist under this key, so the row keeps its key (review S2-1).
  in_doubt INTEGER NOT NULL DEFAULT 0 CHECK (in_doubt IN (0, 1)),
  rules_status TEXT CHECK (rules_status IS NULL OR rules_status IN ('pending', 'approved', 'rejected', 'gone', 'unknown')),
  rules_decided_at INTEGER,
  rules_checked_at INTEGER,
  review_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- "sent" if and only if Rules answered a draft id; a failure always says why
  CHECK ((status = 'sent') = (rules_draft_id IS NOT NULL)),
  CHECK ((status = 'sent') = (error IS NULL)),
  CHECK ((status = 'sent') = (rules_status IS NOT NULL)),
  CHECK (error_final = 0 OR status = 'failed')
);
CREATE INDEX fleet_proposals_created ON fleet_proposals (created_at, id);
CREATE INDEX fleet_proposals_open ON fleet_proposals (status, rules_status);
