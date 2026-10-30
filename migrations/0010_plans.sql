-- Governance 0.4.0 (C380, DESIGN-C380 §5, §11): prepared stop plans and their steps. Forward-only. Released only with the rail.
-- There is no CHECK on a plan or step state: src/plans/steps.ts is the one place that knows the states. Every state change is one
-- `UPDATE ... WHERE state = ? AND attempt = ?`, so a tick that lost a race changes nothing.
--
-- No name of a person and no reason goes to Core: `subject_name` and the steps stay here. A plan names no secret.
CREATE TABLE fleet_plans (
  id TEXT PRIMARY KEY,                 -- pln_<ulid>; a split plan has one row per numbered part
  group_id TEXT NOT NULL,              -- the id of part 1
  part INTEGER NOT NULL DEFAULT 1,
  parts INTEGER NOT NULL DEFAULT 1,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  purpose TEXT NOT NULL,               -- suspend | leave | review
  trigger_kind TEXT NOT NULL,          -- owner | system
  actor_id TEXT,
  source_event TEXT UNIQUE,            -- the system transition that opened this plan
  lifecycle_rev INTEGER NOT NULL,      -- the subject's revision when the owner confirmed; moved = no app step
  state TEXT NOT NULL,
  rail TEXT NOT NULL DEFAULT 'draft',  -- draft | portal_link | none
  rail_code TEXT,
  draft_attempt INTEGER NOT NULL DEFAULT 0,
  draft_key TEXT,                      -- persisted before the call
  draft_id TEXT,
  draft_state TEXT,
  review_url TEXT,
  core_digest TEXT,                    -- Core's bound digest, first read; a different one later stops the plan
  plan_digest TEXT NOT NULL,           -- our own, shown as "reported by the app"
  receipt_id TEXT,
  expires_in_sec INTEGER NOT NULL,
  expires_at INTEGER,
  applying_since INTEGER,
  applied_at INTEGER,
  next_at INTEGER NOT NULL DEFAULT 0,  -- the next tick; a wake sets it to 0
  ticking_until INTEGER NOT NULL DEFAULT 0,  -- the lease of a running tick, so two runs never tick one plan at once
  wanted_json TEXT,                    -- the owner's ticks, until the first read turned them into steps
  code TEXT,
  detail TEXT,
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  issued_at INTEGER,                   -- last draft request of this attempt
  closed_at INTEGER
);
CREATE INDEX fleet_plans_due ON fleet_plans (state, next_at);
CREATE INDEX fleet_plans_subject ON fleet_plans (subject_kind, subject_id, opened_at);
CREATE INDEX fleet_plans_group ON fleet_plans (group_id, part);

CREATE TABLE fleet_plan_steps (
  id TEXT PRIMARY KEY,                 -- pst_<ulid>
  plan_id TEXT NOT NULL REFERENCES fleet_plans (id),
  n INTEGER NOT NULL,
  phase TEXT NOT NULL,                 -- read | core | now (owner's confirm is the approval) | after (runs after Core applied)
  target TEXT NOT NULL,                -- core or a product id
  op TEXT NOT NULL,                    -- agents.pause | agents.offboard | agents.rotate | access_list | access_revoke | none
  agent_id TEXT,
  subject_kind TEXT,
  subject_id TEXT,
  item_id TEXT,
  item_kind TEXT,
  item_digest TEXT,
  label TEXT,
  batch INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  key TEXT,                            -- persisted before the call
  tries INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  code TEXT,
  detail TEXT,
  hold_id TEXT,
  retry_at INTEGER NOT NULL DEFAULT 0,
  output_json TEXT,                    -- outcome kept here: SDK receipts live 90 days
  config_revision INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (plan_id, n)
);
CREATE UNIQUE INDEX fleet_plan_steps_item ON fleet_plan_steps (plan_id, target, item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX fleet_plan_steps_core ON fleet_plan_steps (plan_id, op, agent_id) WHERE phase = 'core';
CREATE INDEX fleet_plan_steps_plan ON fleet_plan_steps (plan_id, phase, state);

-- One row per alert to the owner. Written before the call, so a restart never asks twice.
CREATE TABLE fleet_plan_alerts (
  plan_id TEXT NOT NULL REFERENCES fleet_plans (id),
  kind TEXT NOT NULL,                  -- waiting | expired | date_passed
  channel TEXT NOT NULL,               -- pending | inbox | banner
  code TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, kind)
) WITHOUT ROWID;
