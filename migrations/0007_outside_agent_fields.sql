-- Governance 0.3.1 (C373 WP-D, Q13): the owner form "Add outside agent" keeps the organisation and the relationship
-- (DESIGN §5: `org`, `relationship` on fleet_people). Forward-only, one transaction. Both are owner-side text only: they
-- are in person ops (overview_get, person_set) and in no agent op, no hook fact and not in the directory feed.
ALTER TABLE fleet_people ADD COLUMN org TEXT NOT NULL DEFAULT '';
ALTER TABLE fleet_people ADD COLUMN relationship TEXT NOT NULL DEFAULT '';
