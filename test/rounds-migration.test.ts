// C380 T2-b: migration 0012 adds the round, history and sweep-store tables and leaves every earlier row as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { migratedDb, migrationFiles } from "./helpers.ts";
import { seedOldSchema } from "./seed.ts";

const FILE = "0012_review_rounds.sql";
const upTo = (db: ReturnType<typeof migratedDb>, files: { sql: string }[]) => {
  for (const m of files) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
};

test("0012 is its own file, after 0011, and no two migration files share a number", () => {
  const names = migrationFiles().map((m) => m.name);
  assert.ok(names.includes(FILE));
  assert.equal(names.indexOf(FILE), names.length - 1, "nothing after it in this tree");
  assert.equal(new Set(names.map((n) => n.slice(0, 4))).size, names.length);
});

test("0012 on data of 0.3.2 and 0011: no earlier row changes, the feed revision does not move, the shadow copy is entered as `appeared`", () => {
  const db = migratedDb(7);
  seedOldSchema(db);
  const all = migrationFiles();
  const before12 = all.filter((m) => m.name < FILE);
  upTo(db, before12.slice(7));
  db.exec(
    `INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, digest, first_seen, last_seen, last_sweep)
     VALUES ('connect', 'account_as_itself:a', 'account_as_itself', 'agent', 'agt_x', 'a', 'held_by', 'use', 'Mail', 'active', 1, 'sha256:1', 5, 6, 'swp_1'),
            ('knowledge', 'agent_area:b', 'agent_area', 'agent', 'agt_x', 'b', 'held_by', 'read', 'Area', 'paused', 0, 'sha256:2', 5, 6, 'swp_1');`,
  );
  const dump = () => ({
    meta: db.prepare("SELECT * FROM fleet_meta ORDER BY key").all(),
    people: db.prepare("SELECT * FROM fleet_people ORDER BY id").all(),
    agents: db.prepare("SELECT * FROM fleet_agents ORDER BY id").all(),
    events: db.prepare("SELECT * FROM fleet_lifecycle_events ORDER BY seq").all(),
    items: db.prepare("SELECT * FROM fleet_access_items ORDER BY target, item_id").all(),
    sweeps: db.prepare("SELECT * FROM fleet_sweeps").all(),
    settings: db.prepare("SELECT * FROM fleet_settings ORDER BY key").all(),
  });
  const before = dump();
  upTo(db, all.filter((m) => m.name === FILE));
  assert.deepEqual(dump(), before);
  for (const t of ["fleet_rounds", "fleet_campaign_items", "fleet_sweep_stores"]) assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n), 0, `${t} starts empty`);
  const h = db.prepare("SELECT sweep_id, change, target, item_id, state, label FROM fleet_access_history ORDER BY seq").all();
  assert.deepEqual(h.map((r) => [r.sweep_id, r.change, r.target, r.item_id, r.state, r.label]), [
    ["migrated", "appeared", "connect", "account_as_itself:a", "active", "Mail"],
    ["migrated", "appeared", "knowledge", "agent_area:b", "paused", "Area"],
  ]);
  const since = Number(db.prepare("SELECT value FROM fleet_record_meta WHERE key = 'record_since'").get()?.value);
  assert.ok(since > 1_700_000_000_000, "record_since is a time in ms");
});

test("the history and the link table cannot be edited or erased; one request belongs to one round", () => {
  const db = migratedDb();
  db.exec(`INSERT INTO fleet_access_history (sweep_id, at, change, target, item_id, kind, subject_kind, resource, direction, level, label, state, revocable, digest)
    VALUES ('swp_1', 1, 'appeared', 'evolution', 'routine:a', 'routine', 'unlinked', 'a', 'held_by', 'use', 'L', 'active', 1, 'sha256:0')`);
  assert.throws(() => db.exec("UPDATE fleet_access_history SET state = 'paused'"), /access_history_append_only/);
  assert.throws(() => db.exec("DELETE FROM fleet_access_history"), /access_history_append_only/);
  db.exec("INSERT INTO fleet_rounds (id, title, scope, created_at) VALUES ('rnd_1', 'Q4', 'agents', 1)");
  db.exec("INSERT INTO fleet_campaign_items (round_id, review_id, subject_kind, subject_id, subject_name, added_at) VALUES ('rnd_1', 'rvw_1', 'agent', 'agt_x', 'A', 1)");
  assert.throws(() => db.exec("DELETE FROM fleet_campaign_items"), /campaign_item_append_only/);
  assert.throws(() => db.exec("UPDATE fleet_campaign_items SET subject_id = 'agt_y'"), /campaign_item_append_only/);
  assert.throws(() => db.exec("UPDATE fleet_campaign_items SET subject_name = 'B'"), /campaign_item_append_only/);
  db.exec("UPDATE fleet_campaign_items SET removal = 'queued', wanted_json = '[]'"); // the removal fields do move
  assert.throws(() => db.exec("INSERT INTO fleet_campaign_items (round_id, review_id, subject_kind, subject_id, subject_name, added_at) VALUES ('rnd_1', 'rvw_1', 'agent', 'agt_z', 'Z', 1)"));
  db.exec("INSERT INTO fleet_rounds (id, title, scope, created_at) VALUES ('rnd_2', 'Q5', 'agents', 1)");
  assert.throws(() => db.exec("INSERT INTO fleet_campaign_items (round_id, review_id, subject_kind, subject_id, subject_name, added_at) VALUES ('rnd_2', 'rvw_1', 'agent', 'agt_x', 'A', 1)"), "a request belongs to one round");
  assert.throws(() => db.exec("INSERT INTO fleet_rounds (id, title, scope, created_at) VALUES ('rnd_3', '', 'agents', 1)"), "a title is needed");
});
