// The date timer (C380, DESIGN-C380 §2, T3). A passed end date stops the entry; a passed start date lifts the refusal. Two ticks must
// agree on the same date, so one wrong clock reading stops nothing. One synchronous transaction per subject: no check-then-write
// across an await, and each tick reads the rows again, so a restart resumes by itself (it needs two new ticks).
// A system stop obeys the same cap as an owner stop (S2-7): a page script cannot stop everyone by typing dates. What waits shows as finding `date_passed`.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { SubjectKind } from "./states.ts";
import { capState, startDatePassed, transition } from "./transitions.ts";

export const TICK_MS = 60_000;
export const FIRST_TICK_MS = 5_000;
const SYSTEM = { kind: "system", id: null } as const;

type Seen = Set<string>;
const dated = (db: Db, column: "valid_until" | "valid_from", now: number): { kind: SubjectKind; id: string; at: number }[] => {
  const states = column === "valid_until" ? "('active', 'proposed')" : "('active', 'proposed', 'suspended', 'leaving', 'archived')";
  const rows = [
    ...db.prepare(`SELECT 'agent' AS kind, id, ${column} AS at FROM fleet_agents WHERE ${column} IS NOT NULL AND ${column} <= ? AND lifecycle IN ${states}`).all(now),
    ...db.prepare(`SELECT 'person' AS kind, id, ${column} AS at FROM fleet_people WHERE ${column} IS NOT NULL AND ${column} <= ? AND lifecycle IN ${states}`).all(now),
  ];
  return rows.map((r) => ({ kind: r.kind as SubjectKind, id: String(r.id), at: Number(r.at) }));
};

export interface TickResult {
  stopped: number;
  started: number;
  waiting: number;
}

/** One tick. `seen` holds what the last tick saw and is replaced by what this one saw. */
export function tickDates(db: Db, seen: Seen, now = Date.now()): TickResult {
  const out: TickResult = { stopped: 0, started: 0, waiting: 0 };
  const next: Seen = new Set();
  for (const r of dated(db, "valid_from", now)) {
    const key = `from:${r.kind}:${r.id}:${r.at}`;
    next.add(key);
    if (!seen.has(key)) continue;
    startDatePassed(db, r.kind, r.id, now);
    next.delete(key);
    out.started++;
  }
  for (const r of dated(db, "valid_until", now)) {
    const key = `until:${r.kind}:${r.id}:${r.at}`;
    next.add(key);
    if (!seen.has(key)) continue;
    const { used, limit } = capState(db, now);
    if (used >= limit) {
      out.waiting++;
      continue;
    }
    transition(db, { kind: r.kind, id: r.id, to: "suspended", reason: "contract_ended", note: "The end date passed.", actor: SYSTEM }, now);
    next.delete(key);
    out.stopped++;
  }
  seen.clear();
  for (const k of next) seen.add(k);
  return out;
}

export function startDatesTimer(db: Db, log: { warn(msg: string, f?: Record<string, string>): void }, everyMs = TICK_MS, firstMs = FIRST_TICK_MS): () => void {
  const seen: Seen = new Set();
  const tick = () => {
    try {
      tickDates(db, seen);
    } catch (e) {
      log.warn("lifecycle date tick failed", { reason: e instanceof Error ? e.message.slice(0, 200) : "error" });
    }
  };
  const first = setTimeout(tick, firstMs);
  first.unref();
  const t = setInterval(tick, everyMs);
  t.unref();
  return () => {
    clearTimeout(first);
    clearInterval(t);
  };
}
