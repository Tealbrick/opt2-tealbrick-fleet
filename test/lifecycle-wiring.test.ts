// C380 B9a: what the lifecycle reaches: the feed (lifecycle, floor), the cascades, the date timer, the mover, the words about Rules, the Portal link plan.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgainstSchema, validateCompanions } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { manifest } from "../src/app.ts";
import { type DirectoryFeed, directoryFeed } from "../src/feed.ts";
import { FLOOR_TEXT, floorView, readFloorStatus } from "../src/lifecycle/floor.ts";
import { setAgentMoved, setMembersMoved } from "../src/lifecycle/moved.ts";
import { effectiveAgent, floorOf } from "../src/lifecycle/states.ts";
import { CAP_WINDOW_MS, setDates, setKeepRunning } from "../src/lifecycle/transitions.ts";
import { tickDates } from "../src/lifecycle/validity.ts";
import { NOT_APPLIED, portalPlan } from "../src/plans/portal-link.ts";
import * as store from "../src/store.ts";
import type { DecodedTopology } from "../src/topology-slice.ts";
import { AGENT_A, AGENT_B } from "./helpers.ts";
import { OWNER, refused, set, stateOf, T0, WAIVE, world } from "./lifecycle-helpers.ts";

const feedOf = (db: Db) => directoryFeed(db, { accept: ["lifecycle"] }) as Extract<DirectoryFeed, { unchanged: false }>;
const contract = (name: string) => JSON.parse(readFileSync(new URL(`./contracts/${name}`, import.meta.url), "utf8"));
const LIFECYCLE_SCHEMA = contract("fleet.directory_feed.1.lifecycle.schema.json");
const LIFECYCLE_FIXTURE = contract("fleet.directory_feed.1.lifecycle.json") as { valid: Json[]; invalid: { why: string; doc: Json }[] };

test("A24b: a 0.3.2 database can read the old feed shape after the migration, byte for byte in the old fields", () => {
  const { db } = world();
  const plain = directoryFeed(db, {}) as Extract<DirectoryFeed, { unchanged: false }>;
  assert.ok(plain.agents.every((a) => !("floor" in a) && !("lifecycle" in a)));
  assert.ok(plain.contacts.every((a) => !("floor" in a) && !("lifecycle" in a)));
  assert.deepEqual(directoryFeed(db, { accept: ["future"] }), plain, "an unknown accept value changes nothing");
});

test("A32: a person's stop reaches the agents at once; keep-running lifts one; the state lifts with the person; the Core pause stays", () => {
  const { db, ann } = world();
  store.setAgent(db, { agent: AGENT_B.id, owner: ann.id }, T0);
  set(db, "agent", AGENT_B.id, "active");
  const row = (id: string) => feedOf(db).agents.find((a) => a.id === id);
  assert.deepEqual([row(AGENT_A.id)?.lifecycle, row(AGENT_A.id)?.floor], ["active", false]);
  set(db, "person", ann.id, "leaving");
  const contact = () => feedOf(db).contacts.find((c) => c.id === ann.id);
  assert.deepEqual([contact()?.lifecycle, contact()?.floor, contact()?.status], ["leaving", true, "departed"]);
  assert.deepEqual([row(AGENT_A.id)?.lifecycle, row(AGENT_A.id)?.floor], ["suspended", true], "effective suspended, own row unchanged");
  assert.equal(stateOf(db, "agent", AGENT_A.id), "active");
  setKeepRunning(db, AGENT_B.id, "Runs payroll until Friday", OWNER, T0);
  assert.deepEqual([row(AGENT_B.id)?.lifecycle, row(AGENT_B.id)?.floor], ["active", false], "the ticked one runs");
  // person T3 cascades the same way
  set(db, "person", ann.id, "active", { reason: "mistake" });
  assert.deepEqual([row(AGENT_A.id)?.floor, row(AGENT_B.id)?.floor], [false, false], "lifts by itself");
  assert.equal(Number(db.prepare("SELECT keep_running AS k FROM fleet_agents WHERE id = ?").get(AGENT_B.id)?.k), 0, "the tick ends with the stop it answered");
  set(db, "person", ann.id, "suspended");
  assert.deepEqual([row(AGENT_A.id)?.lifecycle, row(AGENT_B.id)?.lifecycle], ["suspended", "suspended"]);
  assert.equal(store.getPerson(db, ann.id).status, "active", "suspended is still an active directory entry");
  set(db, "person", ann.id, "active", { reason: "mistake" });
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  assert.equal(row(AGENT_A.id)?.status, "paused", "the Core pause is Core's: Governance does not lift it");
  assert.equal(row(AGENT_A.id)?.floor, false);
});

test("the floor: blocked refuses, a closed row with no card does not, and a person's handle stays the person's (S3-15)", () => {
  assert.equal(floorOf("active", "blocked"), true);
  assert.equal(floorOf("archived", "trusted", true), false);
  assert.equal(floorOf("archived", "blocked", true), true);
  assert.equal(floorOf("proposed", "unreviewed"), false);
  assert.equal(floorOf(null, "trusted"), false);
  assert.equal(effectiveAgent({ lifecycle: "proposed", validFrom: T0 + 1, keepRunning: false }, "active"), "not_started");
  assert.equal(effectiveAgent({ lifecycle: "active", validFrom: null, keepRunning: false }, null), "active", "an outside owner or no owner: no cascade");
  const { db, ann } = world();
  store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00001"] }, T0);
  db.prepare("INSERT INTO fleet_agent_handles (agent_id, handle) VALUES (?, 'slack:UANN00001'), (?, 'slack:UAGENT001')").run(AGENT_A.id, AGENT_A.id);
  const feed = directoryFeed(db, { accept: ["agent_handles"] }) as Extract<DirectoryFeed, { unchanged: false }>;
  assert.deepEqual(feed.agents.find((a) => a.id === AGENT_A.id)?.handles, ["slack:UAGENT001"]);
});

test("dates: an end date passes on two ticks only, stops once by the system, a restart needs two new ticks, and the cap holds", () => {
  const { db, ann } = world();
  const until = T0 + 1000;
  // fire on bad: a past date typed without a confirm; bad order
  assert.throws(() => setDates(db, { kind: "person", id: ann.id, validUntil: new Date(T0 - 1).toISOString(), actor: OWNER }, T0), refused("date_in_past", 409));
  assert.throws(() => setDates(db, { kind: "person", id: ann.id, validFrom: new Date(T0 + 9).toISOString(), validUntil: new Date(T0 + 1).toISOString(), actor: OWNER }, T0), refused("input_invalid", 400));
  assert.throws(() => setDates(db, { kind: "person", id: ann.id, validUntil: "soon", actor: OWNER }, T0), refused("input_invalid", 400));
  setDates(db, { kind: "person", id: ann.id, validUntil: new Date(until).toISOString(), actor: OWNER }, T0);
  let seen = new Set<string>();
  assert.deepEqual(tickDates(db, seen, until - 1), { stopped: 0, started: 0, waiting: 0 });
  assert.equal(tickDates(db, seen, until + 1).stopped, 0, "the first tick past the date does not act");
  // restart: the memory is gone, so two new ticks must agree
  seen = new Set();
  assert.equal(tickDates(db, seen, until + 60_000).stopped, 0);
  assert.equal(tickDates(db, seen, until + 120_000).stopped, 1);
  assert.equal(stateOf(db, "person", ann.id), "suspended");
  assert.equal(tickDates(db, seen, until + 180_000).stopped, 0, "once");
  const ev = db.prepare("SELECT actor_kind, reason FROM fleet_lifecycle_events WHERE subject_id = ? AND to_state = 'suspended'").get(ann.id);
  assert.deepEqual({ ...ev }, { actor_kind: "system", reason: "contract_ended" });
  assert.equal(feedOf(db).agents.find((a) => a.id === AGENT_A.id)?.floor, true, "the person's agents follow");
  // a changed date resets the agreement
  const p = store.setPerson(db, { name: "Pat" }, T0);
  setDates(db, { kind: "person", id: p.id, validUntil: new Date(until).toISOString(), actor: OWNER }, T0);
  const s2 = new Set<string>();
  tickDates(db, s2, until + 1);
  setDates(db, { kind: "person", id: p.id, validUntil: new Date(until + 5).toISOString(), actor: OWNER }, T0);
  assert.equal(tickDates(db, s2, until + 10).stopped, 0);
  // the timer obeys the cap: a script cannot stop everyone by typing dates; what waits shows as a finding
  const q = world();
  const many = Array.from({ length: 8 }, (_, i) => store.setPerson(q.db, { name: `D${i}` }, T0).id);
  for (const id of many) setDates(q.db, { kind: "person", id, validUntil: new Date(until).toISOString(), actor: OWNER }, T0);
  const s3 = new Set<string>();
  tickDates(q.db, s3, until + 1);
  const r = tickDates(q.db, s3, until + 2);
  assert.deepEqual([r.stopped, r.waiting], [5, 3]);
  const later = tickDates(q.db, s3, until + 2 + CAP_WINDOW_MS + 1);
  assert.deepEqual([later.stopped, later.waiting], [3, 0], "the rest stop when the window ends");
});

test("mover: members_set and an owner change write a moved event and open one system review; an unchanged save writes nothing", () => {
  const { db, ann } = world();
  const bob = store.setPerson(db, { name: "Bob" }, T0);
  const team = store.setTeam(db, { name: "Support" }, T0);
  const moved = (id: string) => db.prepare("SELECT note, snapshot_json FROM fleet_lifecycle_events WHERE subject_id = ? AND kind = 'moved' ORDER BY seq").all(id);
  const openReviews = (id: string) => Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE subject_id = ? AND status = 'requested' AND requested_by_kind = 'system'").get(id)?.n);
  setMembersMoved(db, { team: team.id, people: [{ id: bob.id, role: "member" }], agents: [] }, OWNER, T0);
  assert.equal(moved(bob.id).length, 1);
  assert.match(String(moved(bob.id)[0]?.note), /Joined team Support/);
  assert.equal(openReviews(bob.id), 1);
  setMembersMoved(db, { team: team.id, people: [{ id: bob.id, role: "member" }], agents: [] }, OWNER, T0);
  assert.equal(moved(bob.id).length, 1, "no change, no event");
  setMembersMoved(db, { team: team.id, people: [{ id: bob.id, role: "lead" }], agents: [] }, OWNER, T0);
  assert.equal(moved(bob.id).length, 2);
  assert.equal(openReviews(bob.id), 1, "one open per subject");
  setAgentMoved(db, { agent: AGENT_A.id, role: "new role" }, OWNER, T0);
  assert.equal(moved(AGENT_A.id).length, 0, "a role edit is no move");
  setKeepRunning(db, AGENT_A.id, "x", OWNER, T0);
  setAgentMoved(db, { agent: AGENT_A.id, owner: bob.id }, OWNER, T0);
  assert.match(String(moved(AGENT_A.id)[0]?.note), /from Ann to Bob/);
  assert.deepEqual(JSON.parse(String(moved(AGENT_A.id)[0]?.snapshot_json)), { after: bob.id, before: ann.id });
  assert.equal(Number(db.prepare("SELECT keep_running AS k FROM fleet_agents WHERE id = ?").get(AGENT_A.id)?.k), 0, "the tick was about the old owner's key");
  // fire on bad: taking the owner away cannot lift a stop that comes from the owner
  const c = world();
  set(c.db, "person", c.ann.id, "leaving");
  assert.throws(() => setAgentMoved(c.db, { agent: AGENT_A.id, owner: null }, OWNER, T0), refused("owner_stopped", 409));
  assert.equal(feedOf(c.db).agents.find((a) => a.id === AGENT_A.id)?.floor, true);
  // quiet on good: an unowned agent stays unowned, and a working owner can be taken away
  setAgentMoved(db, { agent: AGENT_B.id, owner: null }, OWNER, T0);
  setAgentMoved(db, { agent: AGENT_A.id, owner: null }, OWNER, T0);
  setAgentMoved(db, { agent: AGENT_A.id, owner: bob.id }, OWNER, T0);
  // fire on bad: a new owner must be active
  set(db, "person", bob.id, "leaving");
  assert.throws(() => setAgentMoved(db, { agent: AGENT_B.id, owner: bob.id }, OWNER, T0), refused("owner_inactive", 409));
});

test("A1b: the plan lists Portal actions and proves them from the slice; it never says done for what it cannot see", () => {
  const a = { id: AGENT_A.id, name: "A", lifecycle: "leaving", effective: "leaving", runtime: "running", wasStopped: false } as const;
  const none = portalPlan([a], null, null);
  assert.equal(none.headline, NOT_APPLIED);
  assert.equal(none.applied, false);
  assert.deepEqual(none.steps.map((s) => [s.action, s.state]), [["pause", "open"], ["remove_access", "not_provable"]]);
  const base = { instances: [], companions: [], edges: [], connections: [] } as unknown as DecodedTopology;
  const withAccess = { ...base, edges: [{ agent: AGENT_A.id, ins: "i", product: "k", crud: ["read"], mode: "free", held: [] }], connections: [{ con: "c", agt: AGENT_A.id, method: "key", status: "active" }] } as DecodedTopology;
  assert.deepEqual(portalPlan([a], withAccess, null).steps.map((s) => s.state), ["open", "open"]);
  assert.deepEqual(portalPlan([{ ...a, runtime: "paused" }], base, null).steps.map((s) => s.state), ["done", "done"]);
  assert.equal(portalPlan([{ ...a, runtime: "paused" }], base, null).openSteps, 0);
  assert.deepEqual(portalPlan([{ ...a, runtime: "paused" }], { ...base, truncated: true }, null).steps.map((s) => s.state), ["done", "not_provable"], "a cut list proves nothing");
  assert.deepEqual(portalPlan([{ ...a, lifecycle: "active", effective: "suspended", runtime: "running" }], null, null).steps.map((s) => s.action), ["pause"], "a person's stop: pause only until a decision");
  assert.deepEqual(portalPlan([{ ...a, lifecycle: "active", effective: "active", runtime: "paused" }], null, null).steps.map((s) => s.action), ["resume"]);
  assert.deepEqual(portalPlan([{ ...a, runtime: "gone" }], null, null).steps.map((s) => [s.action, s.state]), [["remove_access", "done"]]);
  assert.ok(none.notChanged.some((t) => /Portal login/.test(t)));
  // a plan over the output limit is cut, and says so; the count stays true
  const many = portalPlan(Array.from({ length: 300 }, (_, i) => ({ ...a, id: `agt_${i}` })), null, null);
  assert.equal(many.steps.length, 400);
  assert.equal(many.openSteps, 300);
  assert.match(String(many.note), /200 more steps/);
});

test("A23: each case has its own words from what Fleet can read; the hook switch is never claimed", async () => {
  const st = { version: "0.7.0-dev.1", feedRevision: 10, entries: 2, lastGateAt: new Date(T0 - 60_000).toISOString() };
  assert.equal(floorView(st, 10, T0, true).text, FLOOR_TEXT.confirmed);
  assert.equal(floorView(st, 11, T0, true).state, "not_confirmed", "behind on the revision");
  assert.equal(floorView(st, 11, T0, true).text, "Not confirmed: nothing may stop until you approve in Portal.");
  assert.equal(floorView("not_installed", 1, T0, true).state, "not_installed");
  assert.equal(floorView("older", 1, T0, true).state, "older");
  assert.equal(floorView(st, 10, T0, true).gateNote, null);
  const old = { ...st, lastGateAt: new Date(T0 - 3_600_000).toISOString() };
  assert.match(String(floorView(old, 10, T0, true).gateNote), /has not checked a call since/);
  assert.equal(floorView(old, 10, T0, false).gateNote, null, "no agent runs: nothing to say");
  assert.equal(floorView({ ...st, lastGateAt: null }, 10, T0, true).gateNote, "Rules has not checked a call yet.");
  assert.equal(floorView({ ...st, lastGateAt: null }, 10, T0, false).gateNote, null);
  for (const t of Object.values(FLOOR_TEXT)) assert.doesNotMatch(t, /hook|switch/i);
  const reads = (callApp: unknown, targets = ["rules"]) => readFloorStatus({ companionTargets: () => targets, callApp } as never);
  assert.equal(await reads(async () => ({ status: "ok", output: st }), []), "not_installed");
  assert.deepEqual(await reads(async () => ({ status: "ok", output: st })), st);
  assert.equal(await reads(async () => ({ status: "ok", output: { bad: 1 } })), "not_read");
  assert.equal(await reads(async () => ({ status: "held" })), "not_read");
  assert.equal(await reads(async () => { throw new TbError("unknown_tool", "x", 404); }), "older");
  assert.equal(await reads(async () => { throw new TbError("hook_denied", "x", 403); }), "not_read");
  assert.equal(await reads(async () => { throw new Error("network"); }), "not_read");
});

test("feed contract: the copies are byte copies of spec-v0.1.89", () => {
  const sha = (name: string) => createHash("sha256").update(readFileSync(new URL(`./contracts/${name}`, import.meta.url))).digest("hex");
  const provenance = readFileSync(new URL("./contracts/PROVENANCE.md", import.meta.url), "utf8");
  for (const f of ["fleet.directory_feed.1.lifecycle.schema.json", "fleet.directory_feed.1.lifecycle.json"]) assert.ok(provenance.includes(sha(f)), f);
});

test("feed contract: the fixtures pass the schema, the answers pass the schema and the manifest output (the SDK checks that one)", () => {
  for (const doc of LIFECYCLE_FIXTURE.valid) assert.equal(validateAgainstSchema(LIFECYCLE_SCHEMA, doc).ok, true);
  for (const bad of LIFECYCLE_FIXTURE.invalid) assert.equal(validateAgainstSchema(LIFECYCLE_SCHEMA, bad.doc).ok, false, bad.why);
  const { db, ann } = world();
  store.setPerson(db, { name: "Out", kind: "outside_agent", handles: ["slack:W0BOT1234"] }, T0);
  store.setPerson(db, { name: "Pat" }, T0);
  set(db, "person", ann.id, "leaving");
  set(db, "agent", AGENT_B.id, "suspended");
  const answer = feedOf(db);
  assert.deepEqual(validateAgainstSchema(LIFECYCLE_SCHEMA, answer as unknown as Json).ok ? [] : "bad", []);
  assert.deepEqual(validateAgainstSchema(manifest.operations.find((o) => o.id === "directory_feed")?.output as never, answer as unknown as Json).ok ? [] : "bad", []);
  assert.equal(answer.contacts.find((c) => c.kind === "outside_agent")?.lifecycle, undefined, "absent on outside agents");
  assert.equal(answer.contacts.find((c) => c.kind === "outside_agent")?.floor, false);
  assert.equal(answer.agents.find((a) => a.id === AGENT_B.id)?.floor, true);
  // fire on bad: a value the contract does not know
  assert.equal(validateAgainstSchema(LIFECYCLE_SCHEMA, { ...answer, agents: [{ ...answer.agents[0], lifecycle: "gone" }] } as unknown as Json).ok, false);
});

test("feed: a stopped agent stays listed after its card is gone, so a reader keeps its floor entry; a no_card row and an unstopped removed agent stay out", () => {
  const { db } = world();
  set(db, "agent", AGENT_A.id, "leaving");
  store.syncAgents(db, [AGENT_B], T0); // the card of A is removed in Portal
  const listed = () => feedOf(db).agents.find((a) => a.id === AGENT_A.id);
  assert.deepEqual([listed()?.status, listed()?.lifecycle, listed()?.floor], ["removed", "leaving", true]);
  set(db, "agent", AGENT_A.id, "archived", { waive: WAIVE });
  assert.deepEqual([listed()?.lifecycle, listed()?.floor], ["archived", true], "archived stays with floor true");
  const plain = directoryFeed(db, {}) as Extract<DirectoryFeed, { unchanged: false }>;
  assert.equal(plain.agents.find((a) => a.id === AGENT_A.id), undefined, "the old reader sees the old rule");
  // an active agent whose card is gone: no floor, no row
  const b = world();
  store.syncAgents(b.db, [AGENT_B], T0);
  assert.equal(feedOf(b.db).agents.find((a) => a.id === AGENT_A.id), undefined);
  // a blocked agent whose card is gone stays listed
  b.db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(AGENT_A.id);
  assert.equal(feedOf(b.db).agents.find((a) => a.id === AGENT_A.id)?.floor, true);
});

test("Close is never automatic: 40 days of ticks close nothing", () => {
  const { db, ann } = world();
  set(db, "person", ann.id, "leaving");
  const seen = new Set<string>();
  for (let d = 0; d < 40; d++) tickDates(db, seen, T0 + d * 86_400_000);
  assert.equal(stateOf(db, "person", ann.id), "leaving");
});

test("a date tick: a subject that fails stays for the next tick and does not stop the others; time alone never lifts a floor at one revision", () => {
  const { db, ann } = world();
  const pat = store.setPerson(db, { name: "Pat" }, T0);
  const until = T0 + 1000;
  for (const id of [ann.id, pat.id]) setDates(db, { kind: "person", id, validUntil: new Date(until).toISOString(), actor: OWNER }, T0);
  // the first subject's row is made to fail: its owner row is not loadable through the guard
  db.exec("CREATE TRIGGER fail_one BEFORE UPDATE OF lifecycle ON fleet_people WHEN OLD.name = 'Ann' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const seen = new Set<string>();
  const errors: unknown[] = [];
  tickDates(db, seen, until + 1, (e) => errors.push(e));
  const r = tickDates(db, seen, until + 2, (e) => errors.push(e));
  assert.equal(r.stopped, 1, "Pat stops");
  assert.equal(errors.length, 1);
  assert.equal(stateOf(db, "person", pat.id), "suspended");
  db.exec("DROP TRIGGER fail_one");
  assert.equal(tickDates(db, seen, until + 3).stopped, 1, "Ann stops on the next tick");
  // a stored start date reads not_started until the timer ends it, whatever the clock says
  const late = world();
  setDates(late.db, { kind: "agent", id: AGENT_A.id, validFrom: new Date(T0 + 5).toISOString(), actor: OWNER }, T0);
  const rev = store.revision(late.db);
  assert.equal(feedOf(late.db).agents.find((a) => a.id === AGENT_A.id)?.floor, true);
  assert.equal(store.revision(late.db), rev);
  // a start date that has passed needs no wait
  setDates(late.db, { kind: "agent", id: AGENT_B.id, validFrom: new Date(T0 - 5).toISOString(), actor: OWNER }, T0);
  assert.equal(feedOf(late.db).agents.find((a) => a.id === AGENT_B.id)?.floor, false);
});

test("rules.floor_status: the deployed shape (byte copy of Rules 0.7.0-dev.1) reads right; the companion passes M-CP-2 against it; an older Rules fails it", async () => {
  const rules = contract("rules.0.7.0-dev.1.manifest.json");
  const sha = createHash("sha256").update(readFileSync(new URL("./contracts/rules.0.7.0-dev.1.manifest.json", import.meta.url))).digest("hex");
  assert.ok(readFileSync(new URL("./contracts/PROVENANCE.md", import.meta.url), "utf8").includes(sha));
  const op = rules.operations.find((o: { id: string }) => o.id === "floor_status");
  assert.equal(op.listing, "workflow");
  const reads = (output: unknown) => readFloorStatus({ companionTargets: () => ["rules"], callApp: async () => ({ status: "ok", output }) } as never);
  for (const output of [{ version: "0.7.0-dev.1", feedRevision: null, entries: 0, lastGateAt: null }, { version: "0.7.0-dev.1", feedRevision: 12, entries: 3, lastGateAt: "2026-10-30T17:00:00.000Z" }]) {
    assert.equal(validateAgainstSchema(op.output, output as Json).ok, true);
    assert.deepEqual(await reads(output), output);
  }
  const never = floorView({ version: "0.7.0-dev.1", feedRevision: null, entries: 0, lastGateAt: null }, 1, T0, true);
  assert.equal(never.state, "not_confirmed", "Rules has not read the feed yet: nothing is confirmed");
  assert.equal(floorView({ version: "0.7.0-dev.1", feedRevision: null, entries: 0, lastGateAt: null }, 0, T0, true).state, "not_confirmed");
  type RulesOp = { id: string; audience: string; crud: string[] };
  const target = (ops: RulesOp[]) => [{ id: "rules", operations: ops.map((o) => ({ id: o.id, audience: o.audience, crud: o.crud })) }];
  assert.equal(validateCompanions(manifest as never, target(rules.operations) as never).ok, true);
  assert.equal(validateCompanions(manifest as never, target(rules.operations.filter((o: RulesOp) => o.id !== "floor_status")) as never).ok, false, "a Rules before 0.7.0 fails it: the changelog says so");
});
