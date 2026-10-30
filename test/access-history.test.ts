// C380 T2-b: the change log behind the access record. Appeared, changed, ended; quiet when nothing changed; an ended row is kept after the shadow copy
// lets it go; one copy of the read state per finished sweep. The shadow copy and the log are written in one transaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessEnv } from "../src/access/client.ts";
import { storeItems } from "../src/access/items.ts";
import { type SweepEnv, sweepTick } from "../src/access/sweep.ts";
import { AGT, AGT2, accessEnv, answer, fakeStores, wire } from "./access-helpers.ts";
import { migratedDb } from "./helpers.ts";

function jobEnv(db: Db, base: AccessEnv, clock: { now: number }): SweepEnv {
  const held: { state: Json | null } = { state: null };
  return {
    ...base,
    db,
    now: () => clock.now++,
    job: { input: { by: "schedule" }, get state() { return held.state; } } as unknown as SweepEnv["job"],
    checkpoint: ((state: Json, write?: (d: Db) => unknown) =>
      db.transaction(() => {
        const out = write?.(db);
        held.state = state;
        return out;
      })) as SweepEnv["checkpoint"],
  };
}
const NONE = { status: "ok", output: { v: 1, asOf: "2026-10-30T16:00:00Z", items: [], nextCursor: null, notShown: [], complete: true } };
const quiet = { connect: () => NONE, knowledge: () => NONE, kanban: () => NONE, evolution: () => NONE };

async function sweep(db: Db, replies: Parameters<typeof fakeStores>[0], clock: { now: number }) {
  const env = jobEnv(db, accessEnv(fakeStores({ ...quiet, ...replies }).callApp), clock);
  for (let i = 0; i < 400; i++) if ((await sweepTick({}, env))?.status === "done") return;
  throw new Error("the sweep did not end");
}
const routine = (id: string, over: Record<string, unknown> = {}) => wire("evolution", { id: `routine:${id}`, kind: "routine", resource: id, ...over });
const log = (db: Db) => db.prepare("SELECT sweep_id, change, target, item_id, state, label FROM fleet_access_history ORDER BY seq").all().map((r) => [r.change, r.item_id, r.state, r.label]);

test("a first sweep logs `appeared`; the same list again logs nothing; a state change logs `changed`; a dropped item logs `ended` and keeps what it was", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { evolution: () => answer([routine("a"), routine("b")]) }, clock);
  assert.deepEqual(log(db), [["appeared", "routine:a", "active", "A thing"], ["appeared", "routine:b", "active", "A thing"]]);
  await sweep(db, { evolution: () => answer([routine("a"), routine("b")]) }, clock);
  assert.equal(log(db).length, 2, "the same list: no row");
  await sweep(db, { evolution: () => answer([routine("a", { state: "paused" }), routine("b")]) }, clock);
  assert.deepEqual(log(db).at(-1), ["changed", "routine:a", "paused", "A thing"]);
  await sweep(db, { evolution: () => answer([routine("b")]) }, clock);
  assert.deepEqual(log(db).at(-1), ["ended", "routine:a", "paused", "A thing"], "the last known row is kept");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_access_items WHERE item_id = 'routine:a'").get()?.n), 0, "the shadow copy let it go");
  await sweep(db, { evolution: () => answer([routine("a"), routine("b")]) }, clock);
  assert.deepEqual(log(db).at(-1), ["appeared", "routine:a", "active", "A thing"], "back after the end is a new row");
  assert.equal(new Set(db.prepare("SELECT sweep_id FROM fleet_access_history").all().map((r) => r.sweep_id)).size, 4, "the sweep with no change wrote no row; each other row names its sweep");
});

test("a label, a revoke flag or a subject change is a change; the store's own `since` date alone is not", async () => {
  const db = migratedDb();
  const clock = { now: 2_000_000 };
  await sweep(db, { evolution: () => answer([routine("a")]) }, clock);
  await sweep(db, { evolution: () => answer([routine("a", { since: "2026-10-01T00:00:00Z" })]) }, clock);
  assert.equal(log(db).length, 1, "since alone: no row");
  await sweep(db, { evolution: () => answer([routine("a", { label: "Renamed" })]) }, clock);
  await sweep(db, { evolution: () => answer([routine("a", { label: "Renamed", revocable: false })]) }, clock);
  await sweep(db, { evolution: () => answer([routine("a", { label: "Renamed", revocable: false, subject: { kind: "agent", id: AGT2 } })]) }, clock);
  assert.deepEqual(log(db).map((r) => r[0]), ["appeared", "changed", "changed", "changed"]);
});

test("a sweep that could not read a store deletes nothing and logs no `ended`; the copy of the read state says so", async () => {
  const db = migratedDb();
  const clock = { now: 3_000_000 };
  await sweep(db, { evolution: () => answer([routine("a")]) }, clock);
  await sweep(db, { evolution: () => { throw new Error("down"); } }, clock);
  assert.deepEqual(log(db).map((r) => r[0]), ["appeared"], "no `ended` for a store that was not read");
  const stores = db.prepare("SELECT sweep_id, target, state FROM fleet_sweep_stores WHERE target = 'evolution' ORDER BY sweep_id").all();
  assert.equal(stores.length, 2, "one copy per finished sweep");
  assert.equal(stores[0]?.state, "read");
  assert.notEqual(stores[1]?.state, "read");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_sweep_stores WHERE sweep_id = ?").get(String(stores[1]?.sweep_id))?.n), 4, "all four stores");
});

test("the log and the shadow copy are one transaction: a refused write leaves neither", () => {
  const db = migratedDb();
  const item = { id: "routine:a", kind: "routine", subject: { kind: "agent" as const, id: AGT }, resource: "a", direction: "held_by" as const, level: "use" as const, label: "L", state: "active" as const, revocable: true, since: null, digest: "sha256:0" };
  assert.throws(() =>
    db.transaction(() => {
      storeItems(db, "evolution", [item], "swp_1", 5);
      throw new Error("refused");
    }),
  );
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_access_history").get()?.n), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_access_items").get()?.n), 0);
  storeItems(db, "evolution", [item], "swp_1", 5);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_access_history").get()?.n), 1);
});
