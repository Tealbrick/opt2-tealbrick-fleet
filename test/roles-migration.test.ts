// C380 T2-a: migration 0011 carries the data of the release before it (0010) intact, moves the revision once, and starts with no role.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_A, migratedDb, migrationFiles } from "./helpers.ts";
import { seedOldSchema } from "./seed.ts";

test("migration 0011 on 0010 data: every row stays, the revision moves once, no role exists, an open assignment is unique per role and subject", () => {
  const db = migratedDb(10);
  seedOldSchema(db);
  db.exec(`INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES ('psn_new', 'New Pat', NULL, '', 'active', 'person', 'trusted', 'owner', '[]', 1, 2);`);
  const dump = () => ({
    people: db.prepare("SELECT * FROM fleet_people ORDER BY id").all(),
    agents: db.prepare("SELECT * FROM fleet_agents ORDER BY id").all(),
    teams: db.prepare("SELECT * FROM fleet_teams ORDER BY id").all(),
    members: db.prepare("SELECT * FROM fleet_members ORDER BY team_id, subject_id").all(),
    events: db.prepare("SELECT * FROM fleet_lifecycle_events ORDER BY seq").all(),
    settings: db.prepare("SELECT * FROM fleet_settings ORDER BY key").all(),
  });
  const before = dump();
  const rev = () => Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value);
  const was = rev();
  for (const m of migrationFiles(13).slice(10)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  assert.deepEqual(dump(), before, "no row of 0.4.0-dev.2 changed");
  assert.equal(rev(), was + 1, "readers read the feed again in full");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_roles").get()?.n), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_role_assignments").get()?.n), 0);
  // fire on bad: two live roles of one name (any case); quiet on good: an archived one frees the name
  db.prepare("INSERT INTO fleet_roles (id, name, created_at, updated_at) VALUES ('rol_1', 'Contractor', 1, 1)").run();
  assert.throws(() => db.prepare("INSERT INTO fleet_roles (id, name, created_at, updated_at) VALUES ('rol_2', 'contractor', 1, 1)").run(), /UNIQUE/);
  db.prepare("UPDATE fleet_roles SET archived_at = 5 WHERE id = 'rol_1'").run();
  db.prepare("INSERT INTO fleet_roles (id, name, created_at, updated_at) VALUES ('rol_2', 'contractor', 1, 1)").run();
  const add = (id: string) => db.prepare("INSERT INTO fleet_role_assignments (id, role_id, subject_kind, subject_id, reason, created_at) VALUES (?, 'rol_2', 'agent', ?, 'other', 1)").run(id, AGENT_A.id);
  add("ras_1");
  assert.throws(() => add("ras_2"), /UNIQUE/);
  db.prepare("UPDATE fleet_role_assignments SET ended_at = 9 WHERE id = 'ras_1'").run();
  add("ras_2");
});
