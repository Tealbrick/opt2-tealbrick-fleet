// C380 T2-b: the access record. Rows R6 (per-sweep lists with ended rows, findings, exceptions, time to stop, apps not read, the one-approver line), R7 (plan
// outcomes are copied) and R8 (the chain breaks on an edited row). The world is the plan runner's; the sweeps are real and read a fake store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { findingsList } from "../src/access/differences.ts";
import { handlers, manifest } from "../src/app.ts";
import { appendEvent, verifyChain, verifyChainPaged } from "../src/lifecycle/events.ts";
import { loadColleagues } from "../src/lifecycle/view.ts";
import { buildRecord, digestOfRecord, MAX_DAYS, periodOf } from "../src/record/index.ts";
import { itemRef } from "../src/record/sweeps.ts";
import { manyApprovers, NO_APPROVER, ONE_APPROVER } from "../src/record/words.ts";
import { recordReview, requestReview } from "../src/reviews.ts";
import { answer, wire } from "./access-helpers.ts";
import { migratedDb } from "./helpers.ts";
import { refused, T0 } from "./lifecycle-helpers.ts";
import { agentItem, approveAndDeliver, HENRY, leave, makeWorld, type World } from "./plans-world.ts";
import { SECRETS, seed } from "./seed.ts";
import { runSweep } from "./sweep-helpers.ts";

const HOUR = 3_600_000;
const OWNER = "per_owner";
const routine = (id: string) => wire("evolution", { id: `routine:${id}`, kind: "routine", resource: id, subject: { kind: "agent", id: HENRY }, label: `Routine ${id}` });
const account = (id: string) => wire("connect", { id: `account_as_itself:${id}`, kind: "account_as_itself", resource: id, subject: { kind: "agent", id: HENRY }, label: `Mail ${id}` });
const facts = (w: World, now: number) => {
  const rows = loadColleagues(w.db, now).rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings }));
  return { findings: findingsList(w.db, rows, { read: true }, now), version: "0.4.0-test", now };
};

/** Two sweeps, an exception, a stop of Henry with a plan that the stores prove. Times are fixed. */
async function story(): Promise<{ w: World; marked: number; now: number }> {
  const w = makeWorld();
  w.db.prepare("UPDATE fleet_record_meta SET value = '0' WHERE key = 'record_since'").run(); // the log began before these sweeps
  await runSweep(w.db, { connect: () => answer([account("a1")]), evolution: () => answer([routine("r1")]) }, { now: T0 + HOUR });
  await runSweep(w.db, { connect: () => { throw new Error("down"); }, evolution: () => answer([]) }, { now: T0 + 2 * HOUR });
  w.db.prepare("INSERT INTO fleet_exceptions (code, subject_kind, subject_id, reason, until, by_id, at) VALUES ('no_owner', 'agent', ?, 'The owner is on leave.', ?, ?, ?)").run(HENRY, T0 + 30 * 24 * HOUR, OWNER, T0 + 2.5 * HOUR);
  w.clock.t = T0 + 3 * HOUR;
  w.connect.add(agentItem({ id: "account_as_itself:a1", kind: "account_as_itself" }));
  leave(w);
  const marked = w.clock.t;
  const id = w.makePlan({ kind: "agent", id: HENRY });
  await w.tick(id);
  w.clock.t += 40_000;
  approveAndDeliver(w, String(w.plan(id).draft_key), HENRY);
  assert.equal(await w.until(id, "done"), "done");
  return { w, marked, now: w.clock.t + HOUR };
}

test("R6: per-sweep lists keep the rows that ended and say which store was not read; the file holds findings, exceptions, time to stop, apps not read and the one-approver line", async () => {
  const { w, marked, now } = await story();
  const { record, digest } = await buildRecord(w.db, {}, facts(w, now));
  assert.equal(record.format, "tealbrick.access-record/1");
  const [one, two] = record.sweeps.lists;
  assert.equal(record.sweeps.lists.length, 2);
  assert.deepEqual(one?.items?.map((i) => i.id), [itemRef("connect", "account_as_itself:a1"), itemRef("evolution", "routine:r1")]);
  assert.deepEqual(one?.counts, { appeared: 2, changed: 0, ended: 0 });
  assert.deepEqual(two?.items?.map((i) => i.id), [itemRef("connect", "account_as_itself:a1")], "Connect was not read: its row is not dropped");
  assert.deepEqual(two?.ended.map((i) => i.id), [itemRef("evolution", "routine:r1")], "the ended row stays in the record, with what it was");
  assert.equal(two?.ended[0]?.label, "Routine r1");
  assert.equal(two?.ended[0]?.subject && "name" in two.ended[0].subject ? two.ended[0].subject.name : null, "Henry");
  assert.deepEqual(two?.stores.map((s) => [s.product, s.readThisSweep]), [["connect", false], ["evolution", true], ["kanban", true], ["knowledge", true]]);
  assert.deepEqual(one?.stores.map((s) => s.readThisSweep), [true, true, true, true]);
  assert.equal(record.appsNotRead.stores.find((s) => s.product === "connect")?.sweepsNotReadInPeriod, 1);
  assert.equal(record.appsNotRead.stores.find((s) => s.product === "evolution")?.sweepsNotReadInPeriod, 0);
  assert.deepEqual(record.exceptions.map((e) => [e.code, e.subject.name, e.reason, e.by]), [["no_owner", "Henry", "The owner is on leave.", OWNER]]);
  assert.ok(Array.isArray(record.findings.items));
  // time to stop: from the change to the last proved step
  const stop = record.timeToStop[0];
  assert.ok(stop);
  assert.deepEqual([stop.subject.name, stop.to, stop.markedAt, stop.markedBy], ["Henry", "leaving", new Date(marked).toISOString(), "owner"]);
  assert.equal(stop.steps.open, 0);
  assert.equal(stop.steps.proved, stop.steps.total);
  assert.ok(stop.stoppedAt && stop.seconds !== null && stop.seconds >= 40, `seconds ${stop.seconds}`);
  assert.equal(stop.seconds, Math.round((Date.parse(stop.stoppedAt) - marked) / 1000));
  assert.ok(stop.seenBy.some((s) => s.startsWith("Portal")));
  // the one-approver line, and the limits the file states about itself
  assert.deepEqual([record.approvers.count, record.approvers.line], [1, ONE_APPROVER]);
  const limits = record.limits.join("\n");
  for (const text of ["Our own apps report this data", "makes no claim about any law", "One person approved all items.", "not a signature", "Export this record before you restore", "90 days", "Findings are the ones open when this file was made", "Not part of this record"]) assert.match(limits, new RegExp(text), text);
  assert.match(record.header, /Not proof of compliance/);
  assert.equal(record.integrity.chain.ok, true);
  assert.equal(record.integrity.digest, digest);
  assert.equal(digestOfRecord(record), digest, "the digest can be made again from the file");
  assert.notEqual(digestOfRecord({ ...record, header: "changed" }), digest, "and it moves when the file is edited");
});

test("R7: the outcome of each step is copied into the record, with the Portal receipt id", async () => {
  const { w, now } = await story();
  const { record } = await buildRecord(w.db, {}, facts(w, now));
  const plan = record.plans[0];
  assert.ok(plan);
  assert.equal(plan.state, "done");
  assert.equal(plan.confirmedBy, OWNER);
  assert.ok(plan.portalReceipt, "the receipt id is kept: Portal keeps the receipt for 90 days");
  assert.ok(plan.portalDraft);
  const core = plan.steps.find((s) => s.phase === "core");
  assert.ok(core && core.state === "done" && core.store === "Portal");
  assert.deepEqual(Object.keys(core.outcome as object).sort(), ["agt", "configRevision", "offboardedAt", "paused", "removedEdges", "revokedCodes", "revokedConnections"], "Portal's answer for the step is copied");
  const revoke = plan.steps.filter((s) => s.op === "access_revoke");
  assert.ok(revoke.length > 0, "the plan ended an item at the store");
  assert.ok(revoke.every((s) => s.state === "done" && s.store === "Connect" && Date.parse(s.at) > 0), "each store step keeps its state, its time and the store's name: a store keeps no receipt we copy");
  assert.ok(record.events.some((e) => e.plan === plan.group));
});

test("R8: the chain breaks on an edited event, and the file says where; a missing hash on a later row breaks it too", async () => {
  const { w, now } = await story();
  const before = await buildRecord(w.db, {}, facts(w, now));
  assert.equal(before.record.integrity.chain.ok, true);
  w.db.exec("DROP TRIGGER fleet_lifecycle_events_no_update");
  w.db.prepare("UPDATE fleet_lifecycle_events SET note = 'edited' WHERE seq = (SELECT MIN(seq) FROM fleet_lifecycle_events WHERE prev_hash IS NOT NULL)").run();
  const after = await buildRecord(w.db, {}, facts(w, now));
  assert.equal(after.record.integrity.chain.ok, false);
  assert.ok(typeof after.record.integrity.chain.ok === "boolean" && "brokenAt" in after.record.integrity.chain);
  assert.notEqual(after.digest, before.digest);
});

test("an export is one event in the chain with the digest; a second export lists the first", async () => {
  const w = makeWorld();
  const call = (id: string, input: unknown, caller: object = { type: "person", id: OWNER, name: "o", mode: null }) =>
    (handlers as unknown as Record<string, { run(i: unknown, c: OpContext): Promise<Record<string, any>> }>)[id]?.run(input, { db: w.db, caller, log: { debug() {}, info() {}, warn() {}, error() {} }, topology: () => null, jobs: { enqueue: () => {} } } as unknown as OpContext) as Promise<Record<string, any>>;
  for (const caller of [{ type: "agent", id: HENRY, name: "Henry", mode: "free" }, { type: "app", id: "ins_x", product: "rules", listed: true }]) await assert.rejects(call("record_export", {}, caller), refused("no_access", 403));
  assert.equal((manifest.operations.find((o) => o.id === "record_export") as unknown as { audience: string }).audience, "person");
  const first = await call("record_export", {});
  const spec = manifest.operations.find((o) => o.id === "record_export") as unknown as { output: Parameters<typeof validateAgainstSchema>[0] };
  const v = validateAgainstSchema(spec.output, first as Json);
  assert.deepEqual(v.ok ? [] : v.errors, []);
  const note = String(w.db.prepare("SELECT note FROM fleet_lifecycle_events WHERE note LIKE 'Access record made%' ORDER BY seq DESC").get()?.note);
  assert.ok(note.endsWith(first.digest), "the digest is in the chain");
  const second = await call("record_export", {});
  assert.ok(second.record.events.some((e: { note: string | null }) => e.note?.includes(first.digest)), "the first export is in the second record");
  assert.equal(second.record.approvers.line, ONE_APPROVER);
  await assert.rejects(call("record_export", { from: "2020-01-01", to: "2026-10-30" }), refused("period_invalid", 400));
});

test("period: a default of 90 days, at most a year, a start before the end; no sweep in the period is an empty list, and nobody approved is said", async () => {
  const now = Date.UTC(2026, 9, 30);
  assert.deepEqual(periodOf({}, now), { from: now - 90 * 86_400_000, to: now });
  assert.equal(periodOf({ from: "2025-10-30T00:00:00Z" }, now).to - periodOf({ from: "2025-10-30T00:00:00Z" }, now).from, 365 * 86_400_000, "a year is the most");
  for (const bad of [{ from: "2026-10-02", to: "2026-10-01" }, { from: "nonsense" }, { from: "10/01/2026" }, { from: "2026-10-01 10:00" }, { from: "2025-01-01", to: "2026-10-01" }, { from: "2026-10-30T00:00:00Z", to: "2026-10-29T00:00:00Z" }]) assert.throws(() => periodOf(bad, now), refused("period_invalid", 400), JSON.stringify(bad));
  assert.equal(periodOf({ from: "2026-10-01", to: "2026-10-01" }, now).to - periodOf({ from: "2026-10-01", to: "2026-10-01" }, now).from, 86_400_000 - 1, "a date alone: the whole day for the end");
  assert.equal(periodOf({ from: "2026-10-01", to: "2030-01-01" }, now).to, now, "the end is never in the future");
  assert.equal(MAX_DAYS, 366);
  const empty = migratedDb();
  const { record } = await buildRecord(empty, {}, { findings: { lastSweepAt: null, storesRead: 0, unread: [], items: [] }, version: "t", now: T0 + 5 * HOUR });
  assert.deepEqual([record.sweeps.count, record.sweeps.lists, record.approvers.line], [0, [], NO_APPROVER]);
  assert.match(record.limits.join(" "), /No person approved/);
});

test("too big: past the caps the period is refused with a plain reason, never cut", async () => {
  const { w, now } = await story();
  await assert.rejects(buildRecord(w.db, {}, { ...facts(w, now), maxSweeps: 1 }), refused("record_too_big", 409));
  await assert.rejects(buildRecord(w.db, {}, { ...facts(w, now), maxRows: 3 }), refused("record_too_big", 409));
  await buildRecord(w.db, {}, { ...facts(w, now), maxSweeps: 2, maxRows: 100 });
});

test("sweeps before the change log began are listed with no list, and the file says so", async () => {
  const { w, now } = await story();
  w.db.prepare("UPDATE fleet_record_meta SET value = ? WHERE key = 'record_since'").run(String(T0 + 90 * 60_000));
  const { record } = await buildRecord(w.db, {}, facts(w, now));
  assert.deepEqual(record.sweeps.lists.map((l) => [l.listKept, l.items === null]), [[false, true], [true, false]]);
  assert.match(record.limits.join(" "), /1 sweeps in this period are before it and have no list/);
});

test("what the file holds about people is what it says: no email, title, tag or handle; no text an agent wrote; the owner's own words stay", async () => {
  const db = migratedDb();
  const s = seed(db);
  db.prepare("INSERT INTO fleet_exceptions (code, subject_kind, subject_id, reason, until, by_id, at) VALUES ('no_owner', 'person', ?, 'Accepted by the owner.', ?, 'per_owner', ?)").run(s.ann.id, Date.now() + 86_400_000, Date.now());
  requestReview(db, { kind: "agent", id: "agt_01J0000000000000000000000A" }, { subject: { kind: "person", id: s.ann.id }, why: "AGENT-WROTE-THIS" });
  const snap = (await import("../src/reviews.ts")).getReview(db, { subject: { kind: "person", id: s.ann.id } }).current;
  recordReview(db, OWNER, { subject: { kind: "person", id: s.ann.id }, verdict: "trusted", reason: "The owner knows her.", snapshotDigest: String(snap?.digest) });
  appendEvent(db, { subject: { kind: "person", id: s.ann.id, name: "Ann Example" }, kind: "changed", actor: { kind: "owner", id: OWNER }, note: "Moved to Ops.", at: Date.now() });
  const out = await buildRecord(db, {}, { findings: { lastSweepAt: null, storesRead: 0, unread: [], items: [] }, version: "t" });
  const text = JSON.stringify(out.record);
  for (const secret of SECRETS.filter((x) => !["Ann Example", "Agent A", "Support"].includes(x))) assert.ok(!text.includes(secret), `leaks: ${secret}`);
  for (const handle of ["U012ABCDEF", "123456", "W0BOT123", "UCY00001"]) assert.ok(!text.toLowerCase().includes(handle.toLowerCase()), `leaks the handle ${handle}`);
  assert.ok(!text.includes("AGENT-WROTE-THIS"));
  assert.ok(text.includes("Ann Example") && text.includes("The owner knows her.") && text.includes("Moved to Ops."), "names and the owner's own words are in, as the file says");
  assert.match(out.record.contents.includes.join(" "), /Names and ids/);
  assert.match(out.record.contents.excludes.join(" "), /Email addresses/);
  assert.match(out.record.contents.decision, /Nobody checked this against a law/);
});

const verdictPlan = (w: World, over: Record<string, unknown>) => w.db.prepare("UPDATE fleet_plans SET state = ? WHERE id = (SELECT id FROM fleet_plans ORDER BY opened_at DESC LIMIT 1)").run(String(over.state));

test("time to stop is given only when every plan is done, every app was read, every step that ends something is proved and nothing was kept; else the file says why", async () => {
  const { w, marked, now } = await story();
  const stop = async () => (await buildRecord(w.db, {}, facts(w, now))).record.timeToStop[0] as { seconds: number | null; stoppedAt: string | null; note: string | null; steps: { kept: number; unread: number } };
  assert.ok((await stop()).seconds !== null, "quiet on good: the story is a proved stop");
  const plan = String(w.db.prepare("SELECT id FROM fleet_plans").get()?.id);
  // an app that was not read: its read step is not final
  w.db.prepare("UPDATE fleet_plan_steps SET state = 'not_read' WHERE plan_id = ? AND phase = 'read' AND target = 'kanban'").run(plan);
  let out = await stop();
  assert.deepEqual([out.seconds, out.stoppedAt, out.steps.unread], [null, null, 1]);
  assert.match(String(out.note), /An app was not read/);
  w.db.prepare("UPDATE fleet_plan_steps SET state = 'done' WHERE plan_id = ? AND phase = 'read'").run(plan);
  // an item the owner kept or the plan only listed
  w.db.prepare("UPDATE fleet_plan_steps SET state = 'listed' WHERE plan_id = ? AND op = 'access_revoke'").run(plan);
  out = await stop();
  assert.deepEqual([out.seconds, out.steps.kept], [null, 1]);
  assert.match(String(out.note), /kept or only listed/);
  w.db.prepare("UPDATE fleet_plan_steps SET state = 'done' WHERE plan_id = ? AND op = 'access_revoke'").run(plan);
  // a plan that is only reported, or still partial
  for (const state of ["reported", "partial"]) {
    verdictPlan(w, { state });
    out = await stop();
    assert.equal(out.seconds, null, state);
    assert.match(String(out.note), /A plan is not done/);
  }
  verdictPlan(w, { state: "done" });
  // a verdict plan made later is not a stop: it does not move the time
  w.db.prepare("INSERT INTO fleet_plans (id, group_id, subject_kind, subject_id, subject_name, purpose, trigger_kind, lifecycle_rev, state, rail, plan_digest, expires_in_sec, opened_at, updated_at) VALUES ('pln_review', 'pln_review', 'agent', ?, 'Henry', 'review', 'owner', 0, 'done', 'none', 'd', 1, ?, ?)").run(HENRY, marked + 3_600_000, marked + 3_600_000);
  w.db.prepare("INSERT INTO fleet_plan_steps (id, plan_id, n, phase, target, op, state, updated_at) VALUES ('pst_late', 'pln_review', 0, 'now', 'connect', 'access_revoke', 'done', ?)").run(marked + 3_600_000);
  assert.ok(((await stop()).seconds ?? 99_999) < 3_000, "the late verdict plan is left out");
  assert.equal(marked > 0, true);
});

test("who approved: a plan that was taken back or refused approves nothing; making a round or this record approves nothing; a second person, and what the system did", async () => {
  const { w, now } = await story();
  let line = (await buildRecord(w.db, {}, facts(w, now))).record.approvers;
  assert.deepEqual([line.count, line.systemMade, line.line], [1, 0, ONE_APPROVER]);
  // round, close, export: workspace events by the owner
  appendEvent(w.db, { subject: { kind: "workspace", id: "", name: "Governance" }, kind: "changed", actor: { kind: "owner", id: "per_second" }, note: "Review round started: rnd_x.", at: now - 1000 });
  assert.equal((await buildRecord(w.db, {}, facts(w, now))).record.approvers.count, 1, "a round is not an approval");
  // a plan the owner's second sign-in made and took back
  w.db.prepare("INSERT INTO fleet_plans (id, group_id, subject_kind, subject_id, subject_name, purpose, trigger_kind, actor_id, lifecycle_rev, state, rail, plan_digest, expires_in_sec, opened_at, updated_at) VALUES ('pln_back', 'pln_back', 'agent', ?, 'Henry', 'suspend', 'owner', 'per_second', 0, 'withdrawn', 'draft', 'd', 1, ?, ?)").run(HENRY, now - 2000, now - 2000);
  assert.equal((await buildRecord(w.db, {}, facts(w, now))).record.approvers.count, 1, "withdrawn: not an approval");
  w.db.prepare("UPDATE fleet_plans SET state = 'done' WHERE id = 'pln_back'").run();
  line = (await buildRecord(w.db, {}, facts(w, now))).record.approvers;
  assert.deepEqual([line.count, line.line], [2, manyApprovers(2)]);
  // the system's own stop
  w.db.prepare("INSERT INTO fleet_plans (id, group_id, subject_kind, subject_id, subject_name, purpose, trigger_kind, lifecycle_rev, state, rail, plan_digest, expires_in_sec, opened_at, updated_at) VALUES ('pln_sys', 'pln_sys', 'agent', ?, 'Henry', 'suspend', 'system', 0, 'waiting', 'draft', 'd', 1, ?, ?)").run(HENRY, now - 500, now - 500);
  line = (await buildRecord(w.db, {}, facts(w, now))).record.approvers;
  assert.equal(line.systemMade, 1);
  assert.match(line.line, /1 changes were made by the system, and no person approved them in Governance\./);
});

test("Portal's answer for a step is copied whole, a long one too; and the chain walk in pages gives the same answer as the whole walk, and breaks where it breaks", async () => {
  const { w, now } = await story();
  const big = JSON.stringify({ agt: HENRY, note: "x".repeat(1500) });
  w.db.prepare("UPDATE fleet_plan_steps SET output_json = ? WHERE phase = 'core'").run(big);
  const core = (await buildRecord(w.db, {}, facts(w, now))).record.plans[0]?.steps.find((s) => s.phase === "core");
  assert.deepEqual(core?.outcome, JSON.parse(big), "not cut, still an object");
  // pages of 2 over a chain of many rows
  for (let i = 0; i < 7; i++) appendEvent(w.db, { subject: { kind: "workspace", id: "", name: "G" }, kind: "changed", actor: { kind: "owner", id: "per_owner" }, note: `n${i}`, at: now + i });
  const whole = verifyChain(w.db);
  assert.deepEqual(await verifyChainPaged(w.db, 2), whole);
  assert.equal(whole.ok, true);
  w.db.exec("DROP TRIGGER fleet_lifecycle_events_no_update");
  const mid = Number(w.db.prepare("SELECT seq FROM fleet_lifecycle_events ORDER BY seq LIMIT 1 OFFSET 12").get()?.seq);
  w.db.prepare("UPDATE fleet_lifecycle_events SET note = 'edited' WHERE seq = ?").run(mid);
  const broken = await verifyChainPaged(w.db, 2);
  assert.deepEqual(broken, verifyChain(w.db));
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false ? broken.brokenAt : 0, mid + 1, "the row after the edited one no longer matches its predecessor");
});

test("the list of a sweep follows the log up to the sweep's watermark, not a clock: two sweeps in one millisecond keep their own lists; a sweep with no watermark has no list", async () => {
  const db = migratedDb();
  db.prepare("UPDATE fleet_record_meta SET value = '0' WHERE key = 'record_since'").run();
  const row = (seq: number, sweep: string, change: string, item: string) => db.prepare("INSERT INTO fleet_access_history (seq, sweep_id, at, change, target, item_id, kind, subject_kind, resource, direction, level, label, state, revocable, digest) VALUES (?, ?, 1000, ?, 'evolution', ?, 'routine', 'unlinked', 'r', 'held_by', 'use', 'L', 'active', 1, 'd')").run(seq, sweep, change, item);
  db.prepare("INSERT INTO fleet_sweeps (id, started_by, started_at, finished_at, calls, stores_read, history_seq) VALUES ('swp_1', 'schedule', 900, 1000, 4, 4, 2), ('swp_2', 'schedule', 1000, 1000, 4, 4, 3), ('swp_0', 'schedule', 1, 2, 4, 4, NULL)").run();
  row(1, "swp_1", "appeared", "routine:a");
  row(2, "swp_1", "appeared", "routine:b");
  row(3, "swp_2", "ended", "routine:a"); // the same millisecond as swp_1's finish
  const { record } = await buildRecord(db, { from: "1970-01-01T00:00:00Z", to: "1970-01-02T00:00:00Z" }, { findings: { lastSweepAt: null, storesRead: 0, unread: [], items: [] }, version: "t", now: 86_400_000 });
  const lists = record.sweeps.lists;
  assert.deepEqual(lists.map((l) => l.id), ["swp_0", "swp_1", "swp_2"].sort((a, b) => (a === "swp_0" ? -1 : 0) + (b === "swp_0" ? 1 : 0)));
  const by = Object.fromEntries(lists.map((l) => [l.id, l]));
  assert.equal(by.swp_0?.listKept, false);
  const ref = (id: string) => itemRef(String(by.swp_1?.items?.[0]?.product), id);
  assert.deepEqual(by.swp_1?.items?.map((i) => i.id), [ref("routine:a"), ref("routine:b")], "swp_2's row is not in swp_1's list");
  assert.deepEqual(by.swp_2?.items?.map((i) => i.id), [ref("routine:b")]);
  assert.deepEqual(by.swp_2?.ended.map((i) => i.id), [ref("routine:a")]);
  assert.equal(JSON.stringify(lists).includes("routine:a"), false, "an app item id, which can hold a handle, is not in the file (N2-T3)");
});

test("a list of 2000 differences may be cut: the file says so", async () => {
  const w = makeWorld();
  const items = Array.from({ length: 2000 }, (_, i) => ({ code: "no_owner", text: `t${i}` }));
  const cut = await buildRecord(w.db, {}, { findings: { lastSweepAt: null, storesRead: 0, unread: [], items }, version: "t", now: T0 + HOUR });
  assert.equal(cut.record.findings.cut, true);
  assert.equal((await buildRecord(w.db, {}, { findings: { lastSweepAt: null, storesRead: 0, unread: [], items: items.slice(0, 5) }, version: "t", now: T0 + HOUR })).record.findings.cut, false);
});
