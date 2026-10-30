// The role date timer (C380 T2-a). A passed end date ENDS the assignment, with no action by anyone; a passed start date starts it. Two ticks must
// agree on the same date, so one wrong clock reading ends nothing. One synchronous transaction per assignment, no await, no call to another app.
// Each tick reads the rows again, so a restart resumes by itself (it needs two new ticks). Governance must run for this: with it down, a reader
// keeps its last copy for up to 10 minutes and then treats the facts as unavailable (a rule by role does not allow).
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { appendEvent } from "../lifecycle/events.ts";
import { bump } from "../meta.ts";

/** 30 s, so an end date shows in the feed within a minute and in Rules (which reads each minute) within two. */
export const ROLE_TICK_MS = 30_000;
export const ROLE_FIRST_TICK_MS = 5_000;
const SYSTEM = { kind: "system", id: null } as const;

export interface RoleTickResult {
  started: number;
  ended: number;
}

type Row = Record<string, unknown>;
const NAME = `COALESCE(CASE a.subject_kind WHEN 'agent' THEN (SELECT name FROM fleet_agents WHERE id = a.subject_id) ELSE (SELECT name FROM fleet_people WHERE id = a.subject_id) END, '(removed)')`;
const BASE = `SELECT a.id, a.subject_kind, a.subject_id, a.reason, a.valid_from, a.valid_until, r.name AS role_name, ${NAME} AS subject_name FROM fleet_role_assignments a JOIN fleet_roles r ON r.id = a.role_id`;

/** The subject can still hold a role: a person or agent that is not leaving or closed, and an agent that is still in Portal. */
function stillAssignable(db: Db, kind: string, id: string): boolean {
  const r = db.prepare(kind === "agent" ? "SELECT lifecycle, status FROM fleet_agents WHERE id = ?" : "SELECT lifecycle, kind AS status FROM fleet_people WHERE id = ?").get(id);
  if (!r) return false;
  if (r.lifecycle === "leaving" || r.lifecycle === "archived") return false;
  return kind === "agent" ? r.status !== "removed" : r.status === "person";
}

const dueStart = (db: Db, now: number): Row[] => db.prepare(`${BASE} WHERE a.ended_at IS NULL AND a.started_at IS NULL AND a.valid_from IS NOT NULL AND a.valid_from <= ? AND (a.valid_until IS NULL OR a.valid_until > ?)`).all(now, now);
const dueEnd = (db: Db, now: number): Row[] => db.prepare(`${BASE} WHERE a.ended_at IS NULL AND a.valid_until IS NOT NULL AND a.valid_until <= ?`).all(now);

/** True only when the row changed: a row that moved on since the tick that saw it (the owner ended it) is not counted, and its key is dropped by the caller. */
function attempt(fn: () => boolean, onError?: (e: unknown) => void): { ran: boolean; changed: boolean } {
  try {
    return { ran: true, changed: fn() };
  } catch (e) {
    onError?.(e);
    return { ran: false, changed: false };
  }
}

/** One tick. `seen` holds what the last tick saw and is replaced by what this one saw. */
export function tickRoles(db: Db, seen: Set<string>, now = Date.now(), onError?: (e: unknown) => void): RoleTickResult {
  const out: RoleTickResult = { started: 0, ended: 0 };
  const next = new Set<string>();
  for (const r of dueStart(db, now)) {
    const key = `from:${String(r.id)}:${Number(r.valid_from)}`;
    next.add(key);
    if (!seen.has(key)) continue;
    const res = attempt(
      () =>
        db.transaction(() => {
          // read again inside the transaction: the owner may have ended it between the tick that saw it and this one
          const cur = db.prepare(`${BASE} WHERE a.id = ? AND a.ended_at IS NULL AND a.started_at IS NULL`).get(String(r.id));
          if (!cur || cur.valid_from === null || Number(cur.valid_from) > now) return false;
          bump(db);
          const who = { kind: String(cur.subject_kind), id: String(cur.subject_id), name: String(cur.subject_name) };
          // the checks of an assignment hold at the start too: a subject that is leaving, closed or gone since the role was given never gets it
          if (!stillAssignable(db, who.kind, who.id)) {
            db.prepare("UPDATE fleet_role_assignments SET ended_at = ?, end_reason = 'not_started' WHERE id = ? AND ended_at IS NULL").run(now, String(r.id));
            appendEvent(db, { subject: who, kind: "changed", actor: SYSTEM, reason: String(cur.reason), note: `Role ${String(cur.role_name)} did not start: the entry is leaving, closed or gone.`, at: now });
            return true;
          }
          db.prepare("UPDATE fleet_role_assignments SET started_at = ? WHERE id = ? AND started_at IS NULL AND ended_at IS NULL").run(now, String(r.id));
          appendEvent(db, { subject: who, kind: "changed", actor: SYSTEM, reason: String(cur.reason), note: `Role ${String(cur.role_name)} started: the start date passed.`, at: now });
          return true;
        }),
      onError,
    );
    if (!res.ran) continue;
    next.delete(key);
    if (res.changed) out.started++;
  }
  for (const r of dueEnd(db, now)) {
    const key = `until:${String(r.id)}:${Number(r.valid_until)}`;
    next.add(key);
    if (!seen.has(key)) continue;
    const res = attempt(
      () =>
        db.transaction(() => {
          const cur = db.prepare(`${BASE} WHERE a.id = ? AND a.ended_at IS NULL`).get(String(r.id));
          if (!cur || cur.valid_until === null || Number(cur.valid_until) > now) return false;
          bump(db);
          db.prepare("UPDATE fleet_role_assignments SET ended_at = ?, end_reason = 'expired' WHERE id = ? AND ended_at IS NULL").run(now, String(r.id));
          appendEvent(db, { subject: { kind: String(cur.subject_kind), id: String(cur.subject_id), name: String(cur.subject_name) }, kind: "changed", actor: SYSTEM, reason: String(cur.reason), note: `Role ${String(cur.role_name)} ended: the end date passed.`, at: now });
          return true;
        }),
      onError,
    );
    if (!res.ran) continue;
    next.delete(key);
    if (res.changed) out.ended++;
  }
  seen.clear();
  for (const k of next) seen.add(k);
  return out;
}

export function startRolesTimer(db: Db, log: { warn(msg: string, f?: Record<string, string>): void }, everyMs = ROLE_TICK_MS, firstMs = ROLE_FIRST_TICK_MS): () => void {
  const seen = new Set<string>();
  const warn = (e: unknown) => log.warn("role date tick failed", { reason: e instanceof Error ? e.message.slice(0, 200) : "error" });
  const tick = () => {
    try {
      tickRoles(db, seen, Date.now(), warn);
    } catch (e) {
      warn(e);
    }
  };
  // After a start, an end date that passed while the app was down ends as soon as two ticks agree (the second one is as soon as the first), not a full period later
  const first = setTimeout(tick, firstMs);
  first.unref();
  const second = setTimeout(tick, firstMs * 2);
  second.unref();
  const t = setInterval(tick, everyMs);
  t.unref();
  return () => {
    clearTimeout(first);
    clearTimeout(second);
    clearInterval(t);
  };
}
