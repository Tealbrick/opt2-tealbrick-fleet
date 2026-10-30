// C380 B9b: migration 0009 adds the access tables and leaves 0.3.2 and 0008 data as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { migratedDb, migrationFiles } from "./helpers.ts";
import { seedOldSchema } from "./seed.ts";

const AT_0008 = 8;
const tables = ["fleet_access_items", "fleet_sweeps", "fleet_read_state", "fleet_exceptions"];

test("0009 is the next file after 0008, and no two migration files share a number", () => {
  const names = migrationFiles().map((m) => m.name);
  assert.equal(names[AT_0008], "0009_access.sql");
  assert.equal(new Set(names.map((n) => n.slice(0, 4))).size, names.length);
});

test("0009 on data of 0.3.2 and 0008: no row changes and the feed revision does not move", () => {
  const db = migratedDb(7);
  seedOldSchema(db);
  for (const m of migrationFiles(AT_0008).slice(7)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  const dump = () => ({
    meta: db.prepare("SELECT * FROM fleet_meta ORDER BY key").all(),
    people: db.prepare("SELECT * FROM fleet_people ORDER BY id").all(),
    agents: db.prepare("SELECT * FROM fleet_agents ORDER BY id").all(),
    handles: db.prepare("SELECT * FROM fleet_handles ORDER BY handle").all(),
    events: db.prepare("SELECT * FROM fleet_lifecycle_events ORDER BY seq").all(),
    settings: db.prepare("SELECT * FROM fleet_settings ORDER BY key").all(),
  });
  const before = dump();
  const m = migrationFiles()[AT_0008];
  assert.ok(m);
  db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  assert.deepEqual(dump(), before);
  for (const t of tables) assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n), 0, `${t} starts empty`);
});

test("one shadow row per target and item: the same id under another target is a second row, the same pair is refused", () => {
  const db = migratedDb();
  const ins = db.prepare("INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, digest, first_seen, last_seen) VALUES (?, 'routine:a', 'routine', 'agent', 'agt_x', 'a', 'held_by', 'use', 'L', 'active', 1, 'sha256:0', 1, 1)");
  ins.run("evolution");
  ins.run("connect");
  assert.throws(() => ins.run("evolution"));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_access_items").get()?.n), 2);
});

test("an unlinked item has no subject id; an exception reason over 200 characters is refused", () => {
  const db = migratedDb();
  db.exec("INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, digest, first_seen, last_seen) VALUES ('connect', 'account_as_me:a', 'account_as_me', 'unlinked', NULL, 'a', 'held_by', 'use', 'L', 'active', 0, 'sha256:0', 1, 1)");
  assert.throws(() => db.prepare("INSERT INTO fleet_exceptions (code, subject_kind, subject_id, reason, until, at) VALUES ('no_owner', 'agent', 'a', ?, 2, 1)").run("x".repeat(201)));
  db.prepare("INSERT INTO fleet_exceptions (code, subject_kind, subject_id, reason, until, at) VALUES ('no_owner', 'agent', 'a', ?, 2, 1)").run("x".repeat(200));
});
