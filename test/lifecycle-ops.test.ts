// C380 B9a: the owner's ops. Agents may only propose, never apply, never on themselves (A16).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema, validateManifest } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { type DirectoryFeed, directoryFeed } from "../src/feed.ts";
import { leanDirectory, leanResolveSender } from "../src/lean.ts";
import { assignDefaultOwner, setSettings } from "../src/lifecycle/settings.ts";
import { DAY_MS, setDates, setKeepRunning } from "../src/lifecycle/transitions.ts";
import { tickDates } from "../src/lifecycle/validity.ts";
import { colleaguesList, loadColleagues } from "../src/lifecycle/view.ts";
import { NOT_APPLIED } from "../src/plans/portal-link.ts";
import * as store from "../src/store.ts";
import { bigDirectory } from "./big.ts";
import { AGENT_A, AGENT_B, migratedDb, migrationFiles } from "./helpers.ts";
import { OWNER, refused, SYSTEM, set, stateOf, T0, WAIVE, world } from "./lifecycle-helpers.ts";
import { seedOldSchema } from "./seed.ts";

const feedOf = (db: Db) => directoryFeed(db, { accept: ["lifecycle"] }) as Extract<DirectoryFeed, { unchanged: false }>;
const AGENT_CALLER = { type: "agent", id: AGENT_A.id, name: AGENT_A.name, mode: "free" };
const APP_CALLER = { type: "app", id: "ins_x", product: "rules", listed: true };
const PERSON_CALLER = { type: "person", id: "per_owner", name: "owner", mode: null };
type Run = { run(i: unknown, c: OpContext): Promise<unknown> };
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const ctxOf = (db: Db, caller: object, extra: object = {}) => ({ db, caller, log: LOG, callApp: async () => ({ status: "ok", output: {} }), companionTargets: () => [], topology: () => null, ownerLink: () => null, ...extra }) as unknown as OpContext;
const run = (id: string, input: unknown, c: OpContext) => (handlers as unknown as Record<string, Run>)[id]?.run(input, c) as Promise<Record<string, any>>;
const NEW_OPS = ["summary_get", "colleagues_list", "colleague_get", "lifecycle_set", "settings_set"];
const specOf = (id: string) => manifest.operations.find((o) => o.id === id) as unknown as { audience: string; effect: string; listing?: string; output: Parameters<typeof validateAgainstSchema>[0]; input: Parameters<typeof validateAgainstSchema>[0] };
const validOut = (id: string, out: unknown) => {
  const v = validateAgainstSchema(specOf(id).output, out as Json);
  assert.deepEqual(v.ok ? [] : v.errors, [], `${id} output`);
};

test("A16: the new ops are person ops, last in the manifest; the agent surface is exactly what it was; review_request is the one write and it only asks", () => {
  assert.equal(validateManifest(manifest).ok, true);
  assert.deepEqual(manifest.operations.slice(-NEW_OPS.length).map((o) => o.id), NEW_OPS, "appended last");
  for (const id of NEW_OPS) assert.equal(specOf(id).audience, "person", id);
  const agentOps = manifest.operations.filter((o) => (o as { audience?: string }).audience !== "person").map((o) => o.id);
  assert.deepEqual(agentOps, ["teams_list", "team_get", "directory_get", "resolve_sender", "review_request", "directory_feed"]);
  assert.deepEqual(manifest.operations.filter((o) => (o as { audience?: string }).audience !== "person" && (o as { effect?: string }).effect !== "read").map((o) => o.id), ["review_request"]);
});

test("A16: an agent or an app calling a lifecycle op is refused by the handler too, and nothing changes", async () => {
  const { db, ann } = world();
  const rev = store.revision(db);
  const inputs: Record<string, unknown> = { summary_get: {}, colleagues_list: {}, colleague_get: { kind: "agent", id: AGENT_A.id }, lifecycle_set: { kind: "agent", id: AGENT_A.id, to: "suspended", reason: "other" }, settings_set: { coolingDays: 1 } };
  for (const caller of [AGENT_CALLER, APP_CALLER, { ...AGENT_CALLER, mode: "bound", wf: NEW_OPS }]) {
    for (const id of NEW_OPS) await assert.rejects(run(id, inputs[id], ctxOf(db, caller)), refused("no_access", 403), `${id} as ${caller.type}`);
  }
  // on itself: same refusal, and the state did not move
  await assert.rejects(run("lifecycle_set", { kind: "person", id: ann.id, to: "leaving", reason: "left" }, ctxOf(db, AGENT_CALLER)), refused("no_access", 403));
  assert.equal(stateOf(db, "agent", AGENT_A.id), "active");
  assert.equal(store.revision(db), rev);
  // quiet on good: the owner
  const out = await run("lifecycle_set", { kind: "agent", id: AGENT_A.id, to: "suspended", reason: "security" }, ctxOf(db, PERSON_CALLER));
  assert.equal(stateOf(db, "agent", AGENT_A.id), "suspended");
  validOut("lifecycle_set", out);
});

test("A12: T6b after apply keeps the id, the snapshot shows what to grant again", async () => {
  const { db } = world();
  const topology = { v: 1, agentIds: [AGENT_A.id], instances: [["ins_k", "knowledge", "Knowledge", "1"]], edges: [[0, 0, "cr", "f", 0, 0, 0]], companions: [], connections: [] };
  const c = ctxOf(db, PERSON_CALLER, { topology: () => topology });
  await run("lifecycle_set", { kind: "agent", id: AGENT_A.id, to: "leaving", reason: "left" }, c);
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  const back = await run("lifecycle_set", { kind: "agent", id: AGENT_A.id, to: "proposed", reason: "mistake" }, c);
  validOut("lifecycle_set", back);
  assert.equal(back.colleague.id, AGENT_A.id);
  assert.deepEqual(back.colleague.grantsBefore, [{ agent: AGENT_A.id, product: "knowledge", crud: ["create", "read"] }]);
  assert.deepEqual(back.colleague.plan.steps.map((s: { action: string }) => s.action), ["reinstate"]);
  assert.ok(back.colleague.findings.some((f: { code: string }) => f.code === "paused_outside"), "a finding until Core agrees");
});

test("A11 (skeleton part): T6 undoes a leaving; a Portal pause stays and shows as paused_outside, never silent", () => {
  const { db, ann } = world();
  set(db, "person", ann.id, "leaving");
  assert.equal(store.getPerson(db, ann.id).status, "departed");
  set(db, "person", ann.id, "active", { reason: "mistake" });
  assert.equal(store.getPerson(db, ann.id).status, "active");
  set(db, "agent", AGENT_A.id, "leaving");
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  set(db, "agent", AGENT_A.id, "active", { reason: "mistake" });
  assert.ok(loadColleagues(db, T0).byId.get(`agent:${AGENT_A.id}`)?.findings.some((f) => f.code === "paused_outside"));
});

test("A33: a new agent runs with a finding; a future start date is refused until the date, and the feed revision moves when it passes", () => {
  const { db, ann } = world();
  assert.deepEqual([feedOf(db).agents.find((a) => a.id === AGENT_B.id)?.lifecycle, feedOf(db).agents.find((a) => a.id === AGENT_B.id)?.floor], ["proposed", false], "D6: runs");
  assert.ok(loadColleagues(db, T0).byId.get(`agent:${AGENT_B.id}`)?.findings.some((f) => f.code === "running_unapproved"));
  const start = T0 + DAY_MS;
  setDates(db, { kind: "agent", id: AGENT_A.id, validFrom: new Date(start).toISOString(), actor: OWNER }, T0);
  assert.deepEqual([feedOf(db).agents.find((a) => a.id === AGENT_A.id)?.lifecycle, feedOf(db).agents.find((a) => a.id === AGENT_A.id)?.floor], ["not_started", true]);
  const rev = store.revision(db);
  const seen = new Set<string>();
  tickDates(db, seen, start + 1);
  assert.equal(store.revision(db), rev, "one tick does not act");
  tickDates(db, seen, start + 60_001);
  assert.ok(store.revision(db) > rev, "a reader with sinceRevision sees the floor lift");
  assert.deepEqual([feedOf(db).agents.find((a) => a.id === AGENT_A.id)?.lifecycle, feedOf(db).agents.find((a) => a.id === AGENT_A.id)?.floor], ["active", false]);
  void ann;
});

test("A42: during a leaving, an agent reads nothing new: directory_get and resolve_sender say departed from archived only", async () => {
  const { db, ann } = world();
  store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00001"] }, T0);
  const team = store.setTeam(db, { name: "Support" }, T0);
  store.setMembers(db, { team: team.id, people: [{ id: ann.id, role: "member" }], agents: [] }, T0);
  const look = () => ({ lean: leanDirectory(db).people.find((p) => p.id === ann.id)?.status, res: leanResolveSender(db, "slack:UANN00001") });
  const open = look();
  await run("lifecycle_set", { kind: "person", id: ann.id, to: "leaving", reason: "security", note: "Secret reason text" }, ctxOf(db, PERSON_CALLER));
  const during = look();
  assert.deepEqual(during, open, "byte for byte the same answer as before the leaving");
  const asAgent = await run("resolve_sender", { handle: "slack:UANN00001" }, ctxOf(db, AGENT_CALLER));
  assert.equal(asAgent.contact.status, "active");
  assert.equal(asAgent.teams.length, 1);
  const dir = JSON.stringify(await run("directory_get", {}, ctxOf(db, AGENT_CALLER)));
  assert.ok(!dir.includes("Secret reason text") && !dir.includes("leaving") && !dir.includes("security"));
  // the hook facts and the feed keep the real status: they narrow what Rules allows
  assert.deepEqual(store.resolveSender(db, "slack:UANN00001").teams, []);
  assert.equal(feedOf(db).contacts.find((c) => c.id === ann.id)?.status, "departed");
  setKeepRunning(db, AGENT_A.id, "x", OWNER, T0);
  set(db, "person", ann.id, "archived", { waive: WAIVE });
  assert.equal(look().lean, "departed");
  assert.equal(look().res.contact?.status, "departed");
  assert.deepEqual(look().res.teams, []);
});

test("the agent_set and members_set ops use the mover", async () => {
  const { db, ann } = world();
  const c = ctxOf(db, PERSON_CALLER);
  const team = store.setTeam(db, { name: "Support" }, T0);
  await run("members_set", { team: team.id, people: [{ id: ann.id, role: "member" }], agents: [] }, c);
  await run("agent_set", { agent: AGENT_B.id, owner: ann.id }, c);
  assert.ok(db.prepare("SELECT 1 FROM fleet_lifecycle_events WHERE subject_id = ? AND kind = 'moved'").get(ann.id));
  assert.ok(db.prepare("SELECT 1 FROM fleet_lifecycle_events WHERE subject_id = ? AND kind = 'moved'").get(AGENT_B.id));
});

test("default owner: unowned agents take it, one event each; a new agent too; never a non-active person; no agent is paused", async () => {
  const { db, ann } = world();
  const c = ctxOf(db, PERSON_CALLER);
  const bob = store.setPerson(db, { name: "Bob" }, T0);
  const bot = store.setPerson(db, { name: "Bot", kind: "outside_agent" }, T0);
  await assert.rejects(run("settings_set", { defaultOwner: "psn_x" }, c), refused("person_not_found", 404));
  await assert.rejects(run("settings_set", { defaultOwner: bot.id }, c), refused("owner_not_person", 400));
  await assert.rejects(run("settings_set", { coolingDays: 0 }, c), refused("input_invalid", 400));
  const out = await run("settings_set", { defaultOwner: bob.id, coolingDays: 10 }, c);
  validOut("settings_set", out);
  assert.equal(out.assigned, 1);
  assert.equal(store.getAgent(db, AGENT_B.id).owner?.id, bob.id);
  assert.equal(store.getAgent(db, AGENT_B.id).status, "active");
  assert.equal(store.getAgent(db, AGENT_A.id).owner?.id, ann.id, "an owned agent keeps its owner");
  set(db, "person", bob.id, "leaving");
  await assert.rejects(run("settings_set", { defaultOwner: bob.id }, c), refused("owner_inactive", 409));
  store.syncAgents(db, [AGENT_A, AGENT_B, { id: "agt_01J0000000000000000000000C", name: "C", mode: "free", status: "active" }], T0);
  assert.equal(assignDefaultOwner(db, SYSTEM, T0), 0, "not while the default owner is not active");
  assert.deepEqual(setSettings(db, { defaultOwner: null }, { kind: "owner", id: "o" }, T0).settings.defaultOwner, null);
});

test("A1b: colleague_get carries actions with the guard's words, the plan, the floor and the history; schema valid in each state", async () => {
  const { db, ann } = world();
  const c = ctxOf(db, PERSON_CALLER);
  const view = async (kind: string, id: string) => {
    const out = await run("colleague_get", { kind, id }, c);
    validOut("colleague_get", out);
    return out.colleague;
  };
  const agent = await view("agent", AGENT_A.id);
  assert.equal(agent.line, "Working");
  assert.equal(agent.plan, null);
  assert.deepEqual(agent.actions.map((x: { to: string }) => x.to), ["suspended", "leaving"]);
  await run("lifecycle_set", { kind: "person", id: ann.id, to: "leaving", reason: "left", decisions: [{ agent: AGENT_A.id, decision: "stop" }] }, c);
  const person = await view("person", ann.id);
  assert.equal(person.line, "Leaving");
  assert.equal(person.plan.headline, NOT_APPLIED);
  assert.deepEqual(person.plan.steps.map((s: { action: string }) => s.action), ["pause", "remove_access"]);
  assert.equal(person.close.coolingDays, 30);
  const close = person.actions.find((x: { to: string }) => x.to === "archived");
  assert.equal(close.needsWaive, true);
  assert.match(String(close.blocked), /still run/);
  assert.deepEqual(person.agents.map((x: { line: string }) => x.line), ["Stop and remove asked: still running"]);
  assert.equal(person.floor.state, "not_installed");
  assert.equal(stateOf(db, "agent", AGENT_A.id), "leaving");
  assert.ok(person.history.some((h: { to: string }) => h.to === "leaving"));
  // the person decision: keep needs a reason; not owned is refused
  const pat = store.setPerson(db, { name: "Pat" }, T0);
  await assert.rejects(run("lifecycle_set", { kind: "person", id: pat.id, decisions: [{ agent: AGENT_A.id, decision: "keep", reason: "x" }] }, c), refused("agent_not_owned", 409));
  await assert.rejects(run("lifecycle_set", { kind: "person", id: pat.id }, c), refused("input_invalid", 400));
  await assert.rejects(run("lifecycle_set", { kind: "person", id: pat.id, to: "suspended" }, c), refused("reason_required", 400));
  await assert.rejects(run("colleague_get", { kind: "person", id: "psn_x" }, c), refused("person_not_found", 404));
  const list = await run("colleagues_list", { kind: "person" }, c);
  validOut("colleagues_list", list);
  assert.deepEqual(list.items.map((r: { name: string }) => r.name), ["Ann", "Pat"]);
});

test("colleagues_list pages over a stable order, filters, and holds at the directory's caps", () => {
  const { db } = world();
  for (let i = 0; i < 5; i++) store.setPerson(db, { name: `P${i}` }, T0);
  const p1 = colleaguesList(db, { limit: 3 }, T0);
  const p2 = colleaguesList(db, { limit: 3, cursor: p1.nextCursor as string }, T0);
  const p3 = colleaguesList(db, { limit: 3, cursor: p2.nextCursor as string }, T0);
  assert.equal(p1.total, 8);
  assert.equal(p3.nextCursor, null);
  assert.equal(new Set([...p1.items, ...p2.items, ...p3.items].map((r) => r.id)).size, 8);
  assert.equal(colleaguesList(db, { kind: "agent" }, T0).total, 2);
  assert.equal(colleaguesList(db, { lifecycle: "proposed" }, T0).total, 1);
  const big = bigDirectory().db;
  big.exec("UPDATE fleet_people SET lifecycle = CASE WHEN status = 'departed' THEN 'leaving' ELSE 'active' END WHERE kind = 'person'");
  const start = performance.now();
  const out = colleaguesList(big, { limit: 200 }, T0);
  const ms = performance.now() - start;
  assert.equal(out.items.length, 200);
  assert.ok(ms < 1000, `${ms} ms at the caps`);
});

test("A4 + summary: the owner's ops run in every state; the summary is schema valid with Rules confirmed, and names what it cannot read", async () => {
  const { db, ann } = world();
  const st = { version: "0.7.0-dev.1", feedRevision: 0, entries: 0, lastGateAt: null };
  const withRules = ctxOf(db, PERSON_CALLER, { companionTargets: () => ["rules"], callApp: async () => ({ status: "ok", output: st }) });
  for (const to of ["suspended", "leaving", "active"] as const) {
    set(db, "person", ann.id, to, { reason: to === "active" ? "mistake" : "other" });
    const sum = await run("summary_get", {}, withRules);
    validOut("summary_get", sum);
    assert.equal(sum.people.total, 1);
    assert.equal(sum.agents.total, 2);
  }
  set(db, "person", ann.id, "suspended");
  st.feedRevision = 0;
  const behind = await run("summary_get", {}, withRules);
  assert.equal(behind.floor.state, "not_confirmed");
  st.feedRevision = store.revision(db);
  const ok = await run("summary_get", {}, withRules);
  assert.equal(ok.floor.state, "confirmed");
  assert.equal(ok.readiness.find((r: { id: string }) => r.id === "rules").state, "ok");
  const off = await run("summary_get", {}, ctxOf(db, PERSON_CALLER));
  assert.equal(off.readiness.find((r: { id: string }) => r.id === "rules").state, "missing");
  assert.equal(off.readiness.find((r: { id: string }) => r.id === "consent").state, "missing");
  assert.equal(off.canWriteOrSend, null);
  assert.equal(off.stores.find((r: { product: string }) => r.product === "rules").state, "not_installed");
  assert.equal(off.noOwner, 1);
});

test("S2-7: the summary shows the limit and the stops of today", async () => {
  const { db, ann } = world();
  set(db, "person", ann.id, "suspended");
  const sum = await run("summary_get", {}, ctxOf(db, PERSON_CALLER));
  validOut("summary_get", sum);
  assert.equal(sum.stopCap.limit, 5);
  assert.equal(sum.stopCap.windowMinutes, 10);
});

test("a finding names an end date whose stop waits for the cap", () => {
  const db = world().db;
  const until = T0 + 1000;
  const many = Array.from({ length: 8 }, (_, i) => store.setPerson(db, { name: `D${i}` }, T0).id);
  for (const id of many) setDates(db, { kind: "person", id, validUntil: new Date(until).toISOString(), actor: OWNER }, T0);
  const seen = new Set<string>();
  tickDates(db, seen, until + 1);
  tickDates(db, seen, until + 2);
  assert.equal(colleaguesList(db, { finding: "date_passed" }, until + 3).total, 3);
});

test("findings at the migration: leaving_no_plan, no_owner, and a card that comes back", () => {
  const db = migratedDb(7);
  seedOldSchema(db);
  db.exec(`
    INSERT INTO fleet_people (id, name, email, title, status, kind, trust, source, tags, created_at, updated_at) VALUES ('psn_left', 'Left Bo', NULL, '', 'departed', 'person', 'trusted', 'owner', '[]', 1, 2), ('psn_bot', 'Bot', NULL, '', 'active', 'outside_agent', 'blocked', 'owner', '[]', 1, 2);
    INSERT INTO fleet_agents (id, name, mode, status, owner_id, role, tags, trust, first_seen, updated_at) VALUES ('agt_01J0000000000000000000000C', 'Removed C', 'free', 'removed', 'psn_left', 'r', '[]', 'trusted', 1, 2);`);
  for (const m of migrationFiles().slice(7)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  const rows = loadColleagues(db, Date.now()).byId;
  assert.ok(rows.get("person:psn_left")?.findings.some((f) => f.code === "leaving_no_plan"));
  assert.ok(rows.get(`agent:${AGENT_B.id}`)?.findings.some((f) => f.code === "no_owner"));
  assert.equal(rows.get("person:psn_bot"), undefined, "an outside agent has no lifecycle and is not listed");
  const feed = directoryFeed(db, { accept: ["lifecycle"] }) as Extract<DirectoryFeed, { unchanged: false }>;
  assert.equal(feed.contacts.find((c) => c.id === "psn_left")?.floor, true);
  assert.equal(feed.contacts.find((c) => c.id === "psn_bot")?.floor, true, "an outside agent: by trust only");
  assert.equal(feed.agents.find((a) => a.id === "agt_01J0000000000000000000000C"), undefined, "a no_card row with no card stays out");
  store.syncAgents(db, [{ id: "agt_01J0000000000000000000000C", name: "Removed C", mode: "free", status: "active" }]);
  const back = loadColleagues(db, Date.now()).byId.get("agent:agt_01J0000000000000000000000C");
  assert.ok(back?.findings.some((f) => f.code === "card_back_after_close"));
  assert.equal((directoryFeed(db, { accept: ["lifecycle"] }) as Extract<DirectoryFeed, { unchanged: false }>).agents.find((a) => a.id === "agt_01J0000000000000000000000C")?.floor, false, "the floor ignores a no_card row");
  // the owner can end the finding: this one row may come back
  set(db, "agent", "agt_01J0000000000000000000000C", "proposed", { reason: "returned" });
  assert.equal(loadColleagues(db, Date.now()).byId.get("agent:agt_01J0000000000000000000000C")?.lifecycle, "proposed");
});

test("a person's handle stays the person's: the agent shows a finding (S3-15)", () => {
  const { db, ann } = world();
  store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00001"] }, T0);
  db.prepare("INSERT INTO fleet_agent_handles (agent_id, handle) VALUES (?, 'slack:UANN00001')").run(AGENT_A.id);
  assert.ok(loadColleagues(db, T0).byId.get(`agent:${AGENT_A.id}`)?.findings.some((f) => f.code === "agent_handle_conflict"));
});

test("S2-7: stop decisions with no stop of their own pass the cap; a date and a stop in one call pass it once", async () => {
  const { db, ann } = world();
  const c = ctxOf(db, PERSON_CALLER);
  store.setAgent(db, { agent: AGENT_B.id, owner: ann.id }, T0);
  const now = Date.now();
  const fill = Array.from({ length: 5 }, (_, i) => store.setPerson(db, { name: `F${i}` }, T0).id);
  for (const id of fill) set(db, "person", id, "suspended", {}, now);
  await assert.rejects(run("lifecycle_set", { kind: "person", id: ann.id, reason: "left", decisions: [{ agent: AGENT_B.id, decision: "stop" }] }, c), refused("stop_cap_reached", 409));
  assert.equal(stateOf(db, "agent", AGENT_B.id), "proposed", "nothing moved");
  const pat = store.setPerson(db, { name: "Pat" }, T0);
  const startsLater = new Date(now + DAY_MS).toISOString();
  await assert.rejects(run("lifecycle_set", { kind: "person", id: pat.id, to: "suspended", reason: "left", validFrom: startsLater }, c), refused("stop_cap_reached", 409));
  const out = await run("lifecycle_set", { kind: "person", id: pat.id, to: "suspended", reason: "left", validFrom: startsLater, confirmCount: 6 }, c);
  validOut("lifecycle_set", out);
  assert.equal(stateOf(db, "person", pat.id), "suspended");
});

test("lifecycle_set: a stale revision and a refusal late in the call leave nothing behind", async () => {
  const { db, ann } = world();
  const c = ctxOf(db, PERSON_CALLER);
  const before = (await run("colleague_get", { kind: "person", id: ann.id }, c)).colleague;
  store.setPerson(db, { id: ann.id, name: "Ann", status: "departed" }, T0);
  await assert.rejects(run("lifecycle_set", { kind: "person", id: ann.id, to: "active", reason: "mistake", expectedRev: before.rev }, c), refused("lifecycle_stale", 409));
  const b = world();
  const bc = ctxOf(b.db, PERSON_CALLER);
  const events = () => Number(b.db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events").get()?.n);
  const n = events();
  const rev = store.revision(b.db);
  await assert.rejects(run("lifecycle_set", { kind: "person", id: b.ann.id, to: "leaving", reason: "left", decisions: [{ agent: AGENT_A.id, decision: "stop" }, { agent: AGENT_B.id, decision: "stop" }] }, bc), refused("agent_not_owned", 409));
  assert.deepEqual([stateOf(b.db, "person", b.ann.id), stateOf(b.db, "agent", AGENT_A.id), events(), store.revision(b.db)], ["active", "active", n, rev]);
});

test("A42: stop and keep decisions show nothing to an agent either", async () => {
  const { db, ann } = world();
  store.setAgent(db, { agent: AGENT_B.id, owner: ann.id }, T0);
  const look = () => JSON.stringify(leanDirectory(db));
  const open = look();
  await run("lifecycle_set", { kind: "person", id: ann.id, to: "leaving", reason: "security", decisions: [{ agent: AGENT_A.id, decision: "stop" }, { agent: AGENT_B.id, decision: "keep", reason: "Runs payroll" }] }, ctxOf(db, PERSON_CALLER));
  assert.equal(JSON.parse(look()).revision > JSON.parse(open).revision, true);
  const strip = (t: string) => ({ ...JSON.parse(t), revision: 0 });
  assert.deepEqual(strip(look()), strip(open), "the same answer apart from the revision");
});

test("the summary does not count from a cut list of access", async () => {
  const { db } = world();
  const topology = { v: 1, agentIds: [AGENT_A.id], instances: [["ins_k", "knowledge", "Knowledge", "1"]], edges: [[0, 0, "cr", "f", 0, 0, 0]], companions: [], connections: [], truncated: true };
  assert.equal((await run("summary_get", {}, ctxOf(db, PERSON_CALLER, { topology: () => topology }))).canWriteOrSend, null);
  assert.equal((await run("summary_get", {}, ctxOf(db, PERSON_CALLER, { topology: () => ({ ...topology, truncated: undefined }) }))).canWriteOrSend, 1);
});
