-- Governance 0.3.0 (C373, RULES-INTERFACE §3): a cache of the channel handles Connect issued to agents, for the
-- directory feed's optional `accept: ["agent_handles"]`. Forward-only; 0001 to 0004 are never edited.
-- Source: Connect `identities_list`, read with Governance's companion grant by a timer OUTSIDE calls (never inside the
-- fleet_facts hook or inside directory_feed). A refresh that changes the set bumps the feed revision. Connect down, a
-- hold or an incomplete paging keeps the last cache: it is never cleared on an error.
-- `handle` is the canonical normalizeHandle form that also passes the feed HANDLE_PATTERN (checked again on read).
CREATE TABLE fleet_agent_handles (
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 64),
  handle TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 200),
  PRIMARY KEY (agent_id, handle)
) WITHOUT ROWID;
-- when the last COMPLETE answer of Connect was stored (ms since epoch); 0 = never
INSERT INTO fleet_meta (key, value) VALUES ('agent_handles_at', 0);
