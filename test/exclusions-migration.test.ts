// C380 T2-c: migration 0013 carries the data of the release before it (0012) intact, moves no revision (a rule is not in the feed), and starts with no rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { migratedDb, migrationFiles } from "./helpers.ts";
import { seedOldSchema } from "./seed.ts";

test("migration 0013 on 0012 data: every row stays, the revision does not move, no rule exists; a pair is stored once and one live rule per pair", () => {
  const db = migratedDb(12);
  seedOldSchema(db);
  db.prepare("INSERT INTO fleet_roles (id, name, created_at, updated_at) VALUES ('rol_a', 'Approver', 1, 1)").run();
  db.prepare("INSERT INTO fleet_roles (id, name, created_at, updated_at) VALUES ('rol_b', 'Payer', 1, 1)").run();
  db.prepare("INSERT INTO fleet_role_assignments (id, role_id, subject_kind, subject_id, reason, started_at, created_at) VALUES ('ras_1', 'rol_a', 'person', 'psn_1', 'other', 1, 1)").run();
  const dump = () => ({
    people: db.prepare("SELECT * FROM fleet_people ORDER BY id").all(),
    agents: db.prepare("SELECT * FROM fleet_agents ORDER BY id").all(),
    roles: db.prepare("SELECT * FROM fleet_roles ORDER BY id").all(),
    assignments: db.prepare("SELECT * FROM fleet_role_assignments ORDER BY id").all(),
    events: db.prepare("SELECT * FROM fleet_lifecycle_events ORDER BY seq").all(),
    settings: db.prepare("SELECT * FROM fleet_settings ORDER BY key").all(),
  });
  const before = dump();
  const rev = () => Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value);
  const was = rev();
  for (const m of migrationFiles().slice(12)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  assert.deepEqual(dump(), before, "no row of the release before changed");
  assert.equal(rev(), was, "a rule is not in the feed: no reader reads it again");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_exclusions").get()?.n), 0);
  const add = (id: string, kind: string, a: string, b: string) => db.prepare("INSERT INTO fleet_exclusions (id, kind, role_a, role_b, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)").run(id, kind, a, b);
  // fire on bad: an unordered pair in the wrong order, the same role twice, two live rules of one pair
  assert.throws(() => add("xcl_1", "roles", "rol_b", "rol_a"), /CHECK/);
  assert.throws(() => add("xcl_1", "roles", "rol_a", "rol_a"), /CHECK/);
  add("xcl_1", "roles", "rol_a", "rol_b");
  assert.throws(() => add("xcl_2", "roles", "rol_a", "rol_b"), /UNIQUE/);
  // quiet on good: an archived rule frees the pair; a holder-owner rule is ordered and may name one role twice
  db.prepare("UPDATE fleet_exclusions SET archived_at = 5 WHERE id = 'xcl_1'").run();
  add("xcl_2", "roles", "rol_a", "rol_b");
  add("xcl_3", "holder_owner", "rol_b", "rol_a");
  add("xcl_4", "holder_owner", "rol_a", "rol_b");
  add("xcl_5", "holder_owner", "rol_a", "rol_a");
});
