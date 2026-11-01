// C381: a person's change bars that person. Their agents keep working. This file holds the cases of the change itself: the feed, the plan, the transfer and its key, the stop
// choice, the cap, the owned items, the page of who is refused, the upgrade from dev.100, the same-name refusal, the tab stops and the leave flow. Real SQLite throughout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { handlers, manifest } from "../src/app.ts";
import { type DirectoryFeed, directoryFeed } from "../src/feed.ts";
import { NEEDS_CONNECT } from "../src/findings.ts";
import { leanDirectory } from "../src/lean.ts";
import { noteOwnerRule, verifyChain } from "../src/lifecycle/events.ts";
import { setAgentMoved } from "../src/lifecycle/moved.ts";
import { setDates, stopReach } from "../src/lifecycle/transitions.ts";
import { loadColleagues } from "../src/lifecycle/view.ts";
import { requestForNewAgents } from "../src/reviews.ts";
import * as store from "../src/store.ts";
import { agentFacts } from "../src/store.ts";
import { tabStops } from "../src/ui/dialog-focus.ts";
import { AGENT_A, AGENT_B, migratedDb, migrationFiles } from "./helpers.ts";
import { OWNER, refused, set, stateOf, T0, world } from "./lifecycle-helpers.ts";
import { agentId, agentItem, approveAndDeliver, HENRY, makeWorld, SALES, type World } from "./plans-world.ts";
import { seedOldSchema } from "./seed.ts";

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const PERSON = { type: "person", id: "per_owner", name: "owner", mode: null };
const ctxOf = (w: World): OpContext => ({ db: w.db, caller: PERSON, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, bridgeCaps: () => ["owner_drafts"], paused: () => ({ workspace: false, instance: false, agent: false }), ownerDrafts: w.core, jobs: { enqueue: () => {} }, ownerLink: () => null, ownerLinkFor: () => null }) as unknown as OpContext;
const dbCtx = (db: Db, extra: object = {}): OpContext => ({ db, caller: PERSON, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, ownerLink: () => null, ...extra }) as unknown as OpContext;
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const specOf = (id: string) => manifest.operations.find((o) => o.id === id) as unknown as { input: Parameters<typeof validateAgainstSchema>[0]; output: Parameters<typeof validateAgainstSchema>[0] };
const validOut = (id: string, out: unknown) => {
  const v = validateAgainstSchema(specOf(id).output, out as Json);
  assert.deepEqual(v.ok ? [] : v.errors, [], `${id} output`);
};
const feedOf = (db: Db) => directoryFeed(db, { accept: ["lifecycle"] }) as Extract<DirectoryFeed, { unchanged: false }>;
const agentRow = (db: Db, id: string) => feedOf(db).agents.find((a) => a.id === id);
const contactRow = (db: Db, id: string) => feedOf(db).contacts.find((c) => c.id === id);
const codes = (w: { db: Db; clock?: { t: number } }, id: string): string[] => loadColleagues(w.db, w.clock?.t ?? T0).byId.get(`agent:${id}`)?.findings.map((f) => f.code) ?? [];
const stepsOf = (w: World) => w.core.open()[0]?.steps.map((s) => `${s.opId} ${s.agt}`).sort();

/** Ann owns Henry and Sales as in every plan test; Bob is an active person who can take an agent. */
const withBob = () => {
  const w = makeWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  return { w, bob };
};

test("a. the feed: an owner who is leaving, suspended or closed bars the person only; their active agent is active and not refused", () => {
  const db = world().db;
  const person = (name: string) => store.setPerson(db, { name }, T0);
  const [p1, p2, p3] = [person("Leaves"), person("Paused"), person("Closed")] as [ReturnType<typeof person>, ReturnType<typeof person>, ReturnType<typeof person>];
  const ids = [10, 11, 12, 13, 14, 15].map(agentId);
  const [x1, x2, x3, blocked, own, future] = ids as [string, string, string, string, string, string];
  const all = [AGENT_A, AGENT_B, ...ids.map((id, i) => ({ id, name: `Agent ${i}`, mode: "free" as const, status: "active" as const }))];
  store.syncAgents(db, all as never, T0);
  requestForNewAgents(db, all as never, T0);
  for (const [id, owner] of [[x1, p1.id], [x2, p2.id], [x3, p3.id], [blocked, p1.id], [own, p1.id], [future, p1.id]] as const) {
    store.setAgent(db, { agent: id, owner }, T0);
    set(db, "agent", id, "active");
  }
  // an entry that is blocked, one with its own stop, one that has not started: each of them is refused whatever the owner is
  db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(blocked);
  set(db, "agent", own, "suspended");
  setDates(db, { kind: "agent", id: future, validFrom: new Date(T0 + 86_400_000).toISOString(), actor: OWNER }, T0);
  // an agent with a stopped owner is the same as one with an active owner before the owner is stopped
  for (const id of [x1, x2, x3]) assert.deepEqual([agentRow(db, id)?.lifecycle, agentRow(db, id)?.floor], ["active", false], "before");
  set(db, "person", p1.id, "leaving");
  set(db, "person", p2.id, "suspended");
  db.prepare("UPDATE fleet_people SET lifecycle = 'archived' WHERE id = ?").run(p3.id); // a closed person whose agent still names them (a database from before the Close guard)
  db.prepare("UPDATE fleet_meta SET value = value + 1 WHERE key = 'revision'").run();
  for (const [person, agent, state] of [[p1, x1, "leaving"], [p2, x2, "suspended"], [p3, x3, "archived"]] as const) {
    assert.deepEqual([contactRow(db, person.id)?.lifecycle, contactRow(db, person.id)?.floor], [state, true], `${state}: the person is refused`);
    assert.deepEqual([agentRow(db, agent)?.lifecycle, agentRow(db, agent)?.floor], ["active", false], `${state}: their agent is not`);
  }
  assert.deepEqual([agentRow(db, blocked)?.lifecycle, agentRow(db, blocked)?.floor], ["active", true], "blocked is refused whatever the lifecycle says");
  assert.deepEqual([agentRow(db, own)?.lifecycle, agentRow(db, own)?.floor], ["suspended", true], "an agent with its own stop");
  assert.deepEqual([agentRow(db, future)?.lifecycle, agentRow(db, future)?.floor], ["not_started", true], "an agent that has not started");
  assert.equal(agentRow(db, AGENT_A.id)?.floor, false);
  assert.equal(agentRow(db, AGENT_B.id)?.floor, false);
  // the reader of a feed with no `accept` sees the old fields only
  const plain = directoryFeed(db, {}) as Extract<DirectoryFeed, { unchanged: false }>;
  assert.ok(plain.agents.every((a) => !("floor" in a)));
});

test("b. a person marked leaving with no decisions has no Core step and no draft; the agent runs on, and a finding says it keeps working", async () => {
  const w = makeWorld();
  w.db.prepare("INSERT INTO fleet_handles (handle, person_id, created_at) VALUES ('slack:UANN', ?, 1)").run(w.ann.id);
  w.connect.add({ id: "channel_sender:slack:UANN", kind: "channel_sender", subject: { kind: "person", id: w.ann.id }, resource: "slack:UANN", level: "use", label: "Slack sender" });
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const out = await run("plan_send", { kind: "person", id: w.ann.id }, ctxOf(w));
  validOut("plan_send", out);
  const id = out.plans[0].id as string;
  assert.equal(out.plans[0].mode, "none", "no rail: no draft");
  assert.deepEqual(w.steps(id).filter((s) => s.phase === "core"), []);
  await w.tick(id);
  assert.equal(w.core.data.drafts.length, 0, "nothing was asked of Portal");
  assert.equal(w.plan(id).draft_key ?? null, null);
  assert.deepEqual(w.connect.data.ended, ["channel_sender:slack:UANN"], "the sender bar: the person's own item");
  assert.equal(w.plan(id).state, "done");
  assert.equal(w.steps(id).some((s) => s.item_id === "account_as_itself:a"), false, "no item of the agent");
  // the agents run on
  for (const a of [HENRY, SALES]) {
    assert.equal(stateOf(w.db, "agent", a), "active");
    assert.equal(w.core.data.agents[a]?.status, "active", "Core: running");
    assert.deepEqual([agentRow(w.db, a)?.lifecycle, agentRow(w.db, a)?.floor], ["active", false]);
  }
  const finding = loadColleagues(w.db, w.clock.t).byId.get(`agent:${HENRY}`)?.findings.find((f) => f.code === "owner_inactive");
  assert.match(String(finding?.text), /keeps working/);
  assert.ok(!codes(w, HENRY).includes("key_not_decided"), "nothing is paused: no key to decide");
  // and an agent with no owner says the same
  store.setAgent(w.db, { agent: SALES, owner: null }, w.clock.t);
  assert.match(String(loadColleagues(w.db, w.clock.t).byId.get(`agent:${SALES}`)?.findings.find((f) => f.code === "no_owner")?.text), /keeps working/);
});

test("c. a transfer with the default key: the new owner at once, the agent unchanged and not refused, one rotate and no pause, and the finding ends when Core has the new key", async () => {
  const { w, bob } = withBob();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const out = await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w));
  validOut("plan_send", out);
  const id = out.plans[0].id as string;
  assert.equal(w.db.prepare("SELECT owner_id FROM fleet_agents WHERE id = ?").get(HENRY)?.owner_id, bob.id, "at once");
  assert.equal(stateOf(w.db, "agent", HENRY), "active");
  assert.equal((await run("colleague_get", { kind: "agent", id: HENRY }, ctxOf(w))).colleague.effective, "active");
  assert.deepEqual([agentRow(w.db, HENRY)?.lifecycle, agentRow(w.db, HENRY)?.floor], ["active", false]);
  assert.deepEqual(w.steps(id).filter((s) => s.phase === "core").map((s) => `${String(s.op)} ${String(s.agent_id)}`), [`agents.rotate ${HENRY}`]);
  assert.ok(codes(w, HENRY).includes("key_after_transfer"));
  w.clock.t = Date.now() + 1000; // the op stamped the change with the real clock
  await w.tick(id);
  assert.deepEqual(stepsOf(w), [`agents.rotate ${HENRY}`], "one rotate");
  assert.ok(!stepsOf(w)?.some((s) => s.startsWith("agents.pause")), "no pause");
  assert.equal(w.core.data.agents[HENRY]?.status, "active", "the draft is not approved: the agent works");
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  assert.equal(w.plan(id).state, "done");
  assert.equal(w.core.data.agents[HENRY]?.keys, 0, "the old key is gone");
  assert.equal(w.core.data.agents[HENRY]?.status, "active", "approving the rotate paused nothing");
  assert.ok(!codes(w, HENRY).includes("key_after_transfer"), "the finding ends");
  assert.equal(agentRow(w.db, HENRY)?.floor, false);
});

test("d. a transfer with newKey false: no Core step, the finding stays; a later plan on the agent rotates the key and clears it", async () => {
  const { w, bob } = withBob();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const out = await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id, newKey: false }] }, ctxOf(w));
  const id = out.plans[0].id as string;
  assert.equal(w.db.prepare("SELECT owner_id FROM fleet_agents WHERE id = ?").get(HENRY)?.owner_id, bob.id);
  assert.equal(out.plans[0].mode, "none");
  assert.deepEqual(w.steps(id).filter((s) => s.phase === "core"), [], "no rotate, no pause");
  w.clock.t = Date.now() + 1000;
  await w.tick(id);
  assert.equal(w.core.data.drafts.length, 0);
  assert.ok(codes(w, HENRY).includes("key_after_transfer"), "stays until a new key exists");
  assert.equal(w.core.data.agents[HENRY]?.keys, 1);
  // later: the owner makes the key
  const later = await run("plan_send", { kind: "agent", id: HENRY, transfers: [HENRY] }, ctxOf(w));
  const id2 = later.plans[0].id as string;
  await w.tick(id2);
  assert.deepEqual(stepsOf(w), [`agents.rotate ${HENRY}`]);
  approveAndDeliver(w, String(w.plan(id2).draft_key), HENRY);
  await w.tick(id2);
  assert.equal(w.plan(id2).state, "done");
  assert.equal(w.core.data.agents[HENRY]?.keys, 0);
  assert.ok(!codes(w, HENRY).includes("key_after_transfer"), "cleared");
  assert.equal(stateOf(w.db, "agent", HENRY), "active");
});

test("e. a stop decision: that agent goes leaving with one offboard step and is refused; the person's other agents are untouched", async () => {
  const w = makeWorld();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const out = await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "stop" }] }, ctxOf(w));
  const id = out.plans[0].id as string;
  assert.equal(stateOf(w.db, "agent", HENRY), "leaving");
  assert.deepEqual([agentRow(w.db, HENRY)?.lifecycle, agentRow(w.db, HENRY)?.floor], ["leaving", true]);
  await w.tick(id);
  assert.deepEqual(w.core.open()[0]?.steps, [{ opId: "agents.offboard", agt: HENRY }]);
  assert.equal(w.core.data.agents[SALES]?.status, "active");
  assert.equal(stateOf(w.db, "agent", SALES), "active");
  assert.deepEqual([agentRow(w.db, SALES)?.lifecycle, agentRow(w.db, SALES)?.floor], ["active", false]);
  assert.equal(w.db.prepare("SELECT owner_id FROM fleet_agents WHERE id = ?").get(SALES)?.owner_id, w.ann.id, "still the person's, still working");
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  await w.tick(id);
  assert.equal(w.core.data.agents[HENRY]?.keys, 0, "the stop took the key");
  assert.equal(w.core.data.agents[SALES]?.keys, 1);
});

test("f. the cap: a person with ten agents counts as one; ten explicit stop decisions count ten", async () => {
  const ten = (w: World) => {
    const ids = Array.from({ length: 10 }, (_, i) => agentId(100 + i));
    store.syncAgents(w.db, [...w.db.prepare("SELECT id, name, mode, status FROM fleet_agents").all(), ...ids.map((id) => ({ id, name: id, mode: "free", status: "active" }))] as never, w.clock.t);
    for (const id of ids) {
      store.setAgent(w.db, { agent: id, owner: w.ann.id }, w.clock.t);
      w.core.addAgent(id, 0, 0);
    }
    return ids;
  };
  const { stopsSince, stoppedSince } = await import("../src/lifecycle/events.ts");
  const a = makeWorld();
  ten(a);
  assert.deepEqual(stopReach("person", a.ann.id), [`person:${a.ann.id}`], "one entry");
  set(a.db, "person", a.ann.id, "leaving", {}, a.clock.t); // 12 agents, cap 5, and no confirm is asked
  assert.equal(stopsSince(a.db, a.clock.t - 1000), 1);
  assert.deepEqual([...stoppedSince(a.db, a.clock.t - 1000)], [`person:${a.ann.id}`]);

  const b = makeWorld();
  const ids = ten(b);
  const now = Date.now();
  b.clock.t = now;
  set(b.db, "person", b.ann.id, "leaving", {}, now);
  const was = ids.map((id) => stateOf(b.db, "agent", id));
  const decisions = ids.map((agent) => ({ agent, decision: "stop" }));
  const input = { kind: "person", id: b.ann.id, decisions };
  await assert.rejects(run("plan_send", input, ctxOf(b)), (e: TbError) => e.code === "stop_cap_reached" && e.details?.count === 11);
  assert.deepEqual(ids.map((id) => stateOf(b.db, "agent", id)), was, "refused whole: nothing moved");
  await run("plan_send", { ...input, confirmCount: 11 }, ctxOf(b));
  for (const id of ids) assert.equal(stateOf(b.db, "agent", id), "leaving");
  assert.equal(stopsSince(b.db, now - 1000), 11, "the person once, each stopped agent once");
});

test("g. the person's plan does not end the agent's items; with a transfer its items stay listed, ticked or not", async () => {
  const w = makeWorld();
  w.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const id = (await run("plan_send", { kind: "person", id: w.ann.id }, ctxOf(w))).plans[0].id as string;
  await w.tick(id);
  assert.equal(w.steps(id).some((s) => s.item_id === "account_as_itself:a"), false, "not in the steps of the person's plan");
  assert.deepEqual(w.connect.data.ended, []);
  assert.deepEqual(w.connect.data.handled, []);

  const { w: v, bob } = withBob();
  v.connect.add(agentItem({ id: "account_as_itself:a", kind: "account_as_itself" }));
  set(v.db, "person", v.ann.id, "leaving", {}, v.clock.t);
  const rotated = (await run("plan_send", { kind: "person", id: v.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }], items: [{ product: "connect", id: "account_as_itself:a" }] }, ctxOf(v))).plans[0].id as string;
  await v.tick(rotated);
  assert.equal(v.item(rotated, "account_as_itself:a").state, "listed", "listed, not revoked: the agent is not closing");
  approveAndDeliver(v, String(v.plan(rotated).draft_key), HENRY);
  await v.tick(rotated);
  assert.deepEqual(v.connect.data.ended, []);
  assert.equal(v.connect.data.handled.length, 0);
});

/** 0008 closed departed people as `leaving` with the reason `migrated`; this is that database, with the rows C381 is about. */
function migratedWorld(upTo = Number.POSITIVE_INFINITY) {
  const db = migratedDb(7);
  seedOldSchema(db);
  db.exec(`
    INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES
      ('psn_left', 'Left Bo', NULL, '', 'departed', 'person', 'trusted', 'owner', '[]', 1, 2),
      ('psn_blk', 'Blocked Bea', NULL, '', 'active', 'person', 'blocked', 'owner', '[]', 1, 2);
    INSERT INTO fleet_agents (id, name, mode, status, owner_id, role, tags, trust, first_seen, updated_at) VALUES
      ('agt_01J0000000000000000000000C', 'Of Left Bo', 'free', 'active', 'psn_left', '', '[]', 'trusted', 1, 2),
      ('agt_01J0000000000000000000000D', 'Own Stop', 'free', 'active', 'psn_ann', '', '[]', 'trusted', 1, 2);`);
  for (const m of migrationFiles(upTo).slice(7)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  return db;
}
const revision = (db: Db) => Number(db.prepare("SELECT value FROM fleet_meta WHERE key = 'revision'").get()?.value);

test("h. refusals_get on a migrated seed: blocked and departed people start with the update; an agent of a departed owner keeps working and is not refused; an own stop is also refused; the op reads only", async () => {
  const db = migratedWorld();
  set(db, "agent", "agt_01J0000000000000000000000D", "suspended");
  const before = { rev: revision(db), events: db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get()?.n, plans: db.prepare("SELECT COUNT(*) AS n FROM fleet_plans").get()?.n };
  const out = await run("refusals_get", {}, dbCtx(db));
  validOut("refusals_get", out);
  const starts = Object.fromEntries(out.startsWithUpdate.map((r: { id: string; why: string; kind: string }) => [r.id, [r.kind, r.why]]));
  assert.deepEqual(starts.psn_blk, ["person", "blocked"], "the blocked entry");
  assert.deepEqual(starts.psn_left, ["person", "left_before_update"], "the person who departed before the update");
  assert.equal(out.startsTotal, 2);
  const also = out.alsoRefused.map((r: { id: string; why: string }) => [r.id, r.why]);
  assert.deepEqual(also, [["agt_01J0000000000000000000000D", "stopped"]], "the agent's own stop");
  const keep = Object.fromEntries(out.keepWorking.map((r: { id: string; owner: string | null }) => [r.id, r.owner]));
  assert.equal(keep.agt_01J0000000000000000000000C, "Left Bo", "its owner departed, and it keeps working");
  assert.equal(keep[AGENT_B.id], null, "no owner at all");
  for (const id of ["agt_01J0000000000000000000000C", AGENT_B.id]) {
    assert.ok(!out.startsWithUpdate.some((r: { id: string }) => r.id === id), `${id}: not refused at the update`);
    assert.ok(!out.alsoRefused.some((r: { id: string }) => r.id === id), `${id}: not refused at all`);
    assert.equal(agentRow(db, id)?.floor, false);
  }
  assert.equal(out.rules.state, "not_installed");
  // read only: nothing moved, nothing was written
  assert.deepEqual({ rev: revision(db), events: db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get()?.n, plans: db.prepare("SELECT COUNT(*) AS n FROM fleet_plans").get()?.n }, before);
  // the answer is the owner's: an agent is refused
  await assert.rejects(run("refusals_get", {}, dbCtx(db, { caller: { type: "agent", id: AGENT_A.id, name: "A", mode: "free" } })), refused("no_access", 403));
});

test("i. an upgrade from dev.100 data: the revision moves, the agent of a leaving owner is no longer refused, one note is in the record, through the chain; a fresh install has no note", () => {
  const db = migratedWorld(13);
  const left = "agt_01J0000000000000000000000C";
  // the person who left before the update is `leaving` since 0008: their agent is owned by them
  assert.equal(stateOf(db, "person", "psn_left"), "leaving");
  const was = revision(db);
  const rows = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get()?.n);
  assert.ok(rows > 0, "a record exists");
  const dump = () => ({ people: db.prepare("SELECT * FROM fleet_people ORDER BY id").all(), agents: db.prepare("SELECT * FROM fleet_agents ORDER BY id").all() });
  const rowsBefore = dump();
  const m14 = migrationFiles()[13];
  assert.equal(m14?.name, "0014_owner_cascade.sql");
  db.exec(`BEGIN;\n${m14?.sql}\nCOMMIT;`);
  assert.equal(revision(db), was + 1, "a reader that holds the floor reads the feed again");
  assert.deepEqual(dump(), rowsBefore, "no row of a person or an agent changed");
  assert.deepEqual([agentRow(db, left)?.lifecycle, agentRow(db, left)?.floor], ["active", false], "its owner left, and it is not refused");
  assert.equal(contactRow(db, "psn_left")?.floor, true, "the person is");
  noteOwnerRule(db, T0);
  noteOwnerRule(db, T0 + 1);
  const note = db.prepare("SELECT subject_kind, kind, actor_kind, note FROM fleet_lifecycle_events WHERE note LIKE 'From this version%'").get();
  assert.deepEqual({ ...note }, { subject_kind: "workspace", kind: "migrated", actor_kind: "system", note: "From this version an owner's change no longer stops the owner's agents. Agents keep working, and a finding says when an agent needs an owner." });
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get()?.n), rows + 1, "one row");
  assert.deepEqual(verifyChain(db), { ok: true, rows: rows + 1 });
  assert.ok(codes({ db }, left).includes("owner_inactive"), "the finding says it needs an owner");
  // a fresh install has no record to correct
  const fresh = migratedDb();
  noteOwnerRule(fresh, T0);
  assert.equal(Number(fresh.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get()?.n), 0);
  assert.deepEqual(verifyChain(fresh), { ok: true, rows: 0 });
});

test("j. person_set: the same name twice is refused unless the owner says it is another person; different emails say so; an outside agent is not a person", async () => {
  const { db } = world();
  const c = dbCtx(db);
  const call = (input: Record<string, unknown>) => run("person_set", input, c);
  assert.equal(validateAgainstSchema(specOf("person_set").input, { name: "Pat", sameName: true } as Json).ok, true, "the field is in the schema");
  const first = await call({ name: "Pat Lee" });
  validOut("person_set", first);
  // fire: no email on either, in another case
  await assert.rejects(call({ name: "pat lee" }), refused("person_name_taken", 409));
  // fire: the same email
  await call({ name: "Sam Roe", email: "sam@example.com" });
  await assert.rejects(call({ name: "Sam Roe", email: "SAM@example.com" }), refused("person_name_taken", 409));
  // fire: one email only: nothing says they differ
  await assert.rejects(call({ name: "Sam Roe", email: null }), refused("person_name_taken", 409));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_people WHERE lower(name) IN ('pat lee', 'sam roe')").get()?.n), 2, "a refusal wrote nothing");
  // quiet: the owner says it
  const second = await call({ name: "Pat Lee", sameName: true });
  assert.notEqual(second.person.id, first.person.id);
  // quiet: different emails
  const other = await call({ name: "Sam Roe", email: "other@example.com" });
  assert.equal(other.person.email, "other@example.com");
  // quiet: an edit keeps its own name
  await call({ id: first.person.id, name: "Pat Lee", title: "Lead" });
  // quiet: an outside agent has no such check, and does not make a person's name taken
  await call({ name: "Pat Lee", kind: "outside_agent" });
  await call({ name: "Out Bot", kind: "outside_agent" });
  await call({ name: "Out Bot" });
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_people WHERE lower(name) = 'out bot'").get()?.n), 2);
});

test("k. tabStops: one stop for each radio group, the checked one, or the first when none is checked", () => {
  const r = (name: string, checked: boolean, tag = `${name}${checked ? "*" : ""}`) => ({ type: "radio", name, checked, tag });
  const t = (type: string, tag: string) => ({ type, tag });
  const tags = (list: readonly { tag: string }[]) => list.map((x) => x.tag);
  const a1 = r("a", false, "a1");
  const a2 = r("a", true, "a2");
  const a3 = r("a", false, "a3");
  const b1 = r("b", false, "b1");
  const b2 = r("b", false, "b2");
  const list = [t("text", "first"), a1, a2, a3, t("button", "mid"), b1, b2, t("button", "last")];
  assert.deepEqual(tags(tabStops(list)), ["first", "a2", "mid", "b1", "last"]);
  // a radio with no name is a stop on its own, and a lone radio is its group
  assert.deepEqual(tags(tabStops([{ type: "radio", checked: false, tag: "x" }, { type: "radio", name: "g", checked: false, tag: "y" }])), ["x", "y"]);
  assert.deepEqual(tags(tabStops([])), []);
  // fire on bad: the checked one is last in its group, and it is still the stop (the others never become "last")
  assert.deepEqual(tags(tabStops([a1, a3, a2])), ["a2"]);
});

// ---- l. the leave flow, rendered ----
const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c381");
const win = new Window({ url: "http://localhost/a/fleet/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "PopStateEvent"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

const FLOOR = { state: "not_confirmed", text: "Not confirmed: nothing may stop until you approve in Portal.", version: "0.7.0", feedRevision: 1, entries: 0, lastGateAt: null, gateNote: null };
const ROW = (over: Record<string, unknown> = {}) => ({ kind: "agent", id: "agt_A", name: "Henry", lifecycle: "active", effective: "active", runtime: "running", trust: "trusted", owner: { id: "per_1", name: "Marco" }, line: "Working", findings: [], validFrom: null, validUntil: null, at: null, ...over });
const DETAIL = (over: Record<string, unknown> = {}) => ({
  ...ROW({ kind: "person", id: "per_1", name: "Marco", runtime: null, owner: null, line: "Active" }),
  title: "", rev: 7, reason: null, note: null, defaultOwner: null, reach: [], teams: [], agents: [ROW(), ROW({ id: "agt_K", name: "Kiosk" })], actions: [], close: null, plan: null, floor: FLOOR, grantsBefore: null, notices: [], history: [],
  ...over,
});
const BOB = ROW({ kind: "person", id: "per_2", name: "Bob", runtime: null, owner: null, line: "Active" });
type Answer = ((input: any) => { status: number; body: unknown }) | undefined;
const stub = { calls: [] as { op: string; input: any }[], answers: {} as Record<string, Answer>, gate: null as Promise<void> | null, dir: { revision: 1, teams: [] as unknown[], people: [] as unknown[], agents: [] as unknown[] } };
const ok = (output: unknown) => () => ({ status: 200, body: { status: "ok", output } });
const refuse = (status: number, code: string, message: string) => () => ({ status, body: { error: { code, message } } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any };
  stub.calls.push({ op, input: body.input });
  if (op === "members_set" && stub.gate) await stub.gate;
  const answer = stub.answers[op]?.(body.input);
  if (answer) return json(answer.status, answer.body);
  if (op === "overview_get") return json(200, { status: "ok", output: stub.dir });
  return json(404, { error: { code: "unknown_tool", message: op } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const off of mounted.splice(0)) await off();
});
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  let live = true;
  const off = async () => {
    if (live) await act(async () => r.unmount());
    live = false;
    host.remove();
  };
  mounted.push(off);
  await act(async () => r.render(h(TbProvider, { product: "fleet" }, el)));
  await flush();
  return { host, unmount: off };
}
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const button = (scope: ParentNode, text: string) => {
  const found = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const radio = (scope: ParentNode, title: string, at = 0) => {
  const found = [...scope.querySelectorAll('[role="radio"]')].filter((r) => r.textContent?.includes(title))[at];
  assert.ok(found, `radio ${title}`);
  return found as Element;
};
const chooseReason = async (scope: ParentNode, label: string) => {
  await click(scope.querySelector('[role="combobox"]') as Element);
  const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(label));
  assert.ok(opt, `option ${label}`);
  await click(opt as Element);
};
const next = async (scope: Element, label = "Next") => {
  await click(button(scope, label));
  await act(async () => new Promise((r) => setTimeout(r, 450)));
  await flush();
};
const sent = (op: string) => stub.calls.filter((c) => c.op === op).map((c) => c.input);
const reset = () => {
  stub.calls = [];
  stub.answers = {};
  stub.gate = null;
  stub.dir = { revision: 1, teams: [], people: [], agents: [] };
};

describe("l. the leave flow", () => {
  type Flow = typeof import("../src/ui/pages/leave-flow.tsx");
  type Directory = typeof import("../src/ui/pages/directory.tsx");
  let flow: Flow;
  let directory: Directory;
  before(() => {
    const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  });
  before(async () => {
    flow = (await import(pathToFileURL(join(outDir, "ui", "pages", "leave-flow.js")).href)) as Flow;
    directory = (await import(pathToFileURL(join(outDir, "ui", "pages", "directory.js")).href)) as Directory;
  });
  after(() => rmSync(outDir, { recursive: true, force: true }));

  it("Leave starts at Move to a new owner with the default owner chosen and the new-key switch on; Confirm says the effect of the new key; plan_send carries the transfer, the owner and the key", async () => {
    reset();
    stub.answers.lifecycle_set = ok({ colleague: DETAIL(), transition: null });
    stub.answers.colleagues_list = ok({ items: [BOB], nextCursor: null, total: 1 });
    stub.answers.plan_preview = refuse(500, "internal", "x");
    stub.answers.plan_send = ok({ plans: [] });
    const c = DETAIL({ agents: [ROW()], defaultOwner: { id: "per_2", name: "Bob" } }) as never;
    const m = await mount(h(flow.LeaveFlow, { c, onClose: () => {}, onChanged: () => {} }));
    const dlg = m.host.querySelector("dialog") as Element;
    assert.equal(radio(dlg, "Move to a new owner").getAttribute("aria-checked"), "true", "Move is where it starts");
    assert.equal(radio(dlg, "Stop this agent").getAttribute("aria-checked"), "false");
    assert.match([...dlg.querySelectorAll('[role="combobox"]')].map((x) => x.textContent).join("|"), /Bob/, "the default owner is chosen");
    assert.equal((dlg.querySelector('input[role="switch"]') as HTMLInputElement).checked, true, "the new-key switch is on");
    await chooseReason(dlg, "They left");
    assert.equal(button(dlg, "Next").disabled, false, "the default owner is a new owner: nothing more to choose");
    await next(dlg);
    await next(dlg);
    assert.match(dlg.textContent ?? "", /New key: Henry\. It keeps working until you approve in Portal\. Then the old key stops, and it cannot work until you connect it again\./, "the effect is on Confirm");
    await next(dlg, "Mark as leaving");
    assert.deepEqual(sent("plan_send")[0].decisions, [{ agent: "agt_A", decision: "transfer", newOwner: "per_2", newKey: true }]);
    assert.deepEqual(sent("lifecycle_set"), [{ kind: "person", id: "per_1", to: "leaving", reason: "left", expectedRev: 7 }], "the mark has no decisions: only plan_send has them");
    await m.unmount();
  });

  it("Stop this agent sends a stop decision and passes `stopping` to plan_preview; an agent that moves is not in it", async () => {
    reset();
    stub.answers.lifecycle_set = ok({ colleague: DETAIL(), transition: null });
    stub.answers.colleagues_list = ok({ items: [BOB], nextCursor: null, total: 1 });
    stub.answers.plan_preview = refuse(500, "internal", "x");
    stub.answers.plan_send = ok({ plans: [] });
    const c = DETAIL({ defaultOwner: { id: "per_2", name: "Bob" } }) as never;
    const m = await mount(h(flow.LeaveFlow, { c, onClose: () => {}, onChanged: () => {} }));
    const dlg = m.host.querySelector("dialog") as Element;
    await chooseReason(dlg, "They left");
    await click(radio(dlg, "Stop this agent", 1)); // Kiosk, the second agent
    await next(dlg);
    assert.deepEqual(stub.calls.findLast((x) => x.op === "plan_preview")?.input, { kind: "person", id: "per_1", stopping: ["agt_K"] });
    await next(dlg);
    await next(dlg, "Mark as leaving");
    assert.deepEqual(sent("plan_send")[0].decisions, [
      { agent: "agt_A", decision: "transfer", newOwner: "per_2", newKey: true },
      { agent: "agt_K", decision: "stop" },
    ]);
    await m.unmount();
  });

  it("Back to teams is disabled while a members write is on its way, and the page then says what the person gains", async () => {
    reset();
    const marco = { id: "per_1", name: "Marco", kind: "person", status: "active", lifecycle: "active", trust: "trusted", email: null, title: "", tags: [], handles: [], teams: [], updatedAt: "2026-10-31T09:00:00Z", org: "", relationship: "" };
    stub.dir = { revision: 1, teams: [{ id: "tea_1", name: "Support", description: "", tags: [], members: [] }], people: [marco], agents: [] };
    const out = { team: { id: "tea_1", name: "Support", description: "", tags: [], people: 1, agents: 0, updatedAt: "2026-10-31T09:00:00Z", members: [{ kind: "person", id: "per_1", name: "Marco", role: "member" }] }, movers: [{ name: "Marco", gains: "team Support. No agent is in this team.", loses: null }] };
    stub.answers.members_set = () => {
      stub.dir.teams = [{ id: "tea_1", name: "Support", description: "", tags: [], members: out.team.members }];
      return { status: 200, body: { status: "ok", output: out } };
    };
    const m = await mount(h(directory.DirectoryPage, { page: "teams" }));
    await click(button(m.host, "Members of Support"));
    await click(button(m.host, "Add or change many"));
    const option = [...m.host.querySelectorAll('[role="option"]')].find((x) => x.querySelector(".tb-access-pick-name")?.textContent === "Marco");
    assert.ok(option, "option Marco");
    await click(option as Element);
    assert.equal(button(m.host, "Back to teams").disabled, false, "no write: Back works");
    let release = () => {};
    stub.gate = new Promise<void>((r) => {
      release = r;
    });
    await click(button(m.host, "Member"));
    assert.equal(sent("members_set").length, 1, "the write is on its way");
    assert.equal(button(m.host, "Back to teams").disabled, true, "disabled during the write");
    release();
    await flush();
    assert.equal(button(m.host, "Back to teams").disabled, false, "enabled when the write ended");
    assert.match(m.host.textContent ?? "", /Marco gains team Support\. No agent is in this team\./);
    await m.unmount();
  });
});

// ── what the adversarial pass found ─────────────────────────────────────────

/** The ops here run on the real clock (ctxOf) and the runner on the world's: the world's stays later, as time runs on. */
const laterWorld = (): World => {
  const w = makeWorld();
  w.clock.t = Date.now() + 60_000;
  return w;
};

test("a leaver's key does not reach the new owner: apps read no owner until Core replaced the key, and the feed moves when it does; an agent reads the old owner while the person does not know", async () => {
  const w = laterWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, Date.now() - 1000);
  const plan = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w))) as { plans: { id: string }[] };
  const id = plan.plans[0]?.id as string;
  assert.equal(agentRow(w.db, HENRY)?.owner, null, "no app gives the old key the new owner's area");
  assert.equal(agentFacts(w.db, HENRY).owner, null, "nor does the context of a call");
  assert.equal(leanDirectory(w.db).agents.find((a) => a.id === HENRY)?.owner?.id, w.ann.id, "S2-8: no agent learns of the leaver from a move");
  assert.equal(loadColleagues(w.db, w.clock.t).byId.get(`agent:${HENRY}`)?.owner?.id, bob.id, "the owner reads the truth");
  const rev = revision(w.db);
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key));
  await w.tick(id);
  assert.ok(revision(w.db) > rev, "a reader reads the feed again");
  assert.equal(agentRow(w.db, HENRY)?.owner, bob.id, "the old key is gone: the new owner shows");
  assert.equal(agentFacts(w.db, HENRY).owner?.id, bob.id);
});

test("a key the owner kept off: the new owner stays withheld and the finding stays; a person who is not active later withholds a move made while they were active", async () => {
  const w = laterWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id, newKey: false }] }, ctxOf(w));
  assert.equal(agentRow(w.db, HENRY)?.owner, null);
  assert.ok(codes(w, HENRY).includes("key_after_transfer"));
  const v = makeWorld();
  const carol = store.setPerson(v.db, { name: "Carol" }, v.clock.t);
  const later = store.setPerson(v.db, { name: "Dan" }, v.clock.t);
  setAgentMoved(v.db, { agent: SALES, owner: carol.id }, { kind: "owner", id: null }, v.clock.t);
  setAgentMoved(v.db, { agent: SALES, owner: later.id }, { kind: "owner", id: null }, v.clock.t + 1);
  assert.equal(agentRow(v.db, SALES)?.owner, later.id, "Ann and Carol are active");
  set(v.db, "person", carol.id, "leaving", {}, v.clock.t + 2);
  assert.equal(agentRow(v.db, SALES)?.owner, null, "Carol left, and may hold the key");
});

test("a person with their agent's key: the finding names the key and the person with no handle is told nothing can bar them", async () => {
  const w = laterWorld();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const text = loadColleagues(w.db, w.clock.t).byId.get(`agent:${HENRY}`)?.findings.find((f) => f.code === "owner_inactive")?.text ?? "";
  assert.match(text, /may still hold its key/);
  assert.match(text, /keeps working/);
  const none = store.setPerson(w.db, { name: "No handle" }, w.clock.t);
  set(w.db, "person", none.id, "leaving", {}, w.clock.t);
  assert.ok(loadColleagues(w.db, w.clock.t).byId.get(`person:${none.id}`)?.findings.some((f) => f.code === "no_handle_to_bar"));
});

test("a stop made in the owner's plan: undo is refused while the draft stands, and after it is applied; the agent's own Bring back stays", async () => {
  const w = laterWorld();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const plan = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "stop" }] }, ctxOf(w))) as { plans: { id: string }[] };
  const id = plan.plans[0]?.id as string;
  await w.tick(id);
  assert.throws(() => set(w.db, "agent", HENRY, "active", { reason: "mistake" }, w.clock.t), refused("plan_open", 409), "the draft stands in Portal");
  approveAndDeliver(w, String(w.plan(id).draft_key));
  await w.tick(id);
  assert.throws(() => set(w.db, "agent", HENRY, "active", { reason: "mistake" }, w.clock.t), refused("plan_applied", 409));
});

test("lifecycle_set with stop decisions counts each agent in one cap", async () => {
  const w = laterWorld();
  w.db.prepare("INSERT INTO fleet_settings (key, value) VALUES ('stop_cap', '2') ON CONFLICT (key) DO UPDATE SET value = '2'").run();
  await assert.rejects(run("lifecycle_set", { kind: "person", id: w.ann.id, to: "leaving", reason: "left", decisions: [{ agent: HENRY, decision: "stop" }, { agent: SALES, decision: "stop" }] }, ctxOf(w)), (e: TbError) => e.code === "stop_cap_reached");
});

test("after an approved new key the owner reads that the agent must be connected: with the picture until a key shows, without it for a time", async () => {
  const w = laterWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  const plan = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w))) as { plans: { id: string }[] };
  const id = plan.plans[0]?.id as string;
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key));
  await w.tick(id);
  const at = w.clock.t;
  const row = (t: number, topology: unknown) => loadColleagues(w.db, t, topology as never).byId.get(`agent:${HENRY}`);
  assert.match(row(at, null)?.findings.find((f) => f.code === "connect_again")?.text ?? "", /cannot see this/);
  assert.equal(row(at + 15 * 86_400_000, null)?.findings.some((f) => f.code === "connect_again"), false, "with no picture it does not stay for ever");
  const pic = (connections: unknown[]) => ({ truncated: false, edges: [], instances: [], connections });
  assert.equal(row(at, pic([]))?.findings.find((f) => f.code === "connect_again")?.text, NEEDS_CONNECT);
  assert.equal(row(at, pic([]))?.line, "No key: connect it in Portal");
  assert.equal(row(at, pic([{ agt: HENRY, status: "active", con: "con_1" }]))?.findings.some((f) => f.code === "connect_again"), false, "a key is there again");
});

test("who is refused: an agent listed as refused or paused is not under keeps working", async () => {
  const w = laterWorld();
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  set(w.db, "agent", HENRY, "suspended", {}, w.clock.t);
  const out = (await run("refusals_get", {}, ctxOf(w))) as { keepWorking: { id: string }[]; alsoRefused: { id: string }[] };
  assert.ok(out.alsoRefused.some((a) => a.id === HENRY));
  assert.ok(!out.keepWorking.some((a) => a.id === HENRY));
  assert.ok(out.keepWorking.some((a) => a.id === SALES));
});

test("a move of an agent on its way out is refused: a new plan would drop its removal", async () => {
  const w = laterWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "agent", HENRY, "leaving", {}, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  await assert.rejects(run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w)), (e: TbError) => e.code === "agent_closed");
});

// ── round 2 ─────────────────────────────────────────────────────────────────

test("a delete is an owner change: the key shows, and a later owner stays withheld", () => {
  const w = laterWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  store.deletePerson(w.db, w.ann.id, w.clock.t);
  assert.ok(codes(w, HENRY).includes("key_after_transfer"));
  setAgentMoved(w.db, { agent: HENRY, owner: bob.id }, { kind: "owner", id: null }, w.clock.t + 1);
  assert.equal(agentRow(w.db, HENRY)?.owner, null, "the person who was deleted may hold the key");
  assert.ok(codes(w, HENRY).includes("key_after_transfer"));
});

test("an agent reads no flip back: a move before the mark stays as it was; only the latest move since the mark shows the old owner", () => {
  const w = laterWorld();
  const t = w.clock.t;
  const bob = store.setPerson(w.db, { name: "Bob" }, t);
  const carol = store.setPerson(w.db, { name: "Carol" }, t);
  const shown = () => leanDirectory(w.db).agents.find((a) => a.id === HENRY)?.owner?.id;
  setAgentMoved(w.db, { agent: HENRY, owner: bob.id }, { kind: "owner", id: null }, t);
  set(w.db, "person", w.ann.id, "suspended", {}, t + 10);
  assert.equal(shown(), bob.id, "Ann moved it away before her mark: nothing flips");
  setAgentMoved(w.db, { agent: SALES, owner: bob.id }, { kind: "owner", id: null }, t + 20);
  assert.equal(leanDirectory(w.db).agents.find((a) => a.id === SALES)?.owner?.id, w.ann.id, "since her mark: the old owner");
  setAgentMoved(w.db, { agent: SALES, owner: carol.id }, { kind: "owner", id: null }, t + 30);
  assert.equal(leanDirectory(w.db).agents.find((a) => a.id === SALES)?.owner?.id, carol.id, "the latest move is from Bob, who is active");
});

test("a key the owner cancelled does not come back through an older replaced plan", async () => {
  const w = laterWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: HENRY, decision: "transfer", newOwner: bob.id }] }, ctxOf(w));
  const second = (await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: SALES, decision: "stop" }] }, ctxOf(w))) as { plans: { id: string }[] };
  const id = second.plans[0]?.id as string;
  assert.ok(w.steps(id).some((s) => s.op === "agents.rotate" && s.agent_id === HENRY), "a replaced plan carries its key");
  await run("plan_cancel", { plan: id }, ctxOf(w));
  const third = (await run("plan_send", { kind: "person", id: w.ann.id }, ctxOf(w))) as { plans: { id: string }[] };
  assert.ok(!w.steps(third.plans[0]?.id as string).some((s) => s.op === "agents.rotate"), "the owner cancelled it");
});

test("a new key on an agent is no applied stop; an owner change waits for a plan that holds the agent's stop", async () => {
  const w = laterWorld();
  const bob = store.setPerson(w.db, { name: "Bob" }, w.clock.t);
  const made = (await run("plan_send", { kind: "agent", id: HENRY, transfers: [HENRY] }, ctxOf(w))) as { plans: { id: string }[] };
  const id = made.plans[0]?.id as string;
  await w.tick(id);
  approveAndDeliver(w, String(w.plan(id).draft_key));
  await w.tick(id);
  set(w.db, "agent", HENRY, "leaving", {}, w.clock.t + 1);
  set(w.db, "agent", HENRY, "active", { reason: "mistake" }, w.clock.t + 2);
  assert.equal(stateOf(w.db, "agent", HENRY), "active", "a mistaken stop can be undone");
  set(w.db, "person", w.ann.id, "leaving", {}, w.clock.t);
  await run("plan_send", { kind: "person", id: w.ann.id, decisions: [{ agent: SALES, decision: "stop" }] }, ctxOf(w));
  assert.throws(() => setAgentMoved(w.db, { agent: SALES, owner: bob.id }, { kind: "owner", id: null }, w.clock.t), refused("plan_open", 409));
});
