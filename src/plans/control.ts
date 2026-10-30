// What a person op does to plans: ends them before a lifecycle change, asks again, and the scan the job runs. The owner's act always wins over a tick:
// every write is a compare-and-set, and the tick looks at the row again right before it sends.
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { loadSubject } from "../lifecycle/transitions.ts";
import { askRail } from "./core-rail.ts";
import { createPlan, getPlan, movePlan, notePlan, OPEN_SQL, type Row, stepsOf } from "./plan.ts";
import { cancelUnsent, isAppliedHere, type PlanCtx } from "./runner.ts";
import { ASK_AGAIN_STATES, BAR_WAIT_MS, isOpenPlan, REISSUE_MS } from "./steps.ts";

export interface CloseResult {
  /** parts Portal really took back */
  withdrawn: number;
  /** parts that ended here with no call that took anything back: past Core, or the rail is gone */
  ended: number;
  /** parts that still stand in Portal */
  left: number;
  /** one of those: the owner approved it first */
  applied: boolean;
}

/**
 * Takes open plans of a subject back, draft first (§2 T4, T6). `replaced`: a new plan takes over. `withdrawn`: the owner undid the stop. `cancelled`: the owner stopped the plan.
 * This cannot be one transaction: each part is a call to Portal. So it goes through every part, each ends with its true state, and the answer says how many are still there. The caller decides: a state change does not go on with a draft that can still be applied.
 */
export async function closeOpenPlans(pc: PlanCtx, plans: readonly Row[], to: "replaced" | "withdrawn" | "cancelled"): Promise<CloseResult> {
  const rail = pc.rail;
  const out: CloseResult = { withdrawn: 0, ended: 0, left: 0, applied: false };
  // Nothing is touched when these say no.
  if (plans.some((p) => p.state === "applying" || p.draft_state === "applying")) throw new TbError("plan_applying", "Portal is applying this plan. Try again in a minute.", 409);
  if (to === "replaced" && plans.some(isAppliedHere)) throw new TbError("plan_open", "A plan for this entry is past Portal and still open. Cancel it or wait for it.", 409);
  for (const p of plans) {
    const id = String(p.id);
    if (isAppliedHere(p)) {
      if (movePlan(pc.db, id, String(p.state), "cancelled", { code: "cancelled_after_apply" }, pc.now())) cancelUnsent(pc.db, id, pc.now());
      out.ended++;
      continue;
    }
    let code: string | null = null;
    // Whatever the mode says: a draft may stand in Portal since before the rail went away.
    if (rail && p.draft_key !== null) {
      const answer = await askRail(() => rail.withdraw(String(p.draft_key)));
      // Core answers draft_state with a reason for a draft that ran out: that one cannot be applied any more, so it is gone.
      const approved = answer.kind === "draft_state" && answer.reason === null;
      if (approved || answer.kind === "wait" || answer.kind === "full") {
        out.left++;
        if (approved) out.applied = true;
        notePlan(pc.db, id, String(getPlan(pc.db, id)?.state), { close_note: approved ? "approved_first" : "not_reached" }, pc.now());
        continue;
      }
      // The rail is gone or refused: the plan ends, and its words say the draft may stand. A later apply shows as a difference, never silently.
      if (answer.kind !== "ok" && answer.kind !== "unknown_key" && answer.kind !== "draft_state") code = "not_taken_back";
    } else if (!rail && p.draft_key !== null) code = "not_taken_back";
    const now = pc.now();
    const cur = getPlan(pc.db, id) as Row;
    const did = stepsOf(pc.db, id).some((s) => s.phase === "core" && s.output_json !== null);
    if (isOpenPlan(String(cur.state)) && movePlan(pc.db, id, String(cur.state), to, { code: code ?? (did ? "partly_applied" : null), close_note: null }, now)) cancelUnsent(pc.db, id, now);
    if (code === null) out.withdrawn++;
    else out.ended++;
  }
  return out;
}

/** A state change does not go on while a draft can still be applied. The message says what already happened, so the owner reads the true state. */
export function assertAllClosed(r: CloseResult): void {
  if (r.left === 0) return;
  const before = r.withdrawn > 0 ? ` ${r.withdrawn} of ${r.withdrawn + r.ended + r.left} open parts were taken back already. Nothing else changed.` : "";
  if (r.applied) throw new TbError("plan_applied", `You already approved this in Portal. It cannot be taken back here.${before}`, 409);
  throw new TbError("portal_unavailable", `Portal does not answer, so this request could still be applied. Try again.${before}`, 503);
}

const otherOpen = (db: Db, p: Row): boolean => !!db.prepare(`SELECT 1 FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND group_id <> ? AND state IN (${OPEN_SQL}) LIMIT 1`).get(String(p.subject_kind), String(p.subject_id), String(p.group_id));

/** A plan asks Core again with a new key: a key of a rejected or expired draft gives the old answer. */
export function askAgain(db: Db, p: Row, now: number): void {
  db.transaction(() => {
    const id = String(p.id);
    const hasCore = stepsOf(db, id).some((s) => s.phase === "core");
    if (!movePlan(db, id, String(p.state), "preparing", { draft_key: null, draft_id: null, draft_state: null, review_url: null, core_digest: null, expires_at: null, applying_since: null, applied_at: null, code: null, close_note: null, detail: null, rail: hasCore ? "draft" : "none", rail_code: null, next_at: 0, closed_at: null }, now)) return;
    db.prepare("UPDATE fleet_plan_steps SET state = 'pending', code = NULL, detail = NULL, tries = 0, retry_at = 0, updated_at = ? WHERE plan_id = ? AND state = 'cancelled'").run(now, id);
    db.prepare("UPDATE fleet_plan_steps SET state = 'pending', code = NULL, detail = NULL, updated_at = ? WHERE plan_id = ? AND phase = 'core' AND state NOT IN ('done', 'reported')").run(now, id);
  });
}

/** "Try again". A new attempt comes only from the runner, after a fresh list. Core's failed step is for Portal. */
export function retryPlan(db: Db, p: Row, now: number): void {
  const id = String(p.id);
  const s = loadSubject(db, p.subject_kind as "person" | "agent", String(p.subject_id));
  if (!s || s.rev !== Number(p.lifecycle_rev)) throw new TbError("lifecycle_stale", "This entry changed after you confirmed. Make a new plan.", 409);
  if (!isOpenPlan(String(p.state))) {
    if (p.state === "done" || p.state === "reported") throw new TbError("plan_finished", "This plan is finished.", 409);
    if (!ASK_AGAIN_STATES.includes(String(p.state)) || p.code === "core_mismatch") throw new TbError("plan_ended", "This plan cannot be asked again. Make a new plan.", 409);
    if (otherOpen(db, p)) throw new TbError("plan_open", "A newer plan for this entry is open.", 409);
    askAgain(db, p, now);
    return;
  }
  // Portal link mode: consent may be on now, or the bridge newer. Steps the slice proved stay.
  if (p.rail === "portal_link" && p.draft_state === null) {
    askAgain(db, p, now);
    return;
  }
  const steps = stepsOf(db, id);
  if (steps.some((x) => x.phase === "core" && x.state === "failed")) throw new TbError("apply_in_portal", "Portal stopped on a step. Apply it again in Portal.", 409);
  db.transaction(() => {
    // `changed` stays: the store's row is not what the owner saw, so only a new plan, with a new look, may end it.
    db.prepare("UPDATE fleet_plan_steps SET state = 'failed', tries = 0, retry_at = 0, code = NULL, detail = NULL, updated_at = ? WHERE plan_id = ? AND phase <> 'read' AND phase <> 'core' AND state IN ('refused', 'failed', 'not_revocable')").run(now, id);
    db.prepare("UPDATE fleet_plan_steps SET retry_at = 0, updated_at = ? WHERE plan_id = ? AND phase = 'read'").run(now, id);
    movePlan(db, id, String(p.state), p.state === "partial" ? "running" : String(p.state), { next_at: 0, code: null }, now);
  });
}

/**
 * N2-6: a person marked leaving is barred, whatever else happens. The owner's T5 is the approval (§5 phase A). The old People form makes no plan, a plan_send can fail, a tab can die:
 * this makes the bar's own plan when no plan came. After a short wait, so the normal flow's plan_send goes first and one plan does it all.
 */
function owedBars(db: Db, now: number, warn: (m: string, f?: Record<string, string>) => void): void {
  const rows = db
    .prepare(
      `SELECT p.id FROM fleet_people p WHERE p.lifecycle = 'leaving' AND COALESCE(p.lifecycle_reason, '') <> 'migrated' AND p.lifecycle_at <= ?
         AND EXISTS (SELECT 1 FROM fleet_handles h WHERE h.person_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM fleet_plans x WHERE x.subject_kind = 'person' AND x.subject_id = p.id AND x.opened_at >= p.lifecycle_at) LIMIT 20`,
    )
    .all(now - BAR_WAIT_MS);
  for (const r of rows) {
    try {
      createPlan(db, { kind: "person", id: String(r.id), barOnly: true, actor: { kind: "owner", id: null } }, now);
    } catch (err) {
      // An older plan still open: it ends by itself as stale, and the next run makes this one.
      if (!(err instanceof TbError)) warn("sender bar plan failed", { reason: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  }
}

/** One run of the job: plans the system owes, and expired system plans due again. Synchronous, nothing is called. */
export function scanPlans(db: Db, now: number, warn: (m: string, f?: Record<string, string>) => void): void {
  owedBars(db, now, warn);
  const owed = db
    .prepare(
      `SELECT e.id, e.subject_kind, e.subject_id, e.at FROM fleet_lifecycle_events e
       WHERE e.kind = 'transition' AND e.actor_kind = 'system' AND e.to_state = 'suspended'
         AND NOT EXISTS (SELECT 1 FROM fleet_plans p WHERE p.source_event = e.id)
         AND NOT EXISTS (SELECT 1 FROM fleet_plans o WHERE o.subject_kind = e.subject_kind AND o.subject_id = e.subject_id AND o.state IN (${OPEN_SQL}))
       ORDER BY e.seq DESC LIMIT 20`,
    )
    .all();
  for (const e of owed) {
    const kind = e.subject_kind as "person" | "agent";
    const s = loadSubject(db, kind, String(e.subject_id));
    // Only the latest change of this entry: an older date does not open a plan for a stop the owner made later.
    if (!s || s.lifecycle !== "suspended" || s.at !== Number(e.at)) continue;
    try {
      createPlan(db, { kind, id: s.id, actor: { kind: "system", id: null }, sourceEvent: String(e.id) }, now);
    } catch (err) {
      // nothing to stop, or a plan that opened meanwhile: nothing is owed
      if (!(err instanceof TbError)) warn("system plan failed", { reason: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  }
  for (const p of db.prepare("SELECT * FROM fleet_plans WHERE state = 'expired' AND trigger_kind = 'system' AND closed_at <= ? ORDER BY closed_at LIMIT 20").all(now - REISSUE_MS)) {
    const s = loadSubject(db, p.subject_kind as "person" | "agent", String(p.subject_id));
    // The entry moved, or the owner made his own plan: nothing is owed by this one any more.
    if (!s || s.rev !== Number(p.lifecycle_rev)) movePlan(db, String(p.id), "expired", "stale", { code: "lifecycle_moved" }, now);
    else if (otherOpen(db, p)) movePlan(db, String(p.id), "expired", "replaced", {}, now);
    else askAgain(db, p, now);
  }
}


/** A slice arrived: Core may have applied something. The next run ticks each open plan at once, instead of at the slow pace. */
export function wakePlans(db: Db): number {
  return Number(db.prepare(`UPDATE fleet_plans SET next_at = 0 WHERE state IN (${OPEN_SQL}) AND next_at > 0`).run().changes);
}
