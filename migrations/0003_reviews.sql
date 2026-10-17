-- Governance 0.2.1 (C166, DESIGN §4): trust reviews. Forward-only; 0001 and 0002 are never edited.
-- A review row is evidence. While it is a request (status 'requested') it can move ONCE: to 'done' (a verdict and the
-- digest of the picture the owner looked at were recorded) or to 'dismissed'. A closed row can never be changed or
-- deleted, and no row can be replaced (triggers below). The subject name is a snapshot, so a review survives
-- person_delete. No foreign key on subject_id for the same reason.
--
-- A request about a handle that is not in the directory (subject_id '') keeps the handle in the row (owner-only). The
-- directory entry is created only when the owner records a verdict; an agent never creates an entry.
CREATE TABLE fleet_reviews (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('agent', 'person', 'outside_agent')),
  subject_id TEXT NOT NULL,
  subject_handle TEXT,
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
  next_due_at INTEGER,
  CHECK (subject_id <> '' OR (subject_handle IS NOT NULL AND subject_kind <> 'agent')),
  CHECK (answered_by IS NULL OR status = 'done'),
  -- status and verdict agree: an open request has no verdict and no decision; a dismissed one has a date and no
  -- verdict; a done one has a real verdict (never 'unreviewed'), the digest, the reviewer and a date
  CHECK (
    (status = 'requested' AND verdict IS NULL AND decided_at IS NULL AND snapshot_digest IS NULL AND reviewer IS NULL)
    OR (status = 'dismissed' AND verdict IS NULL AND decided_at IS NOT NULL AND snapshot_digest IS NULL)
    OR (status = 'done' AND verdict IN ('trusted', 'limited', 'blocked') AND snapshot_digest IS NOT NULL AND decided_at IS NOT NULL AND reviewer IS NOT NULL)
  )
);
CREATE INDEX fleet_reviews_subject ON fleet_reviews (subject_kind, subject_id, status, created_at);
CREATE INDEX fleet_reviews_handle ON fleet_reviews (subject_handle, status);
CREATE INDEX fleet_reviews_status ON fleet_reviews (status, id);
CREATE INDEX fleet_reviews_requester ON fleet_reviews (requested_by_kind, requested_by_id, status);

-- INSERT OR REPLACE would delete the old row without firing the delete trigger: refuse any insert of an id that exists.
CREATE TRIGGER fleet_reviews_no_replace BEFORE INSERT ON fleet_reviews
WHEN EXISTS (SELECT 1 FROM fleet_reviews WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'review_append_only');
END;

CREATE TRIGGER fleet_reviews_no_delete BEFORE DELETE ON fleet_reviews
BEGIN
  SELECT RAISE(ABORT, 'review_append_only');
END;

CREATE TRIGGER fleet_reviews_closed_no_update BEFORE UPDATE ON fleet_reviews
WHEN OLD.status <> 'requested'
BEGIN
  SELECT RAISE(ABORT, 'review_append_only');
END;

-- An open request moves once and only so: to done (verdict + digest + the verdict row it was answered by) or to
-- dismissed. It keeps who asked, about whom, why and when. Nothing else can be edited, so 'requested' -> 'requested'
-- is refused too.
CREATE TRIGGER fleet_reviews_transition BEFORE UPDATE ON fleet_reviews
WHEN OLD.status = 'requested' AND (
  NEW.id <> OLD.id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_id <> OLD.subject_id OR IFNULL(NEW.subject_handle, '') <> IFNULL(OLD.subject_handle, '')
  OR NEW.subject_name <> OLD.subject_name OR NEW.requested_by_kind <> OLD.requested_by_kind OR IFNULL(NEW.requested_by_id, '') <> IFNULL(OLD.requested_by_id, '')
  OR NEW.requested_why <> OLD.requested_why OR NEW.created_at <> OLD.created_at
  OR NEW.status = 'requested'
  OR (NEW.status = 'done' AND (NEW.verdict IS NULL OR NEW.snapshot_digest IS NULL OR NEW.answered_by IS NULL))
  OR (NEW.status = 'dismissed' AND (NEW.verdict IS NOT NULL OR NEW.answered_by IS NOT NULL))
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
