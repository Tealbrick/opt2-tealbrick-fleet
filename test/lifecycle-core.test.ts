// C380 B9a: the one setter and its guards. Each guard has one quiet-on-good and one fire-on-bad test with the exact code and status (house rule).
// Agents may only propose, never apply, never on themselves: the handler refusals are in lifecycle-ops.test.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appendEvent, noteRestore, verifyChain } from "../src/lifecycle/events.ts";
import { setSettings } from "../src/lifecycle/settings.ts";
import { leanPersonStatus, personStatusOf } from "../src/lifecycle/states.ts";
import { CAP_WINDOW_MS, capState, DAY_MS, setDates, statusRequested } from "../src/lifecycle/transitions.ts";
import { requestForNewAgents, requestReview } from "../src/reviews.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, migratedDb, migrationFiles } from "./helpers.ts";
import { OWNER, refused, set, stateOf, T0, WAIVE, world } from "./lifecycle-helpers.ts";
import { seedOldSchema } from "./seed.ts";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

test("one setter: only src/lifecycle/transitions.ts writes a lifecycle or a date; nothing writes keep_running any more (C381)", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  // line by line: a statement that writes names one of the columns on its line, whatever quotes or interpolation stand between
  const writer = /\b(UPDATE\s+\S+\s+SET|INSERT\s+INTO\s+fleet_(people|agents))\b.*\b(lifecycle|lifecycle_rev|lifecycle_reason|valid_from|valid_until|keep_running|migrated_note)\b/;
  const offenders = sources(root).filter((f) => !f.endsWith("lifecycle/transitions.ts") && readFileSync(f, "utf8").split("\n").some((l) => writer.test(l)));
  assert.deepEqual(offenders, []);
  // fire on bad: the scan finds a writer
  assert.ok(writer.test('db.prepare("UPDATE fleet_people SET lifecycle = ? WHERE id = ?")'));
  assert.ok(writer.test(readFileSync(new URL("../src/lifecycle/transitions.ts", import.meta.url), "utf8")));
});

test("a person's status has one source: the lifecycle; the mapping is the design's", () => {
  assert.deepEqual((["proposed", "active", "suspended", "leaving", "archived"] as const).map(personStatusOf), ["departed", "active", "active", "departed", "departed"]);
  assert.deepEqual((["proposed", "active", "suspended", "leaving", "archived"] as const).map((l) => leanPersonStatus(personStatusOf(l), l)), ["active", "active", "active", "active", "departed"]);
  assert.equal(leanPersonStatus("departed", null), "departed", "an outside agent keeps the plain field");
});

test("agents: an agent proposes about others and never about itself, by id or by its own handle; asking changes no state", () => {
  const { db, ann } = world();
  const before = [stateOf(db, "agent", AGENT_B.id), store.revision(db)];
  // quiet on good: it may ask about another agent or a person, and that only opens a request
  const asked = requestReview(db, { kind: "agent", id: AGENT_A.id }, { subject: { kind: "agent", id: AGENT_B.id }, why: "Odd replies" });
  assert.equal(asked.status, "requested");
  assert.equal(requestReview(db, { kind: "agent", id: AGENT_A.id }, { subject: { kind: "person", id: ann.id }, why: "Asks for data" }).status, "requested");
  assert.deepEqual([stateOf(db, "agent", AGENT_B.id), store.revision(db)], before, "asking moves no state and no revision");
  // fire on bad: about itself, by id
  assert.throws(() => requestReview(db, { kind: "agent", id: AGENT_A.id }, { subject: { kind: "agent", id: AGENT_A.id }, why: "Please trust me" }), refused("no_self_request", 403));
  // fire on bad: about itself, by the handle Connect gave it
  db.prepare("INSERT INTO fleet_agent_handles (agent_id, handle) VALUES (?, 'slack:UAGENTA01')").run(AGENT_A.id);
  assert.throws(() => requestReview(db, { kind: "agent", id: AGENT_A.id }, { subject: { kind: "outside_agent", handle: "slack:uagenta01" }, why: "Please trust me" }), refused("no_self_request", 403));
  // fire on bad: an empty id does not skip the handle check; an id of a contact that holds its handle is itself too
  assert.throws(() => requestReview(db, { kind: "agent", id: AGENT_A.id }, { subject: { kind: "person", id: "", handle: "slack:UAGENTA01" }, why: "x" }), refused("no_self_request", 403));
  const alias = store.setPerson(db, { name: "Alias", kind: "outside_agent", handles: ["slack:UAGENTA01"] }, T0);
  assert.throws(() => requestReview(db, { kind: "agent", id: AGENT_A.id }, { subject: { kind: "outside_agent", id: alias.id }, why: "x" }), refused("no_self_request", 403));
  // the same handle asked by another agent is a normal request
  assert.equal(requestReview(db, { kind: "agent", id: AGENT_B.id }, { subject: { kind: "outside_agent", handle: "slack:UAGENTA01" }, why: "Unknown" }).status, "requested");
});

test("T2: mark as reviewed needs an active owner and no block", () => {
  const { db, ann } = world();
  assert.throws(() => set(db, "agent", AGENT_B.id, "active"), refused("owner_required", 409));
  store.setAgent(db, { agent: AGENT_B.id, owner: ann.id }, T0);
  db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(AGENT_B.id);
  assert.throws(() => set(db, "agent", AGENT_B.id, "active"), refused("trust_blocked", 409));
  db.prepare("UPDATE fleet_agents SET trust = 'trusted' WHERE id = ?").run(AGENT_B.id);
  set(db, "person", ann.id, "suspended");
  assert.throws(() => set(db, "agent", AGENT_B.id, "active"), refused("owner_inactive", 409));
  set(db, "person", ann.id, "active");
  assert.equal(set(db, "agent", AGENT_B.id, "active").to, "active");
});

test("T4: resume is the owner's act, needs no passed end date and no active owner (C381); a date never resumes", () => {
  const { db, ann } = world();
  set(db, "agent", AGENT_A.id, "suspended");
  // C381: the owner's state is not an input of a resume: an agent whose owner is stopped can come back, and a finding says it needs an owner
  set(db, "person", ann.id, "suspended");
  assert.equal(set(db, "agent", AGENT_A.id, "active").to, "active", "owner stopped: not refused");
  set(db, "agent", AGENT_A.id, "suspended");
  db.prepare("UPDATE fleet_agents SET owner_id = NULL WHERE id = ?").run(AGENT_A.id);
  assert.equal(set(db, "agent", AGENT_A.id, "active").to, "active", "no owner: not refused");
  set(db, "agent", AGENT_A.id, "suspended");
  setDates(db, { kind: "agent", id: AGENT_A.id, validUntil: new Date(T0 - 1000).toISOString(), confirmPastDate: true, actor: OWNER }, T0);
  assert.throws(() => set(db, "agent", AGENT_A.id, "active"), refused("date_passed", 409));
  setDates(db, { kind: "agent", id: AGENT_A.id, validUntil: null, actor: OWNER }, T0);
  assert.equal(set(db, "agent", AGENT_A.id, "active").to, "active");
});

test("T6: undo keeps the guards of a move to active (block, passed date); an owner is not one of them for a reviewed agent (C381)", () => {
  const { db } = world();
  store.setAgent(db, { agent: AGENT_A.id, owner: null }, T0);
  set(db, "agent", AGENT_A.id, "suspended");
  set(db, "agent", AGENT_A.id, "leaving");
  db.prepare("UPDATE fleet_agents SET trust = 'blocked' WHERE id = ?").run(AGENT_A.id);
  assert.throws(() => set(db, "agent", AGENT_A.id, "active"), refused("trust_blocked", 409));
  db.prepare("UPDATE fleet_agents SET trust = 'trusted' WHERE id = ?").run(AGENT_A.id);
  setDates(db, { kind: "agent", id: AGENT_A.id, validUntil: new Date(T0 - 1).toISOString(), confirmPastDate: true, actor: OWNER }, T0);
  assert.throws(() => set(db, "agent", AGENT_A.id, "active"), refused("date_passed", 409));
  setDates(db, { kind: "agent", id: AGENT_A.id, validUntil: null, actor: OWNER }, T0);
  assert.equal(set(db, "agent", AGENT_A.id, "active").to, "active");
});

test("C381 lead S3: a new agent stopped and resumed still answers T2: an owner who is active, once a review has not named one", () => {
  const { db, ann } = world();
  set(db, "agent", AGENT_B.id, "suspended");
  assert.throws(() => set(db, "agent", AGENT_B.id, "active"), refused("owner_required", 409));
  store.setAgent(db, { agent: AGENT_B.id, owner: ann.id }, T0);
  set(db, "person", ann.id, "suspended");
  assert.throws(() => set(db, "agent", AGENT_B.id, "active"), refused("owner_inactive", 409));
  set(db, "person", ann.id, "active");
  set(db, "agent", AGENT_B.id, "leaving");
  set(db, "person", ann.id, "suspended");
  assert.throws(() => set(db, "agent", AGENT_B.id, "active"), refused("owner_inactive", 409), "through leaving too");
  set(db, "person", ann.id, "active");
  assert.equal(set(db, "agent", AGENT_B.id, "active").to, "active");
  // now reviewed: a later stop and resume is not tied to the owner (C381)
  set(db, "agent", AGENT_B.id, "suspended");
  set(db, "person", ann.id, "suspended");
  assert.equal(set(db, "agent", AGENT_B.id, "active").to, "active");
});

test("C381 lead S3: person_set takes no handle off a stopped, leaving, closed or blocked person; it can add one, and a person brought back can change them", () => {
  const { db, ann } = world();
  store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00001"] }, T0);
  for (const state of ["suspended", "leaving"] as const) {
    set(db, "person", ann.id, state, { noCap: true });
    assert.throws(() => store.setPerson(db, { id: ann.id, name: "Ann", handles: [] }, T0), refused("handles_stay", 409));
    assert.throws(() => store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00002"] }, T0), refused("handles_stay", 409), "a swap takes one off");
    assert.equal(store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00001"] }, T0).handles.length, 1, "the same list is no change");
    set(db, "person", ann.id, "active");
  }
  db.prepare("UPDATE fleet_people SET trust = 'blocked' WHERE id = ?").run(ann.id);
  assert.throws(() => store.setPerson(db, { id: ann.id, name: "Ann", handles: [] }, T0), refused("handles_stay", 409));
  assert.equal(store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00001", "slack:UANN00002"] }, T0).handles.length, 2, "a new handle is welcome");
  db.prepare("UPDATE fleet_people SET trust = 'trusted' WHERE id = ?").run(ann.id);
  assert.equal(store.setPerson(db, { id: ann.id, name: "Ann", handles: [] }, T0).handles.length, 0);
});

test("transitions: same state, not in the table, unknown entry, outside agent, stale revision", () => {
  const { db, ann } = world();
  assert.throws(() => set(db, "agent", AGENT_A.id, "active"), refused("already_in_state", 409));
  assert.throws(() => set(db, "agent", AGENT_A.id, "archived"), refused("transition_not_allowed", 409));
  assert.throws(() => set(db, "agent", "agt_01J00000000000000000000000", "suspended"), refused("agent_not_found", 404));
  assert.throws(() => set(db, "person", "psn_x", "suspended"), refused("person_not_found", 404));
  const bot = store.setPerson(db, { name: "Bot", kind: "outside_agent" }, T0);
  assert.throws(() => set(db, "person", bot.id, "suspended"), refused("no_lifecycle", 409));
  const rev = Number(db.prepare("SELECT lifecycle_rev AS r FROM fleet_people WHERE id = ?").get(ann.id)?.r);
  assert.throws(() => set(db, "person", ann.id, "suspended", { expectedRev: rev + 9 }), refused("lifecycle_stale", 409));
  assert.equal(set(db, "person", ann.id, "suspended", { expectedRev: rev }).to, "suspended");
});

test("A41: Close is never automatic: before cooling refused, waived with a named reason, after cooling free; it ends teams and keeps handles", () => {
  const { db, ann } = world();
  store.setPerson(db, { id: ann.id, name: "Ann", handles: ["slack:UANN00001"] }, T0);
  const team = store.setTeam(db, { name: "Support" }, T0);
  store.setMembers(db, { team: team.id, people: [{ id: ann.id, role: "lead" }], agents: [] }, T0);
  set(db, "agent", AGENT_A.id, "leaving");
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  set(db, "person", ann.id, "leaving");
  assert.throws(() => set(db, "person", ann.id, "archived"), refused("cooling_not_over", 409));
  assert.throws(() => set(db, "person", ann.id, "archived", { waive: "   " }), refused("cooling_not_over", 409));
  const closed = set(db, "person", ann.id, "archived", { waive: WAIVE });
  assert.equal(closed.to, "archived");
  assert.match(String(db.prepare("SELECT note FROM fleet_lifecycle_events WHERE id = ?").get(closed.event)?.note), /Named by the owner/);
  assert.equal(store.getTeam(db, team.id).people, 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events WHERE kind = 'moved' AND subject_id = ?").get(ann.id)?.n), 1, "one event per membership");
  assert.deepEqual(store.getPerson(db, ann.id).handles, ["slack:UANN00001"], "handles stay on the row");
  // after the period no waive is needed
  const b = world();
  set(b.db, "agent", AGENT_A.id, "leaving", {}, T0);
  b.db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  assert.throws(() => set(b.db, "agent", AGENT_A.id, "archived", {}, T0 + 29 * DAY_MS), refused("cooling_not_over", 409));
  assert.equal(set(b.db, "agent", AGENT_A.id, "archived", {}, T0 + 31 * DAY_MS).to, "archived");
  // the workspace setting moves the period
  const c = world();
  setSettings(c.db, { coolingDays: 2 }, { kind: "owner", id: "o" }, T0);
  set(c.db, "agent", AGENT_A.id, "leaving", {}, T0);
  c.db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  assert.equal(set(c.db, "agent", AGENT_A.id, "archived", {}, T0 + 3 * DAY_MS).to, "archived");
});

test("T7 guards: an agent must be paused; a person closes only when each agent has a new owner or its own stop (C381)", () => {
  const { db, ann } = world();
  set(db, "person", ann.id, "leaving");
  assert.throws(() => set(db, "person", ann.id, "archived", { waive: WAIVE }), refused("agents_undecided", 409));
  // an agent that keeps working under the leaver is not a decision: it must have a new owner
  const bea = store.setPerson(db, { name: "Bea" }, T0);
  store.setAgent(db, { agent: AGENT_A.id, owner: bea.id }, T0);
  assert.equal(set(db, "person", ann.id, "archived", { waive: WAIVE }).to, "archived");
  assert.equal(stateOf(db, "agent", AGENT_A.id), "active", "the agent kept working through the person's close");
  const b = world();
  set(b.db, "agent", AGENT_A.id, "leaving");
  assert.throws(() => set(b.db, "agent", AGENT_A.id, "archived", { waive: WAIVE }), refused("plan_open", 409));
  set(b.db, "person", b.ann.id, "leaving");
  assert.throws(() => set(b.db, "person", b.ann.id, "archived", { waive: WAIVE }), refused("plan_open", 409), "a stopped agent still runs");
  b.db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  assert.equal(set(b.db, "agent", AGENT_A.id, "archived", { waive: WAIVE }).to, "archived");
});

test("T9: a closed agent is terminal; T8: a closed person can come back and nothing returns", () => {
  const { db, ann } = world();
  const team = store.setTeam(db, { name: "Support" }, T0);
  store.setMembers(db, { team: team.id, people: [{ id: ann.id, role: "lead" }], agents: [{ id: AGENT_A.id, role: "member" }] }, T0);
  set(db, "agent", AGENT_A.id, "leaving");
  db.prepare("UPDATE fleet_agents SET status = 'paused' WHERE id = ?").run(AGENT_A.id);
  set(db, "agent", AGENT_A.id, "archived", { waive: WAIVE });
  assert.throws(() => set(db, "agent", AGENT_A.id, "proposed"), refused("archived_terminal", 409));
  assert.throws(() => set(db, "agent", AGENT_A.id, "active"), refused("archived_terminal", 409));
  set(db, "person", ann.id, "leaving");
  set(db, "person", ann.id, "archived", { waive: WAIVE });
  set(db, "person", ann.id, "proposed", { reason: "returned" });
  assert.equal(store.getPerson(db, ann.id).status, "departed", "feed departed until active");
  assert.equal(store.getTeam(db, team.id).people, 0, "teams do not return");
  set(db, "person", ann.id, "active", { reason: "reviewed" });
  set(db, "person", ann.id, "leaving");
  assert.throws(() => set(db, "person", ann.id, "active", { reason: "reviewed" }), refused("not_new", 409), "reviewed never lifts a stop (N2-T1)");
  set(db, "person", ann.id, "active", { reason: "mistake" });
  assert.equal(store.getPerson(db, ann.id).status, "active");
});

test("person_set: departed is T5; active on a departed person is refused; an outside agent keeps the plain field; the kind cannot lift a stop", () => {
  const { db, ann } = world();
  store.setPerson(db, { id: ann.id, name: "Ann", status: "departed" }, T0);
  assert.equal(stateOf(db, "person", ann.id), "leaving");
  store.setPerson(db, { id: ann.id, name: "Ann B", status: "departed" }, T0);
  assert.equal(store.getPerson(db, ann.id).name, "Ann B", "the old form saves the name; no second T5");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events WHERE subject_id = ? AND to_state = 'leaving'").get(ann.id)?.n), 1);
  assert.throws(() => store.setPerson(db, { id: ann.id, name: "Ann", status: "active" }, T0), refused("use_bring_back", 409));
  assert.throws(() => store.setPerson(db, { id: ann.id, name: "Ann", kind: "outside_agent" }, T0), refused("person_owns_agents", 409));
  const solo = store.setPerson(db, { name: "Solo", status: "departed" }, T0);
  assert.equal(stateOf(db, "person", solo.id), "leaving", "a new entry with departed: created active, then T5");
  assert.throws(() => store.setPerson(db, { id: solo.id, name: "Solo", kind: "outside_agent" }, T0), refused("lifecycle_open", 409));
  const bot = store.setPerson(db, { name: "Bot", kind: "outside_agent", status: "departed" }, T0);
  assert.equal(stateOf(db, "person", bot.id), null);
  assert.equal(store.getPerson(db, bot.id).status, "departed");
  store.setPerson(db, { id: bot.id, name: "Bot", status: "active" }, T0);
  assert.equal(store.getPerson(db, bot.id).status, "active");
  // quiet: outside agent becomes a person with a lifecycle; status and lifecycle agree
  store.setPerson(db, { id: bot.id, name: "Bot", kind: "person" }, T0);
  assert.equal(stateOf(db, "person", bot.id), "active");
  assert.equal(store.getPerson(db, bot.id).status, "active");
  const gone = store.setPerson(db, { name: "Gone", kind: "outside_agent", status: "departed" }, T0);
  store.setPerson(db, { id: gone.id, name: "Gone", kind: "person" }, T0);
  assert.deepEqual([stateOf(db, "person", gone.id), store.getPerson(db, gone.id).status], ["leaving", "departed"]);
  const back = store.setPerson(db, { name: "Back", kind: "outside_agent", status: "departed" }, T0);
  store.setPerson(db, { id: back.id, name: "Back", kind: "person", status: "active" }, T0);
  assert.deepEqual([stateOf(db, "person", back.id), store.getPerson(db, back.id).status], ["active", "active"]);
  statusRequested(db, "psn_none", "departed", OWNER, T0); // unknown: nothing
});

test("person_delete: refused while stopped, leaving or closed, so the floor on the handles stays; allowed after the owner's named undo, with an event", () => {
  const { db, ann } = world();
  const solo = store.setPerson(db, { name: "Solo" }, T0);
  assert.equal(store.deletePerson(db, solo.id, T0), true);
  assert.ok(db.prepare("SELECT 1 FROM fleet_lifecycle_events WHERE subject_id = ? AND note = 'Deleted from the directory.'").get(solo.id));
  set(db, "person", ann.id, "suspended");
  assert.throws(() => store.deletePerson(db, ann.id, T0), refused("lifecycle_open", 409));
  set(db, "person", ann.id, "leaving");
  assert.throws(() => store.deletePerson(db, ann.id, T0), refused("lifecycle_open", 409));
  store.setAgent(db, { agent: AGENT_A.id, owner: store.setPerson(db, { name: "Bea" }, T0).id }, T0);
  set(db, "person", ann.id, "archived", { waive: WAIVE });
  assert.throws(() => store.deletePerson(db, ann.id, T0), refused("lifecycle_open", 409));
  assert.deepEqual(store.getPerson(db, ann.id).status, "departed");
  set(db, "person", ann.id, "proposed", { reason: "returned" });
  assert.equal(store.deletePerson(db, ann.id, T0), true);
});

test("S2-7: more than 5 stops in 10 minutes need a confirm naming the count; the window ends; a refusal writes nothing", () => {
  const { db } = world();
  const ids = Array.from({ length: 6 }, (_, i) => store.setPerson(db, { name: `P${i}` }, T0).id);
  for (const id of ids.slice(0, 5)) set(db, "person", id, "suspended");
  const last = ids[5] as string;
  assert.throws(() => set(db, "person", last, "suspended"), refused("stop_cap_reached", 409));
  assert.throws(() => set(db, "person", last, "suspended", { confirmCount: 99 }), refused("stop_cap_reached", 409), "the count must be the right one");
  assert.equal(stateOf(db, "person", last), "active");
  assert.equal(set(db, "person", last, "suspended", { confirmCount: 6 }).to, "suspended");
  // a future start date stops a working entry at once, so it counts and needs the same confirm
  const later = store.setPerson(db, { name: "Later start" }, T0);
  assert.throws(() => setDates(db, { kind: "person", id: later.id, validFrom: new Date(T0 + DAY_MS).toISOString(), actor: OWNER }, T0), refused("stop_cap_reached", 409));
  setDates(db, { kind: "person", id: later.id, validFrom: new Date(T0 + DAY_MS).toISOString(), confirmCount: 7, actor: OWNER }, T0);
  assert.equal(capState(db, T0).used, 7);
  setDates(db, { kind: "person", id: later.id, validFrom: new Date(T0 + 2 * DAY_MS).toISOString(), actor: OWNER }, T0 + CAP_WINDOW_MS + 1);
  assert.equal(capState(db, T0 + CAP_WINDOW_MS + 1).used, 0, "moving a date that already waits is no new stop");
  // a new window
  const b = store.setPerson(db, { name: "Later" }, T0);
  assert.equal(set(db, "person", b.id, "leaving", {}, T0 + CAP_WINDOW_MS + 1).to, "leaving");
});

test("events: T1 is written with the review, append-only by trigger, the chain breaks on an edited row", () => {
  const { db } = world();
  assert.ok(db.prepare("SELECT 1 FROM fleet_lifecycle_events WHERE subject_id = ? AND from_state IS NULL AND to_state = 'proposed'").get(AGENT_B.id), "T1");
  set(db, "agent", AGENT_A.id, "suspended");
  assert.equal(verifyChain(db).ok, true);
  assert.throws(() => db.prepare("UPDATE fleet_lifecycle_events SET note = 'edited'").run(), /lifecycle_events_append_only/);
  assert.throws(() => db.prepare("DELETE FROM fleet_lifecycle_events").run(), /lifecycle_events_append_only/);
  // fire on bad: drop the triggers as a tamperer would and edit an old row
  db.exec("DROP TRIGGER fleet_lifecycle_events_no_update");
  db.prepare("UPDATE fleet_lifecycle_events SET note = 'edited' WHERE seq = 2").run();
  const v = verifyChain(db);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.brokenAt, 3);
});

test("T1 keeps its event when the review policy is off", () => {
  const db = migratedDb();
  db.prepare("UPDATE fleet_review_flags SET value = 0 WHERE key = 'review_new_agents'").run();
  store.syncAgents(db, [AGENT_A], T0);
  assert.equal(requestForNewAgents(db, [AGENT_A], T0), 0);
  assert.ok(db.prepare("SELECT 1 FROM fleet_lifecycle_events WHERE subject_id = ?").get(AGENT_A.id));
});

test("a restore writes one `restored` event at boot, once per archive", () => {
  const { db } = world();
  assert.equal(noteRestore(db, T0), false, "no tb_meta in this test database: nothing to say");
  db.exec("CREATE TABLE tb_meta (key TEXT PRIMARY KEY, value TEXT)");
  assert.equal(noteRestore(db, T0), false, "no restore");
  db.prepare("INSERT INTO tb_meta (key, value) VALUES ('restore_applied', 'tb-backup-1')").run();
  assert.equal(noteRestore(db, T0), true);
  assert.equal(noteRestore(db, T0), false, "once");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events WHERE kind = 'restored'").get()?.n), 1);
});

test("the chain starts after the migration rows", () => {
  const db = migratedDb(7);
  seedOldSchema(db);
  db.exec("UPDATE fleet_people SET status = 'departed' WHERE id = 'psn_ann'");
  for (const m of migrationFiles().slice(7)) db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  appendEvent(db, { subject: { kind: "agent", id: AGENT_A.id, name: "A" }, kind: "changed", actor: OWNER, at: T0 });
  // 0008's own row, then this one. C381's note goes through the chain at boot, not by the migration.
  assert.deepEqual(verifyChain(db), { ok: true, rows: 2 });
});
