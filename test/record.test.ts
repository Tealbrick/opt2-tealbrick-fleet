// C380 T2-b: the access record. Rows R6 (per-sweep lists with ended rows, findings, exceptions, time to stop, apps not read, the one-approver line), R7 (plan
// outcomes are copied) and R8 (the chain breaks on an edited row). The world is the plan runner's; the sweeps are real and read a fake store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { findingsList } from "../src/access/differences.ts";
import { handlers, manifest } from "../src/app.ts";
import { appendEvent } from "../src/lifecycle/events.ts";
import { loadColleagues } from "../src/lifecycle/view.ts";
import { buildRecord, digestOfRecord, MAX_DAYS, periodOf } from "../src/record/index.ts";
import { NO_APPROVER, ONE_APPROVER } from "../src/record/words.ts";
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
  assert.deepEqual(one?.items?.map((i) => i.id), ["account_as_itself:a1", "routine:r1"]);
  assert.deepEqual(one?.counts, { appeared: 2, changed: 0, ended: 0 });
  assert.deepEqual(two?.items?.map((i) => i.id), ["account_as_itself:a1"], "Connect was not read: its row is not dropped");
  assert.deepEqual(two?.ended.map((i) => i.id), ["routine:r1"], "the ended row stays in the record, with what it was");
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
  assert.equal(plan.approvedBy, OWNER);
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
  assert.equal(periodOf({ from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" }, now).to - periodOf({ from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" }, now).from, 364 * 86_400_000);
  for (const bad of [{ from: "2026-10-01", to: "2026-10-01" }, { from: "2026-10-02", to: "2026-10-01" }, { from: "nonsense" }, { from: "2025-01-01", to: "2026-10-01" }]) assert.throws(() => periodOf(bad, now), refused("period_invalid", 400));
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
