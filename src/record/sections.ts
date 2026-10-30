// The sections of the access record that are not the lists of the sweeps (C380 T2-b): events, verdicts, plans with their outcomes, accepted
// differences, rounds, time to stop, and who approved. Each reads a table that is already evidence, and each is bounded: past its cap the period is
// too long for one file, and the record says so instead of cutting it.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { type AccessTarget, TARGET_NAMES } from "../access/items.ts";
import { fail } from "../meta.ts";
import { summaryOf } from "../rounds.ts";
import type { Names } from "./sweeps.ts";

type Row = Record<string, unknown>;
export const CAPS = { events: 5000, verdicts: 5000, plans: 500, steps: 5000, exceptions: 2000, stops: 500, rounds: 200 } as const;
/** A plan that ended like this was not confirmed into effect: the owner took it back, it ran out, Portal refused it, or it was replaced. */
const NOT_CONFIRMED: readonly string[] = ["rejected", "expired", "withdrawn", "replaced", "cancelled", "stale", "lost"];
const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const cap = (rows: Row[], max: number, what: string): Row[] => (rows.length > max ? fail("record_too_big", `This period has too many ${what} for one file. Choose a shorter period.`, 409) : rows);
const nameFor = (names: Names, kind: unknown, id: unknown): string | null => (kind === "agent" ? names.agents : names.people).get(String(id)) ?? null;
const subjectOf = (names: Names, kind: unknown, id: unknown, fallback?: unknown) => ({ kind: String(kind), id: String(id), name: nameFor(names, kind, id) ?? (fallback === undefined || fallback === null ? null : String(fallback)) });

export function eventsIn(db: Db, from: number, to: number, names: Names) {
  const rows = cap(db.prepare("SELECT * FROM fleet_lifecycle_events WHERE at >= ? AND at <= ? ORDER BY seq LIMIT ?").all(from, to, CAPS.events + 1), CAPS.events, "events");
  return rows.map((r) => ({
    seq: Number(r.seq),
    id: String(r.id),
    at: iso(r.at) as string,
    kind: String(r.kind),
    subject: r.subject_kind === "workspace" ? { kind: "workspace", id: "", name: null } : subjectOf(names, r.subject_kind, r.subject_id, r.subject_name),
    from: r.from_state === null ? null : String(r.from_state),
    to: r.to_state === null ? null : String(r.to_state),
    actor: r.actor_kind === "owner" ? ("owner" as const) : ("system" as const),
    actorId: r.actor_kind === "owner" && r.actor_id !== null ? String(r.actor_id) : null,
    reason: r.reason === null ? null : String(r.reason),
    note: r.note === null ? null : String(r.note),
    plan: r.plan_id === null ? null : String(r.plan_id),
    receipt: r.receipt_id === null ? null : String(r.receipt_id),
  }));
}

export function verdictsIn(db: Db, from: number, to: number, names: Names) {
  const rows = cap(db.prepare("SELECT * FROM fleet_reviews WHERE status = 'done' AND answered_by IS NULL AND decided_at >= ? AND decided_at <= ? ORDER BY id LIMIT ?").all(from, to, CAPS.verdicts + 1), CAPS.verdicts, "verdicts");
  const round = db.prepare("SELECT round_id FROM fleet_campaign_items WHERE review_id = ?");
  return rows.map((r) => ({
    id: String(r.id),
    subject: subjectOf(names, r.subject_kind === "agent" ? "agent" : "person", r.subject_id, r.subject_name),
    verdict: String(r.verdict),
    reason: String(r.reason),
    reviewer: r.reviewer === null ? null : String(r.reviewer),
    decidedAt: iso(r.decided_at) as string,
    round: (round.get(String(r.id))?.round_id as string | undefined) ?? null,
    pictureDigest: r.snapshot_digest === null ? null : String(r.snapshot_digest),
  }));
}

export function exceptionsIn(db: Db, from: number, to: number, names: Names) {
  const rows = cap(db.prepare("SELECT * FROM fleet_exceptions WHERE at <= ? AND until >= ? ORDER BY at, code LIMIT ?").all(to, from, CAPS.exceptions + 1), CAPS.exceptions, "accepted differences");
  return rows.map((r) => ({ code: String(r.code), subject: subjectOf(names, r.subject_kind, r.subject_id), reason: String(r.reason), setAt: iso(r.at) as string, until: iso(r.until) as string, by: r.by_id === null ? null : String(r.by_id) }));
}

export function roundsIn(db: Db, from: number, to: number, now: number) {
  const rows = cap(db.prepare("SELECT * FROM fleet_rounds WHERE (created_at >= ? AND created_at <= ?) OR (closed_at >= ? AND closed_at <= ?) ORDER BY created_at, id LIMIT ?").all(from, to, from, to, CAPS.rounds + 1), CAPS.rounds, "review rounds");
  return rows.map((r) => ({ ...summaryOf(db, r, now), createdBy: r.created_by === null ? null : String(r.created_by), closedBy: r.closed_by === null ? null : String(r.closed_by) }));
}

/** Portal's answer for a step, as the runner kept it (it cuts at 2000 characters itself). Kept whole: a record that says it copies must not cut again. */
const outcomeOf = (s: Row): unknown => {
  if (s.output_json === null || s.output_json === undefined) return null;
  try {
    return JSON.parse(String(s.output_json)) as unknown;
  } catch {
    return String(s.output_json);
  }
};
const seenBy = (s: Row): string => (s.phase === "core" ? "Portal: the signed picture Governance reads" : `${TARGET_NAMES[s.target as AccessTarget] ?? String(s.target)}: a fresh list of the app`);

/** Plans that opened or closed in the period, with every step and the outcome copied from it (Portal keeps a receipt for 90 days). */
export function plansIn(db: Db, from: number, to: number, names: Names) {
  const plans = cap(db.prepare("SELECT * FROM fleet_plans WHERE (opened_at >= ? AND opened_at <= ?) OR (closed_at >= ? AND closed_at <= ?) ORDER BY opened_at, part, id LIMIT ?").all(from, to, from, to, CAPS.plans + 1), CAPS.plans, "plans");
  let steps = 0;
  return plans.map((p) => {
    const rows = db.prepare("SELECT * FROM fleet_plan_steps WHERE plan_id = ? ORDER BY n").all(String(p.id));
    steps += rows.length;
    if (steps > CAPS.steps) fail("record_too_big", "This period has too many plan steps for one file. Choose a shorter period.", 409);
    return {
      id: String(p.id),
      group: String(p.group_id),
      part: Number(p.part),
      parts: Number(p.parts),
      subject: subjectOf(names, p.subject_kind, p.subject_id, p.subject_name),
      purpose: String(p.purpose),
      by: String(p.trigger_kind),
      confirmedBy: p.trigger_kind === "owner" && p.actor_id !== null && !NOT_CONFIRMED.includes(String(p.state)) ? String(p.actor_id) : null,
      state: String(p.state),
      mode: String(p.rail),
      openedAt: iso(p.opened_at) as string,
      appliedAt: iso(p.applied_at),
      closedAt: iso(p.closed_at),
      portalDraft: p.draft_id === null ? null : String(p.draft_id),
      portalReceipt: p.receipt_id === null ? null : String(p.receipt_id),
      portalDigest: p.core_digest === null ? null : String(p.core_digest),
      digestFromApp: String(p.plan_digest),
      steps: rows.map((s) => ({ n: Number(s.n), phase: String(s.phase), store: s.target === "core" ? "Portal" : (TARGET_NAMES[s.target as AccessTarget] ?? String(s.target)), op: String(s.op), kind: s.item_kind === null ? null : String(s.item_kind), label: s.label === null ? null : String(s.label), state: String(s.state), code: s.code === null ? null : String(s.code), detail: s.detail === null ? null : String(s.detail), tries: Number(s.tries), at: iso(s.updated_at) as string, outcome: outcomeOf(s) })),
    };
  });
}

// ── time to stop ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Seconds from "marked" to "stopped" as the app or the slice showed it. Marked: the owner's or the system's change to suspended or leaving. Stopped needs all of: a
 * stop plan came after the change and every such plan is done; every app was read or is not installed; every step that ends something is proved by its owner (the
 * slice, or a fresh list of the app); and nothing was kept or only listed. Anything less gives no time and says why. A stop is never claimed from what an app said it did.
 */
export function timeToStop(db: Db, from: number, to: number, names: Names) {
  const marks = cap(db.prepare("SELECT * FROM fleet_lifecycle_events WHERE kind = 'transition' AND to_state IN ('suspended', 'leaving') AND at >= ? AND at <= ? ORDER BY seq LIMIT ?").all(from, to, CAPS.stops + 1), CAPS.stops, "stops");
  const nextMark = db.prepare("SELECT MIN(at) AS at FROM fleet_lifecycle_events WHERE kind = 'transition' AND subject_kind = ? AND subject_id = ? AND seq > ?");
  const plansAfter = db.prepare("SELECT * FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND purpose IN ('suspend', 'leave', 'transfer') AND opened_at >= ? AND opened_at < ? ORDER BY opened_at, part");
  const stepsOf = db.prepare("SELECT * FROM fleet_plan_steps WHERE plan_id = ? ORDER BY n");
  return marks.map((m) => {
    const until = Number(nextMark.get(String(m.subject_kind), String(m.subject_id), Number(m.seq))?.at ?? Number.MAX_SAFE_INTEGER);
    const plans = plansAfter.all(String(m.subject_kind), String(m.subject_id), Number(m.at), until);
    const all = plans.flatMap((p) => stepsOf.all(String(p.id)));
    const real = all.filter((s) => s.phase !== "read" && s.state !== "listed");
    const proved = real.filter((s) => s.state === "done");
    const said = real.filter((s) => s.state === "reported" || s.state === "not_provable");
    const manual = real.filter((s) => s.state === "manual");
    const kept = all.filter((s) => s.state === "listed").length;
    const unread = all.filter((s) => s.phase === "read" && s.state !== "done" && s.state !== "not_installed").length;
    const open = real.length - proved.length - said.length - manual.length - real.filter((s) => ["excepted", "not_installed", "cancelled"].includes(String(s.state))).length;
    const planned = plans.length > 0 && plans.every((p) => p.state === "done");
    const stopped = planned && unread === 0 && kept === 0 && real.length > 0 && proved.length === real.length;
    const at = stopped ? Math.max(...proved.map((s) => Number(s.updated_at))) : null;
    const why = [!planned ? "A plan is not done." : null, unread > 0 ? "An app was not read." : null, kept > 0 ? `${kept} items were kept or only listed.` : null, real.length === 0 ? "No step ends anything." : proved.length < real.length ? "Not every step is proved." : null].filter(Boolean);
    return {
      subject: subjectOf(names, m.subject_kind, m.subject_id, m.subject_name),
      to: String(m.to_state),
      reason: m.reason === null ? null : String(m.reason),
      markedBy: m.actor_kind === "owner" ? "owner" : "system",
      markedAt: iso(m.at) as string,
      plans: plans.map((p) => String(p.id)),
      steps: { total: real.length, proved: proved.length, said: said.length, manual: manual.length, open: Math.max(open, 0), kept, unread },
      stoppedAt: at === null ? null : iso(at),
      seconds: at === null ? null : Math.max(0, Math.round((at - Number(m.at)) / 1000)),
      seenBy: [...new Set(proved.map(seenBy))],
      note: plans.length === 0 ? "No plan was made for this change." : stopped ? null : `The time is not given. ${why.join(" ")}`,
    };
  });
}

// ── who approved ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The distinct sign-ins that approved something in Governance in the period: a review verdict, a plan the owner confirmed that was not taken back or refused, an accepted
 * difference, and the owner's own change of a person or agent. Making or closing a round, and making this record, approve nothing. An approval in Portal is made in Portal.
 */
export function approversIn(parts: { verdicts: { reviewer: string | null }[]; plans: { confirmedBy: string | null }[]; exceptions: { by: string | null }[]; events: { actorId: string | null; subject: { kind: string } }[] }): string[] {
  const ids = new Set<string>();
  for (const v of parts.verdicts) if (v.reviewer) ids.add(v.reviewer);
  for (const p of parts.plans) if (p.confirmedBy) ids.add(p.confirmedBy);
  for (const e of parts.exceptions) if (e.by) ids.add(e.by);
  for (const e of parts.events) if (e.actorId && e.subject.kind !== "workspace") ids.add(e.actorId);
  return [...ids].sort();
}

/** Changes the system made with no approval in Governance: system plans, and a stop or close the system recorded. */
export const systemMadeIn = (parts: { plans: { by: string }[]; events: { actor: string; kind: string; to: string | null }[] }): number =>
  parts.plans.filter((p) => p.by === "system").length + parts.events.filter((e) => e.actor === "system" && e.kind === "transition" && ["suspended", "leaving", "archived"].includes(String(e.to))).length;
