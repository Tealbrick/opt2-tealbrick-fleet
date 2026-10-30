// C380 B9b: the full read as a job. Deletion rule, restart, backoff, caps, and what never changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessEnv } from "../src/access/client.ts";
import { BACKOFF_MS, readStateOf, readStates } from "../src/access/client.ts";
import { type ListIn, storeItems, unlinkedCount } from "../src/access/items.ts";
import { lastSweepAt, PAGE_CAP, type SweepEnv, startSweep, sweepTick, WAIT_CAP } from "../src/access/sweep.ts";
import { revision } from "../src/meta.ts";
import * as store from "../src/store.ts";
import { AGT, accessEnv, answer, fakeStores, wire } from "./access-helpers.ts";
import { migratedDb } from "./helpers.ts";

/** A job context as the SDK gives it: `checkpoint` writes the state and the app's rows in one transaction, and a restart reads the state back. */
export function jobEnv(db: Db, base: AccessEnv, by: "manual" | "schedule" = "schedule", clock: { now: number } = { now: 1_000_000 }) {
  const held: { state: Json | null } = { state: null };
  const env: SweepEnv = {
    ...base,
    db,
    now: () => clock.now++,
    job: { input: { by }, get state() { return held.state; } } as unknown as SweepEnv["job"],
    checkpoint: ((state: Json, write?: (d: Db) => unknown) =>
      db.transaction(() => {
        const out = write?.(db);
        held.state = state;
        return out;
      })) as SweepEnv["checkpoint"],
  };
  return { env, held, clock };
}

const NONE = { status: "ok", output: { v: 1, asOf: "2026-10-30T16:00:00Z", items: [], nextCursor: null, notShown: [], complete: true } };
const quiet = { connect: () => NONE, knowledge: () => NONE, kanban: () => NONE, evolution: () => NONE };

async function run(env: SweepEnv, max = 400): Promise<{ afterMs: number[]; ticks: number; result: unknown }> {
  const afterMs: number[] = [];
  for (let ticks = 1; ticks <= max; ticks++) {
    const out = await sweepTick({}, env);
    if (out?.status === "done") return { afterMs, ticks, result: out.result };
    if (out?.status === "again" && out.afterMs) afterMs.push(out.afterMs);
  }
  throw new Error("the sweep did not end");
}
/** A new job over the same database: the sweep before it is over. */
const sweep = async (db: Db, replies: Parameters<typeof fakeStores>[0], clock = { now: 1_000_000 }, by: "manual" | "schedule" = "schedule", targets?: string[]) => {
  const f = fakeStores({ ...quiet, ...replies });
  const { env } = jobEnv(db, accessEnv(f.callApp, targets), by, clock);
  return { ...(await run(env)), calls: f.calls };
};
const ids = (db: Db, target: string) => db.prepare("SELECT item_id FROM fleet_access_items WHERE target = ? ORDER BY item_id").all(target).map((r) => String(r.item_id));
const routine = (id: string, subject: { kind: "agent"; id: string } = { kind: "agent", id: AGT }) => wire("evolution", { id: `routine:${id}`, kind: "routine", subject, resource: id });
const notShown = [{ kind: "held_calls", reason: "This version cannot list held calls." }];

test("a sweep stores what each store reports under the target called, says what it read, and moves no feed revision", async () => {
  const db = migratedDb();
  const rev = revision(db);
  const r = await sweep(db, { evolution: () => answer([routine("a")], { notShown }), kanban: () => answer([wire("kanban", { id: "assignment:i", kind: "assignment", level: "info", revocable: false })]) });
  assert.deepEqual(ids(db, "evolution"), ["routine:a"]);
  assert.deepEqual(ids(db, "kanban"), ["assignment:i"]);
  assert.equal(revision(db), rev);
  assert.deepEqual(readStates(db).map((s) => [s.target, s.state]), [["connect", "read"], ["evolution", "read"], ["kanban", "read"], ["knowledge", "read"]]);
  assert.deepEqual(readStateOf(db, "evolution")?.notShown, notShown);
  assert.equal(new Set(r.calls.map((c) => c.input.sweepId)).size, 1, "one sweepId");
  assert.ok(lastSweepAt(db));
  const row = db.prepare("SELECT calls, stores_read, started_by FROM fleet_sweeps").get();
  assert.deepEqual([row?.calls, row?.stores_read, row?.started_by], [4, 4, "schedule"]);
});

test("deletion: a row a full read no longer lists goes; first_seen stays on a row that is listed again", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { evolution: () => answer([routine("a"), routine("b")]) }, clock);
  const first = db.prepare("SELECT first_seen FROM fleet_access_items WHERE item_id = 'routine:a'").get()?.first_seen;
  await sweep(db, { evolution: () => answer([routine("a")]) }, clock);
  assert.deepEqual(ids(db, "evolution"), ["routine:a"]);
  const row = db.prepare("SELECT first_seen, last_seen FROM fleet_access_items WHERE item_id = 'routine:a'").get();
  assert.equal(row?.first_seen, first);
  assert.ok(Number(row?.last_seen) > Number(first));
});

test("deletion: a failure on any page deletes nothing, and the store reads not_read with its old time", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { evolution: () => answer([routine("a"), routine("b")]) }, clock);
  const readAt = readStateOf(db, "evolution")?.readAt;
  for (const fail of [() => { throw new TbError("app_error", "down", 503); }, (i: ListIn) => { if (i.cursor) throw new TbError("app_error", "down", 503); return answer([routine("a")], { nextCursor: "c2" }); }]) {
    await sweep(db, { evolution: fail }, clock);
    assert.deepEqual(ids(db, "evolution"), ["routine:a", "routine:b"]);
    const s = readStateOf(db, "evolution");
    assert.equal(s?.state, "not_read");
    assert.equal(s?.readAt, readAt);
  }
});

test("deletion: never for a kind in notShown of the answer that covered the subject", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  const ann = store.setPerson(db, { name: "Ann", handles: ["slack:u012abcdef"] });
  const area = wire("knowledge", { id: "person_area:x", kind: "person_area", resource: "x", level: "read", revocable: false });
  const grant = wire("knowledge", { id: "team_grant:g", kind: "team_grant", subject: { kind: "person", id: ann.id }, resource: "g", direction: "about", level: "read" });
  await sweep(db, { knowledge: () => answer([area, grant]) }, clock);
  // Knowledge lost its directory: person_area is in notShown of every answer. Its row stays, the grant goes.
  const lost = { notShown: [{ kind: "person_area", reason: "no copy" }] };
  const r = await sweep(db, { knowledge: () => answer([], lost) }, clock);
  assert.deepEqual(ids(db, "knowledge"), ["person_area:x"]);
  assert.equal(r.calls.filter((c) => c.target === "knowledge").length, 2, "one all, one batch of people");
  assert.deepEqual(readStateOf(db, "knowledge")?.notShown, lost.notShown, "a stated limit");
  assert.equal(readStateOf(db, "knowledge")?.state, "read", "complete: false from notShown is not an error");
});

test("deletion: notShown of any page counts, not only of the last page", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  const area = wire("knowledge", { id: "person_area:x", kind: "person_area", resource: "x", level: "read", revocable: false });
  await sweep(db, { knowledge: () => answer([area]) }, clock);
  // Page 1: the store's directory is old, person_area is not listed. Page 2: it is current again and lists nothing after the cursor.
  await sweep(db, { knowledge: (i) => (i.cursor ? answer([]) : answer([], { nextCursor: "c2", notShown: [{ kind: "person_area", reason: "old" }] })) }, clock);
  assert.deepEqual(ids(db, "knowledge"), ["person_area:x"]);
});

test("deletion: the sweep's own rows stay when the clock steps back in the sweep", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { evolution: () => answer([routine("a")]) }, clock);
  const f = fakeStores({ ...quiet, evolution: () => answer([routine("a")]) });
  const stepped = { now: 2_000_000 };
  const { env } = jobEnv(db, accessEnv(f.callApp), "schedule", stepped);
  for (let i = 0; i < 3; i++) await sweepTick({}, env);
  stepped.now = 500_000;
  await run(env);
  assert.deepEqual(ids(db, "evolution"), ["routine:a"]);
});

test("an answer with too many kinds in notShown reads not_read and deletes nothing; the job state stays under its limit", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { evolution: () => answer([routine("a")]) }, clock);
  const many = (n: number) => Array.from({ length: 32 }, (_, i) => ({ kind: `k${n}_${i}`, reason: "\u{1f600}".repeat(200) }));
  const f = fakeStores({ ...quiet, evolution: (i) => { const n = Number(i.cursor ?? 0); return answer([], { nextCursor: String(n + 1), notShown: many(n) }); } });
  const { env, held } = jobEnv(db, accessEnv(f.callApp), "schedule", clock);
  let largest = 0;
  for (let t = 0; t < 12; t++) {
    await sweepTick({}, env);
    largest = Math.max(largest, Buffer.byteLength(JSON.stringify(held.state)));
  }
  assert.ok(largest < 64 * 1024, String(largest));
  assert.equal(readStateOf(db, "evolution")?.code, "bad_answer");
  assert.deepEqual(ids(db, "evolution"), ["routine:a"]);
});

test("per person: the all answer leaves channel_sender out; the named people cover it, and only those people can lose a row", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  const ann = store.setPerson(db, { name: "Ann", handles: ["slack:u012abcdef"] });
  const bo = store.setPerson(db, { name: "Bo", handles: ["slack:u0bo00001"] });
  store.setPerson(db, { name: "Bot", kind: "outside_agent", handles: ["slack:w0bot123"] });
  const sender = (p: string, h: string) => wire("connect", { id: `channel_sender:${h}`, kind: "channel_sender", subject: { kind: "person", id: p }, resource: h });
  const swept = { notShown: [...notShown, { kind: "channel_sender", reason: "Ask with the person and their handles." }] };
  const connect = (keep: Set<string>) => (i: ListIn) => (i.subjects[0]?.kind === "all" ? answer([], swept) : answer(i.subjects.flatMap((s) => (s.kind === "person" && keep.has(s.id) ? s.handles.map((h) => sender(s.id, h)) : [])), { notShown }));
  const r = await sweep(db, { connect: connect(new Set([ann.id, bo.id])) }, clock);
  assert.equal(ids(db, "connect").length, 2);
  const named = r.calls.filter((c) => c.target === "connect")[1]?.input.subjects;
  assert.deepEqual(named?.map((s) => (s.kind === "person" ? s.id : s.kind)).sort(), [ann.id, bo.id].sort(), "people only, no outside agent");
  assert.deepEqual(readStateOf(db, "connect")?.notShown, notShown, "channel_sender is covered, so it is no limit");
  // A row of someone Governance no longer has: nobody asked, so it stays and reads as an orphan later.
  storeItems(db, "connect", [{ ...sender("psn_gone", "slack:U0GONE001"), since: null }], "old", 1);
  await sweep(db, { connect: connect(new Set([ann.id])) }, clock);
  assert.deepEqual(ids(db, "connect"), ["channel_sender:slack:U012ABCDEF", "channel_sender:slack:U0GONE001"], "Bo's row went, the unasked one stayed");
});

test("people answers: 32 per call in pages, a row about someone else in the batch is dropped", async () => {
  const db = migratedDb();
  const people = Array.from({ length: 33 }, (_, i) => store.setPerson(db, { name: `P${i}` }).id);
  const stranger = wire("connect", { id: "channel_sender:slack:U0STRANGE", kind: "channel_sender", subject: { kind: "person", id: "psn_stranger" }, resource: "slack:U0STRANGE" });
  const swept = { notShown: [{ kind: "channel_sender", reason: "per person" }] };
  const r = await sweep(db, { connect: (i) => (i.subjects[0]?.kind === "all" ? answer([], swept) : answer(i.cursor ? [] : [stranger], { nextCursor: i.cursor || i.subjects.length !== 32 ? null : "more" })) });
  const batches = r.calls.filter((c) => c.target === "connect").slice(1);
  assert.deepEqual(batches.map((c) => [c.input.subjects.length, c.input.cursor ?? null]), [[32, null], [32, "more"], [1, null]]);
  assert.deepEqual(batches[1]?.input.subjects, batches[0]?.input.subjects, "a cursor goes with the same subjects");
  assert.equal(new Set(batches.flatMap((c) => c.input.subjects.map((s) => (s.kind === "person" ? s.id : "")))).size, people.length);
  assert.deepEqual(ids(db, "connect"), []);
});

test("restart: a new tick resumes from the stored cursor; no call is lost and no row counts twice", async () => {
  const db = migratedDb();
  let crash = true;
  const f = fakeStores({ ...quiet, evolution: (i) => { if (i.cursor === "c2" && crash) { crash = false; throw new Error("process died"); } return i.cursor ? answer([routine("b")]) : answer([routine("a")], { nextCursor: "c2" }); } });
  const { env, held } = jobEnv(db, accessEnv(f.callApp));
  for (let i = 0; i < 4; i++) await sweepTick({}, env); // connect, knowledge, kanban, evolution page 1
  const saved = JSON.stringify(held.state);
  assert.ok(saved.includes('"cursor":"c2"'));
  // the crash ends this store for this sweep, as any failure does; the next sweep reads it again
  await run(env);
  assert.equal(readStateOf(db, "evolution")?.state, "not_read");
  assert.deepEqual(ids(db, "evolution"), ["routine:a"]);
  // A restart: the tick starts from the saved state with a new process.
  const f2 = fakeStores({ ...quiet, evolution: (i) => (i.cursor ? answer([routine("b")]) : answer([routine("x")])) });
  const again = jobEnv(db, accessEnv(f2.callApp));
  again.held.state = JSON.parse(saved);
  await run(again.env);
  assert.deepEqual(f2.calls.filter((c) => c.target === "evolution").map((c) => c.input.cursor), ["c2"], "only the page that was open");
  assert.equal(f2.calls.filter((c) => c.target === "connect").length, 0, "a store already read is not read again");
  assert.deepEqual(ids(db, "evolution"), ["routine:a", "routine:b"]);
  assert.equal(readStateOf(db, "evolution")?.state, "read");
});

test("refused and held: the sweep goes on, no new call in the backoff, manual repeats a refusal and never a hold", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { evolution: () => answer([routine("a")]) }, clock);
  const denied = () => { throw new TbError("hook_denied", "Refused by company policy", 403); };
  const held = () => ({ status: "held", holdId: "h1" });
  const r = await sweep(db, { evolution: denied, knowledge: held }, clock);
  assert.equal(r.calls.filter((c) => c.target === "kanban").length, 1, "the next store is still read");
  const refused = readStateOf(db, "evolution");
  assert.deepEqual([refused?.state, refused?.text], ["refused", "Refused by company policy"]);
  assert.ok(Number(refused?.backoffUntil) >= clock.now + BACKOFF_MS - 50);
  assert.equal(readStateOf(db, "knowledge")?.state, "waiting");
  assert.deepEqual(ids(db, "evolution"), ["routine:a"], "a refusal deletes nothing");
  const tick2 = await sweep(db, { evolution: denied, knowledge: held }, clock);
  assert.deepEqual(tick2.calls.map((c) => c.target).sort(), ["connect", "kanban"], "no call and no new hold in the backoff");
  assert.equal(readStateOf(db, "evolution")?.state, "refused", "the state stays");
  const manual = await sweep(db, { evolution: () => answer([routine("a")]), knowledge: held }, clock, "manual");
  assert.deepEqual(manual.calls.map((c) => c.target).sort(), ["connect", "evolution", "kanban"], "Check now repeats a refusal, not a hold");
  assert.equal(readStateOf(db, "evolution")?.state, "read");
  clock.now += BACKOFF_MS + 1;
  const later = await sweep(db, { knowledge: () => NONE }, clock);
  assert.equal(later.calls.length, 4, "the backoff ends");
});

test("429: the same page after the wait, no progress lost; past the cap the store is not_read", async () => {
  const db = migratedDb();
  let busy = 2;
  const r = await sweep(db, { kanban: () => { if (busy-- > 0) throw new TbError("rate_limited", "slow", 429, { retryAfterMs: 777 }); return answer([wire("kanban", { id: "assignment:i", kind: "assignment", level: "info", revocable: false })]); } });
  assert.deepEqual(r.afterMs, [777, 777]);
  assert.deepEqual(ids(db, "kanban"), ["assignment:i"]);
  assert.equal(readStateOf(db, "kanban")?.state, "read");
  const always = await sweep(db, { kanban: () => { throw new TbError("rate_limited", "slow", 429); } });
  assert.equal(always.afterMs.length, WAIT_CAP);
  assert.equal(readStateOf(db, "kanban")?.state, "not_read");
  assert.deepEqual(ids(db, "kanban"), ["assignment:i"]);
});

test("caps: 50 pages per target; a store that never ends reads not_read and deletes nothing, and the next store is read", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { connect: () => answer([wire("connect", { id: "buzz_identity:x", kind: "buzz_identity", level: "info", revocable: false })]) }, clock);
  const r = await sweep(db, { connect: (i) => answer([], { nextCursor: `${i.cursor ?? ""}n` }) }, clock);
  assert.equal(r.calls.filter((c) => c.target === "connect").length, PAGE_CAP);
  const s = readStateOf(db, "connect");
  assert.deepEqual([s?.state, s?.code], ["not_read", "too_long"]);
  assert.deepEqual(ids(db, "connect"), ["buzz_identity:x"]);
  assert.equal(r.calls.filter((c) => c.target === "evolution").length, 1);
});

test("not installed and not known: no call, its own words, old rows stay", async () => {
  const db = migratedDb();
  const clock = { now: 1_000_000 };
  await sweep(db, { evolution: () => answer([routine("a")]) }, clock);
  const r = await sweep(db, {}, clock, "schedule", ["connect", "knowledge", "kanban"]);
  assert.equal(r.calls.filter((c) => c.target === "evolution").length, 0);
  const s = readStateOf(db, "evolution");
  assert.deepEqual([s?.state, s?.text], ["not_installed", "This app is not installed."]);
  assert.deepEqual(ids(db, "evolution"), ["routine:a"]);
  const f = fakeStores(quiet);
  const noSlice = jobEnv(db, { ...accessEnv(f.callApp, []), topology: () => null }, "schedule", clock);
  await run(noSlice.env);
  assert.equal(readStateOf(db, "evolution")?.state, "not_read", "no current workspace copy");
  assert.equal(f.calls.length, 0);
});

test("a bad answer from one store is that store's problem", async () => {
  const db = migratedDb();
  await sweep(db, { connect: () => answer([{ ...wire("connect", { id: "buzz_identity:x", kind: "buzz_identity" }), digest: `sha256:${"1".repeat(64)}` }]), evolution: () => answer([routine("a")]) });
  assert.equal(readStateOf(db, "connect")?.code, "bad_answer");
  assert.deepEqual(ids(db, "connect"), []);
  assert.deepEqual(ids(db, "evolution"), ["routine:a"]);
});

test("an unlinked row is stored with no subject id, and only Connect's accounts count", async () => {
  const db = migratedDb();
  const acc = wire("connect", { id: "account_as_me:a", kind: "account_as_me", subject: { kind: "unlinked" }, resource: "a", revocable: false });
  await sweep(db, { connect: () => answer([acc]), evolution: () => answer([wire("evolution", { id: "routine:u", kind: "routine", subject: { kind: "unlinked" }, resource: "u" })]) });
  assert.equal(unlinkedCount(db), 1);
  assert.equal(db.prepare("SELECT subject_id FROM fleet_access_items WHERE item_id = 'account_as_me:a'").get()?.subject_id, null);
});

test("startSweep: a running sweep is enough; once it is over, a new one starts", () => {
  const seen: { kind?: string; input?: unknown }[] = [];
  let active = 0;
  const ctx = { jobs: { list: () => Array.from({ length: active }), enqueue: (kind: string, input: unknown) => { seen.push({ kind, input }); active = 1; } } } as unknown as Parameters<typeof startSweep>[0];
  assert.equal(startSweep(ctx, "manual"), true);
  assert.equal(startSweep(ctx, "manual"), false);
  active = 0;
  assert.equal(startSweep(ctx, "schedule"), true);
  assert.deepEqual(seen, [{ kind: "access_sweep", input: { by: "manual" } }, { kind: "access_sweep", input: { by: "schedule" } }]);
});

test("A45: a full page at the caps is one short transaction, so fleet_facts is not blocked", () => {
  const db = migratedDb();
  const items = Array.from({ length: 200 }, (_, i) => ({ ...wire("evolution", { id: `routine:${i}`, kind: "routine", resource: `r${i}` }), since: null }));
  db.transaction(() => storeItems(db, "evolution", items, "s", 1));
  const t = performance.now();
  db.transaction(() => storeItems(db, "evolution", items, "s", 2));
  assert.ok(performance.now() - t < 100, "under 100 ms");
});

test("reconcile_now: the owner starts one read, a running one is enough; an agent and an app are refused", async () => {
  const { handlers, definition } = await import("../src/app.ts");
  const list: unknown[] = [];
  const jobs = { list: () => list, enqueue: () => list.push(1) };
  const run = (caller: { type: string }) => (handlers as unknown as Record<string, { run: (i: unknown, c: unknown) => Promise<unknown> }>).reconcile_now?.run({}, { caller, jobs });
  assert.deepEqual(await run({ type: "person" }), { started: true });
  assert.deepEqual(await run({ type: "person" }), { started: false });
  for (const type of ["agent", "app"]) await assert.rejects(run({ type }) as Promise<unknown>, (e: unknown) => e instanceof TbError && e.code === "no_access" && e.httpStatus === 403);
  assert.deepEqual(Object.keys(definition.jobs ?? {}).sort(), ["access_sweep", "access_sweep_cron", "plans_tick"]);
});

test("onStart: the 6 h clock always, the first read only when none finished", async () => {
  const { definition } = await import("../src/app.ts");
  const db = migratedDb();
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const seen: { job: string; key: string | undefined }[] = [];
  const start = async () => {
    seen.length = 0;
    await definition.onStart?.({ db, log, callApp: async () => ({ status: "ok", output: {} }), schedule: (t: { job: string }, _w: unknown, o: { key?: string }) => seen.push({ job: t.job, key: o.key }) } as never);
    await definition.onStop?.({ db, log } as never);
    return seen.map((s) => s.job).filter((j) => j !== "plans_tick");
  };
  assert.deepEqual(await start(), ["access_sweep_cron", "access_sweep_cron"]);
  db.exec("INSERT INTO fleet_sweeps (id, started_by, started_at, finished_at) VALUES ('swp_1', 'schedule', 1, 2)");
  assert.deepEqual(await start(), ["access_sweep_cron"]);
});
