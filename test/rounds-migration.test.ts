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
            ('knowledge', 'agent_area:b', 'agent_area', 'agent', 'agt_x', 'b', 'held_by', 'read', 'Area', 'paused', 0, 'sha256:2', 5, 6, 'swp_1');
     INSERT INTO fleet_sweeps (id, started_by, started_at, finished_at, calls, stores_read) VALUES ('swp_1', 'schedule', 5, 6, 4, 4);
     INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, requested_by_kind, requested_why, created_at) VALUES ('rvw_1', 'agent', 'agt_x', 'X', 'requested', 'owner', 'x', 1);
     INSERT INTO fleet_exceptions (code, subject_kind, subject_id, reason, until, at) VALUES ('no_owner', 'agent', 'agt_x', 'r', 9, 1);`,
  );
  // every table that exists before 0012, row by row; fleet_sweeps by its old columns (0012 adds one, NULL on a sweep of an earlier version)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fleet_%' ORDER BY name").all().map((r) => String(r.name));
  const dump = () => Object.fromEntries(tables.map((t) => [t, db.prepare(t === "fleet_sweeps" ? "SELECT id, started_by, started_at, finished_at, calls, stores_read FROM fleet_sweeps" : `SELECT * FROM ${t}`).all()]));
  const before = dump();
  assert.ok(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews").get()?.n) > 0 && Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_people").get()?.n) > 0, "the dump has rows to compare");
  upTo(db, all.filter((m) => m.name === FILE));
  assert.deepEqual(dump(), before);
  assert.equal(db.prepare("SELECT history_seq FROM fleet_sweeps").get()?.history_seq, null, "an earlier sweep has no list");
  for (const t of ["fleet_rounds", "fleet_campaign_items", "fleet_sweep_stores"]) assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n), 0, `${t} starts empty`);
  const h = db.prepare("SELECT sweep_id, change, target, item_id, state, label, at FROM fleet_access_history ORDER BY seq").all();
  assert.deepEqual(h.map((r) => [r.sweep_id, r.change, r.target, r.item_id, r.state, r.label]), [
    ["migrated", "appeared", "connect", "account_as_itself:a", "active", "Mail"],
    ["migrated", "appeared", "knowledge", "agent_area:b", "paused", "Area"],
  ]);
  const since = Number(db.prepare("SELECT value FROM fleet_record_meta WHERE key = 'record_since'").get()?.value);
  assert.ok(since > 1_700_000_000_000, "record_since is a time in ms");
  assert.deepEqual([...new Set(h.map((r) => Number(r.at)))], [since], "the seeded rows carry that one time");
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

test("INSERT OR REPLACE cannot rewrite the history, the link table or the sweep copy; no other kind of change is accepted", () => {
  const db = migratedDb();
  db.exec(`INSERT INTO fleet_access_history (seq, sweep_id, at, change, target, item_id, kind, subject_kind, resource, direction, level, label, state, revocable, digest)
    VALUES (1, 'swp_1', 1, 'appeared', 'evolution', 'routine:a', 'routine', 'unlinked', 'a', 'held_by', 'use', 'L', 'active', 1, 'sha256:0')`);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO fleet_access_history (seq, sweep_id, at, change, target, item_id, kind, subject_kind, resource, direction, level, label, state, revocable, digest)
    VALUES (1, 'swp_1', 1, 'appeared', 'evolution', 'routine:a', 'routine', 'unlinked', 'a', 'held_by', 'use', 'HACKED', 'active', 1, 'sha256:0')`), /access_history_append_only/);
  assert.throws(() => db.exec(`INSERT INTO fleet_access_history (sweep_id, at, change, target, item_id, kind, subject_kind, resource, direction, level, label, state, revocable, digest)
    VALUES ('swp_1', 1, 'vanished', 'evolution', 'routine:b', 'routine', 'unlinked', 'a', 'held_by', 'use', 'L', 'active', 1, 'sha256:0')`), "only appeared, changed or ended");
  assert.equal(db.prepare("SELECT label FROM fleet_access_history").get()?.label, "L");
  db.exec("INSERT INTO fleet_rounds (id, title, scope, created_at) VALUES ('rnd_1', 'Q4', 'agents', 1)");
  db.exec("INSERT INTO fleet_campaign_items (round_id, review_id, subject_kind, subject_id, subject_name, added_at) VALUES ('rnd_1', 'rvw_1', 'agent', 'agt_x', 'A', 1)");
  assert.throws(() => db.exec("INSERT OR REPLACE INTO fleet_campaign_items (round_id, review_id, subject_kind, subject_id, subject_name, added_at) VALUES ('rnd_1', 'rvw_1', 'agent', 'agt_y', 'B', 1)"), /campaign_item_append_only/);
  for (const col of ["round_id = 'rnd_2'", "review_id = 'rvw_9'", "subject_kind = 'person'", "subject_id = 'agt_y'", "subject_name = 'B'", "added_at = 2"]) assert.throws(() => db.exec(`UPDATE fleet_campaign_items SET ${col}`), /campaign_item_append_only|FOREIGN KEY/, col);
  assert.equal(db.prepare("SELECT subject_id FROM fleet_campaign_items").get()?.subject_id, "agt_x");
  db.exec("INSERT INTO fleet_sweep_stores (sweep_id, target, state) VALUES ('swp_1', 'connect', 'read')");
  assert.throws(() => db.exec("INSERT OR REPLACE INTO fleet_sweep_stores (sweep_id, target, state) VALUES ('swp_1', 'connect', 'not_read')"), /sweep_stores_append_only/);
  assert.throws(() => db.exec("UPDATE fleet_sweep_stores SET state = 'not_read'"), /sweep_stores_append_only/);
  assert.throws(() => db.exec("DELETE FROM fleet_sweep_stores"), /sweep_stores_append_only/);
  assert.equal(db.prepare("SELECT state FROM fleet_sweep_stores").get()?.state, "read");
});
