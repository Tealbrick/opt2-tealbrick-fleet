// C380 B9a, A24: migration 0008 carries 0.3.2 data intact.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_A, AGENT_B, migratedDb, migrationFiles } from "./helpers.ts";
import { seedOldSchema } from "./seed.ts";

test("A24: migration 0008 on 0.3.2 data keeps every row and column; removed = archived, no_card; departed = leaving; others active; outside agents none", () => {
  const db = migratedDb(7);
  seedOldSchema(db);
  db.exec(`
    INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES
      ('psn_left', 'Left Bo', NULL, 'Old title', 'departed', 'person', 'trusted', 'owner', '["t"]', 1, 2),
      ('psn_bot', 'Outside Bot', NULL, '', 'active', 'outside_agent', 'blocked', 'owner', '[]', 1, 2);
    INSERT INTO fleet_agents (id, name, mode, status, owner_id, role, tags, trust, first_seen, updated_at) VALUES
      ('agt_01J0000000000000000000000C', 'Removed C', 'free', 'removed', 'psn_left', 'r', '[]', 'blocked', 1, 2);
    INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, requested_by_kind, requested_why, created_at) VALUES ('rvw_1', 'agent', '${AGENT_A.id}', 'Agent A', 'requested', 'system', 'x', 1);`);
  const dump = () => ({
    people: db.prepare("SELECT id, name, email, title, status, tags, kind, trust, source, org, relationship, created_at FROM fleet_people ORDER BY id").all(),
    agents: db.prepare("SELECT id, name, mode, status, owner_id, role, tags, trust, first_seen FROM fleet_agents ORDER BY id").all(),
    handles: db.prepare("SELECT * FROM fleet_handles ORDER BY handle").all(),
    members: db.prepare("SELECT * FROM fleet_members ORDER BY team_id, subject_id").all(),
    teams: db.prepare("SELECT * FROM fleet_teams ORDER BY id").all(),
    reviews: db.prepare("SELECT * FROM fleet_reviews ORDER BY id").all(),
  });
  const before = dump();
  const revision = () => Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value);
  const rev = revision();
  for (const m of migrationFiles().slice(7)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  assert.deepEqual(dump(), before, "no 0.3.2 column changed");
  assert.equal(revision(), rev + 1, "the revision moves once");
  const agents = Object.fromEntries(db.prepare("SELECT id, lifecycle, migrated_note FROM fleet_agents").all().map((r) => [String(r.id), [r.lifecycle, r.migrated_note]]));
  assert.deepEqual(agents[AGENT_A.id], ["active", null]);
  assert.deepEqual(agents[AGENT_B.id], ["active", null], "a paused or unowned agent is active: nothing is paused for having no owner");
  assert.deepEqual(agents.agt_01J0000000000000000000000C, ["archived", "no_card"]);
  const people = Object.fromEntries(db.prepare("SELECT id, lifecycle FROM fleet_people").all().map((r) => [String(r.id), r.lifecycle]));
  assert.deepEqual(people, { psn_ann: "active", psn_left: "leaving", psn_bot: null });
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events WHERE kind = 'migrated'").get()?.n), 2);
});

test("migration 0008: the event table is append-only and the settings have their defaults", () => {
  const db = migratedDb();
  db.exec("INSERT INTO fleet_lifecycle_events (id, subject_kind, subject_id, subject_name, kind, actor_kind, at) VALUES ('lev_1', 'agent', 'a', 'A', 'changed', 'owner', 1)");
  assert.throws(() => db.exec("UPDATE fleet_lifecycle_events SET note = 'x'"), /lifecycle_events_append_only/);
  assert.throws(() => db.exec("DELETE FROM fleet_lifecycle_events"), /lifecycle_events_append_only/);
  assert.throws(() => db.exec("INSERT OR REPLACE INTO fleet_lifecycle_events (id, subject_kind, subject_id, subject_name, kind, actor_kind, at) VALUES ('lev_1', 'agent', 'a', 'B', 'changed', 'owner', 2)"), /lifecycle_events_append_only/);
  assert.throws(() => db.exec(`INSERT INTO fleet_lifecycle_events (id, subject_kind, subject_id, subject_name, kind, actor_kind, snapshot_json, at) VALUES ('lev_2', 'agent', 'a', 'B', 'changed', 'owner', '${"x".repeat(8193)}', 2)`));
  assert.deepEqual(db.prepare("SELECT key, value FROM fleet_settings ORDER BY key").all().map((r) => [r.key, r.value]), [["cooling_days", "30"], ["stop_cap", "5"]]);
});
