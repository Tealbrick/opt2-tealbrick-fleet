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
const OUTCOME_CHARS = 1000;
const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const cap = (rows: Row[], max: number, what: string): Row[] => (rows.length > max ? fail("record_too_big", `This period holds too many ${what} for one file. Choose a shorter period.`, 409) : rows);
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

const outcomeOf = (s: Row): unknown => {
  if (s.output_json === null || s.output_json === undefined) return null;
  const text = String(s.output_json);
  return text.length > OUTCOME_CHARS ? `${text.slice(0, OUTCOME_CHARS)}…` : (JSON.parse(text) as unknown);
};
const seenBy = (s: Row): string => (s.phase === "core" ? "Portal: the signed picture Governance reads" : `${TARGET_NAMES[s.target as AccessTarget] ?? String(s.target)}: a fresh list of the app`);

/** Plans that opened or closed in the period, with every step and the outcome copied from it (Portal keeps a receipt for 90 days). */
export function plansIn(db: Db, from: number, to: number, names: Names) {
  const plans = cap(db.prepare("SELECT * FROM fleet_plans WHERE (opened_at >= ? AND opened_at <= ?) OR (closed_at >= ? AND closed_at <= ?) ORDER BY opened_at, part, id LIMIT ?").all(from, to, from, to, CAPS.plans + 1), CAPS.plans, "plans");
  let steps = 0;
  return plans.map((p) => {
    const rows = db.prepare("SELECT * FROM fleet_plan_steps WHERE plan_id = ? ORDER BY n").all(String(p.id));
    steps += rows.length;
    if (steps > CAPS.steps) fail("record_too_big", "This period holds too many plan steps for one file. Choose a shorter period.", 409);
    return {
      id: String(p.id),
      group: String(p.group_id),
      part: Number(p.part),
      parts: Number(p.parts),
      subject: subjectOf(names, p.subject_kind, p.subject_id, p.subject_name),
      purpose: String(p.purpose),
      by: String(p.trigger_kind),
      approvedBy: p.trigger_kind === "owner" && p.actor_id !== null ? String(p.actor_id) : null,
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
 * Seconds from "marked" to "stopped" as the app or the slice showed it. Marked: the owner's or the system's change to suspended or leaving. Stopped: every
 * step of the plans that followed is proved (`done`), at the time of the last proof. A step that is only said, handled by hand or still open leaves it unstopped,
 * with the count: a stop is never claimed from what an app said it did.
 */
export function timeToStop(db: Db, from: number, to: number, names: Names) {
  const marks = cap(db.prepare("SELECT * FROM fleet_lifecycle_events WHERE kind = 'transition' AND to_state IN ('suspended', 'leaving') AND at >= ? AND at <= ? ORDER BY seq LIMIT ?").all(from, to, CAPS.stops + 1), CAPS.stops, "stops");
  const nextMark = db.prepare("SELECT MIN(at) AS at FROM fleet_lifecycle_events WHERE kind = 'transition' AND subject_kind = ? AND subject_id = ? AND seq > ?");
  const plansAfter = db.prepare("SELECT * FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND opened_at >= ? AND opened_at < ? ORDER BY opened_at, part");
  const stepsOf = db.prepare("SELECT * FROM fleet_plan_steps WHERE plan_id = ? AND phase <> 'read' AND state <> 'listed' ORDER BY n");
  return marks.map((m) => {
    const until = Number(nextMark.get(String(m.subject_kind), String(m.subject_id), Number(m.seq))?.at ?? Number.MAX_SAFE_INTEGER);
    const plans = plansAfter.all(String(m.subject_kind), String(m.subject_id), Number(m.at), until);
    const steps = plans.flatMap((p) => stepsOf.all(String(p.id)));
    const proved = steps.filter((s) => s.state === "done");
    const said = steps.filter((s) => s.state === "reported" || s.state === "not_provable");
    const manual = steps.filter((s) => s.state === "manual");
    const open = steps.length - proved.length - said.length - manual.length - steps.filter((s) => ["excepted", "not_installed", "cancelled"].includes(String(s.state))).length;
    const stopped = plans.length > 0 && steps.length > 0 && proved.length === steps.length;
    const at = stopped ? Math.max(...proved.map((s) => Number(s.updated_at))) : null;
    return {
      subject: subjectOf(names, m.subject_kind, m.subject_id, m.subject_name),
      to: String(m.to_state),
      reason: m.reason === null ? null : String(m.reason),
      markedBy: m.actor_kind === "owner" ? "owner" : "system",
      markedAt: iso(m.at) as string,
      plans: plans.map((p) => String(p.id)),
      steps: { total: steps.length, proved: proved.length, said: said.length, manual: manual.length, open: Math.max(open, 0) },
      stoppedAt: at === null ? null : iso(at),
      seconds: at === null ? null : Math.max(0, Math.round((at - Number(m.at)) / 1000)),
      seenBy: [...new Set(proved.map(seenBy))],
      note: plans.length === 0 ? "No plan was made for this change." : stopped ? null : "Not every step is proved. The time is not given.",
    };
  });
}

// ── who approved ────────────────────────────────────────────────────────────────────────────────────────────────

/** The distinct sign-ins that approved something in the period: verdicts, plans the owner confirmed, accepted differences, owner changes, rounds. */
export function approversIn(parts: { verdicts: { reviewer: string | null }[]; plans: { approvedBy: string | null }[]; exceptions: { by: string | null }[]; events: { actorId: string | null }[]; rounds: { createdBy: string | null; closedBy: string | null }[] }): string[] {
  const ids = new Set<string>();
  for (const v of parts.verdicts) if (v.reviewer) ids.add(v.reviewer);
  for (const p of parts.plans) if (p.approvedBy) ids.add(p.approvedBy);
  for (const e of parts.exceptions) if (e.by) ids.add(e.by);
  for (const e of parts.events) if (e.actorId) ids.add(e.actorId);
  for (const r of parts.rounds) for (const id of [r.createdBy, r.closedBy]) if (id) ids.add(id);
  return [...ids].sort();
}
