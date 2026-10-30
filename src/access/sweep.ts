// The full read of the stores (C380, DESIGN-C380 §4), as SDK handler jobs: lease, checkpoint, restart and resume from the cursor are the
// SDK's. One call per tick, so the event loop is free between pages and `fleet_facts` stays fast. Per target: one `all` read, then the
// named people for a kind the `all` answer lists in `notShown`, all under one sweepId. Fleet changes nothing outside its own copy.
//
// Deletion rule (ACCESS.md): a row goes only after the target's read reached `nextCursor: null` under this sweep, never for a kind in the
// `notShown` of the answer that covered its subject, and never when it was seen after this sweep began.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db, JobContext, JobOutcome, Json } from "@opt2-tealbrick/miniapp-sdk";
import { type AccessEnv, absentAnswer, inBackoff, noteRead, noteStop, presence, readPage } from "./client.ts";
import { noteEnded, noteSweepStores } from "./history.ts";
import { ACCESS_TARGETS, type AccessItem, type AccessTarget, LIST_LIMITS, type ListSubject, type NotShown, onlyAsked, personSubject, storeItems, TARGET_KINDS } from "./items.ts";

export const SWEEP_JOB = "access_sweep";
export const SWEEP_CRON_JOB = "access_sweep_cron";
export const SWEEP_CRON = "17 */6 * * *";
export const PAGE_CAP = 50;
export const CALL_CAP = 2000;
export const WAIT_CAP = 6;
export const KEPT_CAP = 64;
const KEPT_REASON_CHARS = 120;
const ACTIVE = ["queued", "running", "waiting", "paused"] as const;

interface SweepState {
  sweepId: string;
  at: number;
  by: string;
  i: number;
  phase: "all" | "people";
  cursor: string | null;
  /** the last person of the batch before `batch` */
  after: string;
  batch: string[];
  pages: number;
  calls: number;
  waits: number;
  read: number;
  /** kinds in `notShown` of the `all` answer, and of any people answer */
  keptAll: NotShown[];
  keptPeople: NotShown[];
}

export type SweepEnv = AccessEnv & Pick<JobContext, "db" | "job" | "checkpoint"> & { now?: () => number };

/** Rows of this target not seen by this sweep, except what the rule keeps. Runs in the transaction of the last page. */
export function deleteUnseen(db: Db, target: AccessTarget, s: Pick<SweepState, "sweepId" | "at" | "phase" | "after" | "keptAll" | "keptPeople">, endedAt = Date.now()): number {
  const coveredByPeople = s.phase === "people";
  const keptAll = new Set(s.keptAll.map((n) => n.kind));
  const keptPeople = new Set(s.keptPeople.map((n) => n.kind));
  const rows = db.prepare("SELECT * FROM fleet_access_items WHERE target = ? AND last_seen < ? AND last_sweep IS NOT ?").all(target, s.at, s.sweepId);
  const people = rows.some((r) => keptAll.has(String(r.kind))) ? new Set(db.prepare("SELECT id FROM fleet_people WHERE kind = 'person'").all().map((r) => String(r.id))) : new Set<string>();
  const del = db.prepare("DELETE FROM fleet_access_items WHERE target = ? AND item_id = ?");
  let n = 0;
  for (const r of rows) {
    const kind = String(r.kind);
    // Not in the `all` answer: only a people answer covered it, and only for a person who was asked about.
    if (keptAll.has(kind) && (!coveredByPeople || keptPeople.has(kind) || r.subject_kind !== "person" || !people.has(String(r.subject_id)) || String(r.subject_id) > s.after)) continue;
    noteEnded(db, s.sweepId, endedAt, target, r);
    del.run(target, r.item_id);
    n++;
  }
  return n;
}

const nextBatch = (db: Db, after: string): string[] =>
  db
    .prepare("SELECT id FROM fleet_people WHERE kind = 'person' AND id > ? ORDER BY id LIMIT ?")
    .all(after, LIST_LIMITS.subjects)
    .map((r) => String(r.id));

const nextTarget = (s: SweepState): SweepState => ({ ...s, i: s.i + 1, phase: "all", cursor: null, after: "", batch: [], pages: 0, waits: 0, keptAll: [], keptPeople: [] });
const addKept = (list: readonly NotShown[], more: readonly NotShown[]): NotShown[] => {
  const out = [...list];
  for (const m of more) if (!out.some((l) => l.kind === m.kind)) out.push({ kind: m.kind, reason: Array.from(m.reason).slice(0, KEPT_REASON_CHARS).join("") });
  return out;
};

/** One tick: at most one call, then one transaction. `again` hands the event loop back. */
export async function sweepTick(_input: Json, env: SweepEnv): Promise<JobOutcome> {
  const now = env.now ?? Date.now;
  const manual = (env.job.input as { by?: unknown } | null)?.by === "manual";
  let s = env.job.state as unknown as SweepState | null;
  if (!s?.sweepId) {
    const at = now();
    const fresh: SweepState = { sweepId: `swp_${ulid(at)}`, at, by: manual ? "manual" : "schedule", i: 0, phase: "all", cursor: null, after: "", batch: [], pages: 0, calls: 0, waits: 0, read: 0, keptAll: [], keptPeople: [] };
    env.checkpoint(fresh as unknown as Json, (db) => {
      db.prepare("INSERT INTO fleet_sweeps (id, started_by, started_at) VALUES (?, ?, ?)").run(fresh.sweepId, fresh.by, at);
    });
    s = fresh;
  }
  for (;;) {
    const cur: SweepState = s;
    const target = ACCESS_TARGETS[cur.i];
    if (target === undefined) {
      env.checkpoint(cur as unknown as Json, (db) => {
        db.prepare("UPDATE fleet_sweeps SET finished_at = ?, calls = ?, stores_read = ? WHERE id = ?").run(now(), cur.calls, cur.read, cur.sweepId);
        noteSweepStores(db, cur.sweepId);
      });
      return { status: "done", result: { sweepId: cur.sweepId, storesRead: cur.read, calls: cur.calls } };
    }
    if (cur.phase === "all" && cur.pages === 0) {
      const there = presence(env, target);
      const held = there === "present" ? inBackoff(env.db, target, now(), manual) : null;
      if (there !== "present" || held) {
        const next = nextTarget(cur);
        // A backoff keeps its stored state and its end. A store that is not there does not.
        env.checkpoint(next as unknown as Json, (db) => {
          if (there !== "present") noteStop(db, target, absentAnswer(there), now());
        });
        s = next;
        continue;
      }
    }
    if (cur.pages >= PAGE_CAP || cur.calls >= CALL_CAP) {
      const next = nextTarget(cur);
      env.checkpoint(next as unknown as Json, (db) => noteStop(db, target, { state: "not_read", code: "too_long", text: "This app has more to list than Governance reads at once." }, now()));
      s = next;
      continue;
    }
    return tick(env, cur, target, now);
  }
}

async function tick(env: SweepEnv, s: SweepState, target: AccessTarget, now: () => number): Promise<JobOutcome> {
  const batch = s.phase === "people" && s.batch.length === 0 ? nextBatch(env.db, s.after) : s.batch;
  // Every person left since the last batch: nothing to ask, and the read is complete.
  if (s.phase === "people" && batch.length === 0) {
    finishTarget(env, s, target, [], now());
    return { status: "again" };
  }
  const subjects: ListSubject[] = s.phase === "all" ? [{ kind: "all" }] : batch.map((id) => personSubject(env.db, id));
  const answer = await readPage(env, target, { v: 1, subjects, limit: LIST_LIMITS.limit, sweepId: s.sweepId, ...(s.cursor === null ? {} : { cursor: s.cursor }) });
  const at = now();
  const calls = s.calls + 1;
  if (!answer.ok) {
    if (answer.waitMs > 0 && s.waits < WAIT_CAP) {
      env.checkpoint({ ...s, calls, waits: s.waits + 1 } as unknown as Json);
      return { status: "again", afterMs: answer.waitMs };
    }
    // No retry inside a sweep and no delete: the old rows stay, and the store says it was not read.
    env.checkpoint({ ...nextTarget(s), calls } as unknown as Json, (db) => noteStop(db, target, answer, at));
    return { status: "again" };
  }
  const page = answer.page;
  const items = onlyAsked(page.items, subjects);
  // Every page counts: a kind one page could not list is not listed by the others, even when the last page has no `notShown`.
  const keptAll = s.phase === "all" ? addKept(s.keptAll, page.notShown) : s.keptAll;
  const keptPeople = s.phase === "people" ? addKept(s.keptPeople, page.notShown) : s.keptPeople;
  if (keptAll.length + keptPeople.length > KEPT_CAP) {
    // Each entry is in the job state, which has a limit. A list this long is no limit an app can state: not read, nothing deleted.
    env.checkpoint({ ...nextTarget(s), calls } as unknown as Json, (db) => noteStop(db, target, { state: "not_read", code: "bad_answer", text: "The app gave an answer Governance cannot use." }, at));
    return { status: "again" };
  }
  const base: SweepState = { ...s, calls, pages: s.pages + 1, waits: 0, batch, keptAll, keptPeople };
  if (page.nextCursor !== null) {
    const next = { ...base, cursor: page.nextCursor };
    env.checkpoint(next as unknown as Json, (db) => storeItems(db, target, items, s.sweepId, at));
    return { status: "again" };
  }
  if (s.phase === "all") {
    if (keptAll.some((n) => TARGET_KINDS[target].includes(n.kind))) {
      const next: SweepState = { ...base, cursor: null, phase: "people" };
      env.checkpoint(next as unknown as Json, (db) => storeItems(db, target, items, s.sweepId, at));
      return { status: "again" };
    }
    finishTarget(env, base, target, items, at);
    return { status: "again" };
  }
  const after = batch.at(-1) ?? s.after;
  const next: SweepState = { ...base, cursor: null, batch: [], after };
  env.checkpoint(next as unknown as Json, (db) => storeItems(db, target, items, s.sweepId, at));
  return { status: "again" };
}

/** The target's read reached the end: the last page, the deletion rule and the state in one transaction. */
function finishTarget(env: SweepEnv, s: SweepState, target: AccessTarget, items: readonly AccessItem[], at: number): void {
  const next: SweepState = { ...nextTarget(s), read: s.read + 1 };
  const coveredPerPerson = s.phase === "people" ? s.keptAll.filter((n) => TARGET_KINDS[target].includes(n.kind) && !s.keptPeople.some((p) => p.kind === n.kind)) : [];
  const shown = addKept(s.keptAll.filter((n) => !coveredPerPerson.includes(n)), s.keptPeople);
  env.checkpoint(next as unknown as Json, (db) => {
    storeItems(db, target, items, s.sweepId, at);
    deleteUnseen(db, target, s, at);
    noteRead(db, target, shown, at);
  });
}

/** A running or waiting sweep is enough. Sync: nothing can start between the check and the enqueue. */
export function startSweep(ctx: Pick<JobContext, "jobs">, by: "manual" | "schedule"): boolean {
  if (ctx.jobs.list({ kind: SWEEP_JOB, status: [...ACTIVE], limit: 1 }).length > 0) return false;
  ctx.jobs.enqueue(SWEEP_JOB, { by });
  return true;
}

export const lastSweepAt = (db: Db): number | null => {
  const v = db.prepare("SELECT MAX(finished_at) AS at FROM fleet_sweeps").get()?.at;
  return v === null || v === undefined ? null : Number(v);
};
