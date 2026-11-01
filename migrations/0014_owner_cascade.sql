-- Governance 0.4.0 (C381, N2-4): an owner's state no longer changes an agent's effective state or its floor. This replaces the rule of DESIGN-C380 §2 "Effective lifecycle".
--
-- Correction of 0008, which stays as it is applied: its header says of migrated agents "nothing starts to refuse by this step". That was false while the owner cascade existed: an agent of a
-- person the step made `leaving` read as suspended, and the floor refused it once Rules read the feed. From this version it is true for agents. Still true for 0008: a blocked entry and a person
-- the step made `leaving` are refused once Rules 0.7 reads the feed. Page "Who is refused" and the release notes list them, to be read before Rules is updated.
--
-- No row of an agent changes: keep_running and keep_reason are no longer read, and they stay so that a rollback to an older dev build behaves as it did. The revision moves, so a reader that holds
-- the old floor reads the feed again at once, and the agents the cascade stopped leave its floor. A Core pause that an owner approved earlier stays: finding paused_outside shows it.
UPDATE fleet_meta SET value = value + 1 WHERE key = 'revision';

-- One row for the record, only where a record exists: a new install has nothing to correct.
INSERT INTO fleet_lifecycle_events (id, subject_kind, subject_id, subject_name, kind, actor_kind, note, at)
SELECT 'lev_c381_owner_change_note', 'workspace', '', 'Governance', 'migrated', 'system', 'From this version an owner''s change no longer stops the owner''s agents. Agents keep working, and a finding says when an agent needs an owner.', CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM fleet_lifecycle_events);
