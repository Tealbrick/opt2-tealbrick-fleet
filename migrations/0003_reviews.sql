-- Governance 0.2.1 (C166, DESIGN §4): trust reviews. Forward-only; 0001 and 0002 are never edited.
-- A review row is evidence. While it is a request (status 'requested') it can move once: to 'done' (a verdict was
-- recorded) or to 'dismissed'. A closed row ('done' or 'dismissed') can never be changed or deleted (triggers below).
-- The subject name is a snapshot, so a review survives person_delete. No foreign key on subject_id for the same reason.
CREATE TABLE fleet_reviews (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('agent', 'person', 'outside_agent')),
  subject_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'done', 'dismissed')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('unreviewed', 'trusted', 'limited', 'blocked')),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('owner', 'agent', 'system')),
  requested_by_id TEXT,
  requested_why TEXT NOT NULL DEFAULT '' CHECK (length(requested_why) <= 500),
  reviewer TEXT,
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR length(snapshot_json) <= 8192),
  snapshot_digest TEXT,
  -- a request that a later verdict answered points at the verdict row; the verdict rows are the history
  answered_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  next_due_at INTEGER
);
CREATE INDEX fleet_reviews_subject ON fleet_reviews (subject_kind, subject_id, status, created_at);
CREATE INDEX fleet_reviews_status ON fleet_reviews (status, id);
CREATE INDEX fleet_reviews_requester ON fleet_reviews (requested_by_kind, requested_by_id, status);

CREATE TRIGGER fleet_reviews_closed_no_update BEFORE UPDATE ON fleet_reviews
WHEN OLD.status <> 'requested'
BEGIN
  SELECT RAISE(ABORT, 'review_append_only');
END;

CREATE TRIGGER fleet_reviews_no_delete BEFORE DELETE ON fleet_reviews
BEGIN
  SELECT RAISE(ABORT, 'review_append_only');
END;

-- A request keeps who asked, about whom, and when, even while it moves to done or dismissed.
CREATE TRIGGER fleet_reviews_request_fields BEFORE UPDATE ON fleet_reviews
WHEN OLD.status = 'requested' AND (
  NEW.id <> OLD.id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_id <> OLD.subject_id OR NEW.subject_name <> OLD.subject_name
  OR NEW.requested_by_kind <> OLD.requested_by_kind OR IFNULL(NEW.requested_by_id, '') <> IFNULL(OLD.requested_by_id, '')
  OR NEW.requested_why <> OLD.requested_why OR NEW.created_at <> OLD.created_at OR NEW.status = 'requested' AND NEW.verdict IS NOT OLD.verdict
)
BEGIN
  SELECT RAISE(ABORT, 'review_append_only');
END;

-- Yes/no settings of the review schedule (fleet_review_policy holds the day counts and needs values >= 1).
CREATE TABLE fleet_review_flags (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK (value IN (0, 1))
);
-- A new agent opens a review request by default; "changed access" has an effect once Core gives apps the access data (G-2).
INSERT INTO fleet_review_flags (key, value) VALUES ('review_new_agents', 1), ('review_changed_access', 0);
