// Governance 0.4.1: the five review items left by the 0.4.0 cut (C383). Real SQLite, real lifecycle setter, real runner. Only Core and the stores are fakes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { accessAfterLeave, findingsList, openDifferences } from "../src/access/differences.ts";
import { directoryFeed } from "../src/feed.ts";
import { ACCESS_BACK, ACCESS_REMOVED } from "../src/findings.ts";
import { loadSubject } from "../src/lifecycle/transitions.ts";
import { loadColleagues } from "../src/lifecycle/view.ts";
import { coreStepsFor } from "../src/plans/plan.ts";
import * as store from "../src/store.ts";
import { accessShown, type DecodedTopology } from "../src/topology-slice.ts";
import { refused, set, T0, WAIVE, world } from "./lifecycle-helpers.ts";
import { makeWorld, SALES } from "./plans-world.ts";

const WRONG = "slack:UWRONG0001";
const RIGHT = "slack:URIGHT0001";
const NEXT_WEEK = new Date(T0 + 7 * 86_400_000).toISOString();

const blocked = (db: ReturnType<typeof world>["db"], id: string) => db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(id);
const startsLater = (db: ReturnType<typeof world>["db"], id: string) => db.prepare("UPDATE fleet_people SET valid_from = ? WHERE id = ?").run(Date.parse(NEXT_WEEK), id);
const notes = (db: ReturnType<typeof world>["db"], id: string) => db.prepare("SELECT note FROM fleet_lifecycle_events WHERE subject_id = ? ORDER BY seq").all(id).map((r) => String(r.note));

test("person_delete: a blocked person, a blocked outside agent and a person who has not started stay on the floor", () => {
  const { db } = world();
  const bad = store.setPerson(db, { name: "Bad", handles: [WRONG] }, T0);
  blocked(db, bad.id);
  assert.throws(() => store.deletePerson(db, bad.id, T0), refused("blocked_stays", 409));
  assert.equal(store.getPerson(db, bad.id).handles.length, 1, "a refusal changes nothing");

  const out = store.setPerson(db, { name: "Outside", kind: "outside_agent", handles: [RIGHT] }, T0);
  blocked(db, out.id);
  assert.throws(() => store.deletePerson(db, out.id, T0), refused("blocked_stays", 409));

  const later = store.setPerson(db, { name: "Later", handles: ["slack:ULATER0001"] }, T0);
  startsLater(db, later.id);
  assert.throws(() => store.deletePerson(db, later.id, T0), refused("lifecycle_open", 409));

  // the way out is the owner's named step
  db.prepare("UPDATE fleet_people SET trust = 'trusted' WHERE id = ?").run(bad.id);
  assert.equal(store.deletePerson(db, bad.id, T0), true);
  db.prepare("UPDATE fleet_people SET valid_from = NULL WHERE id = ?").run(later.id);
  assert.equal(store.deletePerson(db, later.id, T0), true);
});

test("a person who has not started: a handle cannot be taken off, one can be added, and the kind cannot change", () => {
  const { db } = world();
  const later = store.setPerson(db, { name: "Later", handles: [WRONG] }, T0);
  startsLater(db, later.id);
  assert.throws(() => store.setPerson(db, { id: later.id, name: "Later", handles: [] }, T0), refused("handles_stay", 409));
  assert.throws(() => store.setPerson(db, { id: later.id, name: "Later", handles: [RIGHT] }, T0), refused("handles_stay", 409), "a swap takes one off");
  assert.equal(store.setPerson(db, { id: later.id, name: "Later", handles: [WRONG, RIGHT] }, T0).handles.length, 2);
  assert.throws(() => store.setPerson(db, { id: later.id, name: "Later", kind: "outside_agent" }, T0), refused("lifecycle_open", 409), "an outside agent has no start date");
});

test("a wrong handle comes off a stopped person now, with a reason on the record; the others stay refused", async () => {
  const { db, ann } = world();
  store.setPerson(db, { id: ann.id, name: "Ann", handles: [WRONG, RIGHT] }, T0);
  set(db, "person", ann.id, "suspended", { noCap: true });
  assert.throws(() => store.setPerson(db, { id: ann.id, name: "Ann", handles: [RIGHT] }, T0), refused("handles_stay", 409), "no reason: as before");
  assert.throws(() => store.setPerson(db, { id: ann.id, name: "Ann", handles: [RIGHT], handleFix: " ​ " }, T0), refused("handles_stay", 409), "a reason of nothing is none");
  assert.equal(store.getPerson(db, ann.id).handles.length, 2);
  const rev = Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value ?? -1);

  const done = store.setPerson(db, { id: ann.id, name: "Ann", handles: [RIGHT], handleFix: "This is Bob's account" }, T0);
  assert.deepEqual(done.handles, [RIGHT]);
  assert.equal(store.getPerson(db, ann.id).status, "active", "the stop itself is untouched");
  assert.equal(loadSubject(db, "person", ann.id)?.lifecycle, "suspended");
  assert.ok(Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value ?? -1) > rev, "Rules reads the change");
  const note = notes(db, ann.id).at(-1) as string;
  assert.match(note, /A wrong handle was taken off \(slack\)\. Why: This is Bob's account/);
  assert.doesNotMatch(note, /UWRONG/, "the record lists no handle");

  // Rules no longer refuses the wrong handle, and still refuses the right one
  const feed = directoryFeed(db, { v: 1, accept: ["lifecycle"] } as never) as unknown as { contacts: { id: string; floor?: boolean; handles: string[] }[] };
  const row = feed.contacts.find((c) => c.id === ann.id) as { floor?: boolean; handles: string[] };
  assert.deepEqual(row.handles, [RIGHT]);
  assert.equal(row.floor, true);
});

test("the same for blocked, not started, leaving and closed; a person with no refusal writes no such event", () => {
  const { db, ann } = world();
  const hold = (id: string) => store.setPerson(db, { id, name: "X", handles: [], handleFix: "wrong" }, T0);
  const a = store.setPerson(db, { name: "A", handles: [WRONG] }, T0);
  blocked(db, a.id);
  assert.equal(hold(a.id).handles.length, 0);
  const b = store.setPerson(db, { name: "B", handles: ["slack:UB00000001"] }, T0);
  startsLater(db, b.id);
  assert.equal(hold(b.id).handles.length, 0);
  store.setAgent(db, { agent: "agt_01J0000000000000000000000A", owner: null }, T0);
  store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UC00000001"] }, T0);
  set(db, "person", ann.id, "leaving", { noCap: true });
  assert.equal(hold(ann.id).handles.length, 0, "leaving");
  store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UD00000001"] }, T0);
  set(db, "person", ann.id, "archived", { waive: WAIVE }, T0 + 1);
  assert.equal(hold(ann.id).handles.length, 0, "closed");

  const free = store.setPerson(db, { name: "Free", handles: [RIGHT] }, T0);
  store.setPerson(db, { id: free.id, name: "Free", handles: [], handleFix: "not asked" }, T0);
  assert.equal(notes(db, free.id).some((n) => n.includes("taken off")), false);
});

test("the manifest takes the reason, by person only, with the bound the server cuts to", () => {
  const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as { operations: { id: string; audience?: string; input: { properties: Record<string, { maxLength?: number }> } }[] };
  const op = manifest.operations.find((o) => o.id === "person_set");
  assert.equal(op?.audience, "person");
  assert.equal(op?.input.properties.handleFix?.maxLength, 200);
});

/** An offboard of Sales that Core applied and the slice shows. */
async function removed() {
  const w = makeWorld();
  set(w.db, "agent", SALES, "leaving", {}, w.clock.t);
  const id = w.makePlan({ kind: "agent", id: SALES });
  await w.tick(id);
  w.core.apply(String(w.plan(id).draft_key));
  w.core.deliver();
  await w.tick(id);
  assert.equal(w.steps(id).find((s) => s.op === "agents.offboard")?.state, "done");
  w.db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(SALES); // what the slice writes
  return w;
}
const picture = (connections: DecodedTopology["connections"], edges: DecodedTopology["edges"] = [], truncated = false): DecodedTopology => ({ instances: [], edges, companions: [], connections, ...(truncated ? { truncated: true as const } : {}) });
const KEY = { con: "con_01M6AAAAAAAAAAAAAAAAAAAAAA", agt: SALES, method: "pairing" as const, status: "active" as const };

test("a paused agent reinstated in Portal with a new key reads so; no key, a revoked key, a cut list or no list stay as they are", async () => {
  const w = await removed();
  const row = (top?: DecodedTopology | null) => loadColleagues(w.db, w.clock.t, top).byId.get(`agent:${SALES}`);
  assert.equal(row(picture([]))?.line, ACCESS_REMOVED);
  assert.equal(row(null)?.line, ACCESS_REMOVED, "Governance cannot see: it says what Core said");
  assert.equal(row(picture([{ ...KEY, status: "revoked" }]))?.line, ACCESS_REMOVED, "a revoked key is no key");
  assert.equal(row(picture([KEY], [], true))?.line, ACCESS_REMOVED, "a cut list proves nothing");
  assert.equal(row(picture([KEY]))?.line, ACCESS_BACK);
  assert.ok(row(picture([KEY]))?.findings.some((f) => f.code === "access_back"));
  const grant = { agent: SALES, ins: "ins_x", product: "connect", crud: ["read" as const], mode: "free" as const, held: [] };
  assert.equal(row(picture([], [grant]))?.line, ACCESS_BACK, "a grant is access too");
  assert.equal(row(picture([]))?.findings.some((f) => f.code === "access_back"), false);
});

test("the agent reads as before until Core removed it: Stopped, removal waits is not the new line", async () => {
  const w = makeWorld();
  set(w.db, "agent", SALES, "leaving", {}, w.clock.t);
  w.db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(SALES);
  const r = loadColleagues(w.db, w.clock.t, picture([KEY])).byId.get(`agent:${SALES}`);
  assert.equal(r?.line, "Stopped, removal waits for you");
  assert.equal(r?.findings.some((f) => f.code === "access_back"), false);
});

test("a new request asks Portal again for an agent that has a key again, and not for one that has none", async () => {
  const w = await removed();
  const s = loadSubject(w.db, "agent", SALES);
  assert.ok(s);
  assert.deepEqual(coreStepsFor(w.db, s, [], accessShown(picture([]))), [], "nothing to ask");
  assert.deepEqual(coreStepsFor(w.db, s, [], accessShown(picture([KEY]))), [{ opId: "agents.offboard", agt: SALES }]);
  assert.deepEqual(coreStepsFor(w.db, s, [], accessShown(picture([KEY], [], true))), [], "a cut list asks nothing new");
});

test("row 5: an agent's owner memory is not access held once Core removed its access; it counts again with a new key; a close keeps the reading; other items still count", async () => {
  const w = await removed();
  const add = (target: string, kind: string, id: string) => w.db.prepare("INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, digest, first_seen, last_seen) VALUES (?, ?, ?, 'agent', ?, 'r', 'held_by', 'write', 'l', 'active', 0, 'sha256:x', 1, 1)").run(target, id, kind, SALES);
  add("knowledge", "person_area", "person_area:a");
  add("knowledge", "agent_area", "agent_area:a");
  add("connect", "buzz_identity", "buzz_identity:a");
  const key = `agent:${SALES}`;
  assert.equal(accessAfterLeave(w.db).has(key), false, "nobody can act as it");
  const rows = () => loadColleagues(w.db, w.clock.t, picture([KEY])).rows;
  const code = "access_after_leave";
  assert.equal(rows().find((r) => r.id === SALES)?.findings.some((f) => f.code === code), true, "a new key: it can read them again");
  assert.deepEqual(accessAfterLeave(w.db, accessShown(picture([KEY]))).get(key)?.stores, ["Connect", "Knowledge"].sort());
  assert.ok(findingsList(w.db, rows().map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings })), { read: true }, w.clock.t, accessShown(picture([KEY]))).items.some((i) => i.code === code && i.productName?.includes("Knowledge")));
  assert.ok(openDifferences(w.db, rows(), w.clock.t, accessShown(picture([KEY]))) > 0);

  w.clock.t += 1000;
  set(w.db, "agent", SALES, "archived", { waive: WAIVE }, w.clock.t);
  assert.equal(accessAfterLeave(w.db).has(key), false, "a close moves the date of the state, not what Core did");

  add("connect", "scheduled_post", "scheduled_post:a");
  assert.deepEqual(accessAfterLeave(w.db).get(key)?.stores, ["Connect"], "a post can still go out");
});

test("row 5: before Core removed it, the owner's memory counts", () => {
  const w = makeWorld();
  set(w.db, "agent", SALES, "leaving", {}, w.clock.t);
  w.db.prepare("INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, digest, first_seen, last_seen) VALUES ('knowledge', 'person_area:a', 'person_area', 'agent', ?, 'r', 'held_by', 'read', 'l', 'active', 0, 'sha256:x', 1, 1)").run(SALES);
  assert.equal(accessAfterLeave(w.db).has(`agent:${SALES}`), true, "the key may still work");
});
