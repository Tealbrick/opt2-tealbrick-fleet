-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only; `tb_*` names are reserved for the SDK. One workspace = one app instance = one directory.
CREATE TABLE fleet_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fleet_teams_name ON fleet_teams (name COLLATE NOCASE);

-- People are directory entries, not sign-ins (C84).
CREATE TABLE fleet_people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'departed')),
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Channel handles: "<channel>:<value>" (one format, = the tb.onBehalfOf channel_sender id). One person per handle.
CREATE TABLE fleet_handles (
  handle TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES fleet_people (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX fleet_handles_person ON fleet_handles (person_id);

-- Agents come from the instance slice (needsAgentDirectory); Fleet adds owner, role and tags.
CREATE TABLE fleet_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'removed')),
  owner_id TEXT REFERENCES fleet_people (id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Team memberships of people and agents (no foreign key on subject_id: it names a person or an agent).
CREATE TABLE fleet_members (
  team_id TEXT NOT NULL REFERENCES fleet_teams (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'lead')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, kind, subject_id)
);
CREATE INDEX fleet_members_subject ON fleet_members (kind, subject_id);

-- Directory revision: +1 on every change, so readers (Rules' read model) can skip unchanged pulls.
CREATE TABLE fleet_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO fleet_meta (key, value) VALUES ('revision', 0);
