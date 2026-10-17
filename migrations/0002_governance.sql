-- Governance 0.2.0 (C166): kind and trust. Forward-only, one transaction (SDK-API §7.1). 0001 is never edited.
-- The column defaults are the fail-closed values ('unreviewed', 'agent'): a row written by a path that forgets to set
-- them is not trusted. The rows that already exist were all entered by the owner, so they become 'trusted' / 'owner'
-- below. The rule for new rows lives in ONE function (src/trust.ts defaultTrust): the owner's entries start trusted,
-- entries that an agent adds start unreviewed.

-- Contacts = people and outside agents (kind). Handles stay in fleet_handles.
ALTER TABLE fleet_people ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'outside_agent'));
ALTER TABLE fleet_people ADD COLUMN trust TEXT NOT NULL DEFAULT 'unreviewed' CHECK (trust IN ('unreviewed', 'trusted', 'limited', 'blocked'));
ALTER TABLE fleet_people ADD COLUMN source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('owner', 'agent'));
ALTER TABLE fleet_agents ADD COLUMN trust TEXT NOT NULL DEFAULT 'unreviewed' CHECK (trust IN ('unreviewed', 'trusted', 'limited', 'blocked'));

UPDATE fleet_people SET trust = 'trusted', source = 'owner';
UPDATE fleet_agents SET trust = 'trusted';

-- Review schedule (days between reviews). Review operations come with 0.2.1; the defaults are stored now.
CREATE TABLE fleet_review_policy (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK (value >= 1 AND value <= 3650)
);
INSERT INTO fleet_review_policy (key, value) VALUES ('agent_days', 90), ('contact_days', 180);

-- The directory changed in kind (new fields, trust): the revision moves, so a reader that cached the old one pulls again.
UPDATE fleet_meta SET value = value + 1 WHERE key = 'revision';
