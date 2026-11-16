-- Governance 0.4.2: chat handles that an app reports for an agent, next to the handles Connect issued (0005).
-- Forward-only; no existing table or row changes, and the revision does not move here.
-- `fleet_agent_handles` stays the Connect cache and is replaced only by the Connect timer. This table holds what a reader app
-- reports with the op `agent_handle_report`: one set per (agent, source_product). The Connect timer never reads or deletes it,
-- and a report replaces only the rows of its own product for that agent. `handle` is the canonical form that passes the feed
-- HANDLE_PATTERN (the op checks it; the feed checks it again on read). `updated_at` is ms since epoch.
CREATE TABLE fleet_agent_handles_app (
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 64),
  handle TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 200),
  source_product TEXT NOT NULL CHECK (length(source_product) BETWEEN 1 AND 64),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, handle, source_product)
) WITHOUT ROWID;

-- Every handle Governance knows for an agent, whoever reported it: the Connect cache and the app reports. The feed, the handle
-- conflict checks and the review self-check read this view, so a reported handle counts like a Connect handle.
CREATE VIEW fleet_agent_handles_all AS
  SELECT agent_id, handle FROM fleet_agent_handles
  UNION
  SELECT agent_id, handle FROM fleet_agent_handles_app;
