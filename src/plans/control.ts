// What a person op does to plans: ends them before a lifecycle change, asks again, and the scan the job runs. The owner's act always wins over a tick:
// every write is a compare-and-set, and the tick looks at the row again right before it sends.
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { loadSubject } from "../lifecycle/transitions.ts";
import { askRail } from "./core-rail.ts";
import { createPlan, getPlan, movePlan, OPEN_SQL, type Row, stepsOf } from "./plan.ts";
import { cancelUnsent, isAppliedHere, type PlanCtx } from "./runner.ts";
import { isOpenPlan, REISSUE_MS } from "./steps.ts";

/**
 * Takes open plans of a subject back, draft first (§2 T4, T6). `replaced`: a new plan takes over, and a plan past Core stays, so createPlan refuses.
 * `withdrawn`: the owner undid the stop; `cancelled`: the owner stopped the plan. Throws, changing nothing more, when Portal does not answer: an unknown draft could still be applied.
 */
export async function closeOpenPlans(pc: PlanCtx, plans: readonly Row[], to: "replaced" | "withdrawn" | "cancelled"): Promise<void> {
  const rail = pc.rail;
  for (const p of plans) {
    const id = String(p.id);
    if (p.state === "applying" || p.draft_state === "applying") throw new TbError("plan_applying", "Portal is applying this plan. Try again in a minute.", 409);
    if (isAppliedHere(p)) {
      if (to === "replaced") continue;
      if (movePlan(pc.db, id, String(p.state), "cancelled", { code: "cancelled_after_apply" }, pc.now())) cancelUnsent(pc.db, id, pc.now());
      continue;
    }
    if (rail && p.rail === "draft" && p.draft_key !== null) {
      const answer = await askRail(() => rail.withdraw(String(p.draft_key)));
      if (answer.kind === "draft_state") throw new TbError("plan_applied", "You already approved this in Portal. It cannot be taken back here.", 409);
      if (answer.kind === "wait" || answer.kind === "full") throw new TbError("portal_unavailable", "Portal does not answer, so this request could still be applied. Try again.", 503);
    }
    const now = pc.now();
    const cur = getPlan(pc.db, id) as Row;
    if (isOpenPlan(String(cur.state)) && movePlan(pc.db, id, String(cur.state), to, {}, now)) cancelUnsent(pc.db, id, now);
  }
}

/** A plan asks Core again with a new key: a key of a rejected or expired draft gives the old answer. */
export function askAgain(db: Db, p: Row, now: number): void {
  db.transaction(() => {
    const id = String(p.id);
    const hasCore = stepsOf(db, id).some((s) => s.phase === "core");
    if (!movePlan(db, id, String(p.state), "preparing", { draft_key: null, draft_id: null, draft_state: null, review_url: null, core_digest: null, expires_at: null, applying_since: null, code: null, detail: null, rail: hasCore ? "draft" : "none", rail_code: null, next_at: 0, closed_at: null }, now)) return;
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
    askAgain(db, p, now);
    return;
  }
  const steps = stepsOf(db, id);
  if (steps.some((x) => x.phase === "core" && x.state === "failed")) throw new TbError("apply_in_portal", "Portal stopped on a step. Apply it again in Portal.", 409);
  db.transaction(() => {
    // `changed` goes: the next list makes a new step from what the store shows now. What the owner ticked stands, the digest he saw does not.
    db.prepare("UPDATE fleet_plan_steps SET state = 'pending' WHERE plan_id = ? AND phase = 'read' AND target IN (SELECT target FROM fleet_plan_steps WHERE plan_id = ? AND state = 'changed')").run(id, id);
    db.prepare("DELETE FROM fleet_plan_steps WHERE plan_id = ? AND state = 'changed'").run(id);
    db.prepare("UPDATE fleet_plan_steps SET state = 'failed', tries = 0, retry_at = 0, code = NULL, detail = NULL, updated_at = ? WHERE plan_id = ? AND phase <> 'read' AND phase <> 'core' AND state IN ('refused', 'failed')").run(now, id);
    db.prepare("UPDATE fleet_plan_steps SET retry_at = 0, updated_at = ? WHERE plan_id = ? AND phase = 'read'").run(now, id);
    const ticks = typeof p.wanted_json === "string" ? (JSON.parse(p.wanted_json) as { product: string; id: string }[]).map((t) => ({ product: t.product, id: t.id })) : null;
    movePlan(db, id, String(p.state), p.state === "partial" ? "running" : String(p.state), { next_at: 0, wanted_json: ticks ? JSON.stringify(ticks) : null, code: null }, now);
  });
}

/** One run of the job: plans the system owes, and expired system plans due again. Synchronous, nothing is called. */
export function scanPlans(db: Db, now: number, warn: (m: string, f?: Record<string, string>) => void): void {
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
  for (const p of db.prepare("SELECT * FROM fleet_plans WHERE state = 'expired' AND trigger_kind = 'system' AND closed_at <= ? LIMIT 20").all(now - REISSUE_MS)) {
    const s = loadSubject(db, p.subject_kind as "person" | "agent", String(p.subject_id));
    if (s && s.rev === Number(p.lifecycle_rev)) askAgain(db, p, now);
  }
}


/** A slice arrived: Core may have applied something. The next run ticks each open plan at once, instead of at the slow pace. */
export function wakePlans(db: Db): number {
  return Number(db.prepare(`UPDATE fleet_plans SET next_at = 0 WHERE state IN (${OPEN_SQL}) AND next_at > 0`).run().changes);
}
