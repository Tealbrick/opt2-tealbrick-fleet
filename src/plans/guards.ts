// What a lifecycle change must know about plans (C380, DESIGN-C380 §2). SQL only and no imports from the lifecycle, so the setter can ask without a cycle.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { OPEN_PLAN_STATES } from "./steps.ts";

const OPEN = OPEN_PLAN_STATES.map((s) => `'${s}'`).join(", ");

/** T7: an open plan means a step is not final. Core's steps of an agent in a person's plan count for the person. */
export const hasOpenPlan = (db: Db, kind: string, id: string): boolean => !!db.prepare(`SELECT 1 FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND state IN (${OPEN}) LIMIT 1`).get(kind, id);

/** T6: "No plan applied". Core says it applied a draft of this subject, and that is the last thing anyone proved. */
export const hasAppliedStop = (db: Db, kind: string, id: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM fleet_plans p WHERE p.subject_kind = ? AND p.subject_id = ?
         AND (p.draft_state IN ('applying', 'applied') OR EXISTS (SELECT 1 FROM fleet_plan_steps s WHERE s.plan_id = p.id AND s.phase = 'core' AND (s.output_json IS NOT NULL OR (s.op <> 'agents.pause' AND s.state IN ('done', 'reported', 'not_provable'))))) LIMIT 1`,
    )
    .get(kind, id);

/** T7: the last plan of this entry did not finish, and nobody said why. Close needs a new plan or a named reason. */
export function lastPlanUnfinished(db: Db, kind: string, id: string): boolean {
  const last = db.prepare("SELECT group_id FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND state <> 'replaced' ORDER BY opened_at DESC, id DESC LIMIT 1").get(kind, id);
  if (!last) return false;
  // Every part of a split plan: one part done says nothing about the others.
  return !!db.prepare("SELECT 1 FROM fleet_plans WHERE group_id = ? AND state IN ('expired', 'rejected', 'lost', 'failed', 'stale', 'withdrawn') LIMIT 1").get(String(last.group_id));
}

/**
 * T7 (Domain 6): Connect accounts tied to nobody. A person cannot close while one is unchecked: it may be theirs. The owner answers with exception_set, code `unlinked_account`, on this person:
 * "none of these is this person's". An account first seen after that answer counts again.
 */
export const unnamedAccounts = (db: Db, personId: string, now: number): number =>
  Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_access_items i WHERE i.target = 'connect' AND i.subject_kind = 'unlinked' AND i.kind IN ('account_as_me', 'account_as_itself')
           AND NOT EXISTS (SELECT 1 FROM fleet_exceptions e WHERE e.code = 'unlinked_account' AND e.subject_kind = 'person' AND e.subject_id = ? AND e.until > ? AND e.at >= i.first_seen)`,
      )
      .get(personId, now)?.n ?? 0,
  );

/** The state of the latest plan of each entry: `kind:id`. An agent in a person's plan counts too. One query for the whole list. */
export function latestPlanStates(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT subject_kind || ':' || subject_id AS k, state, opened_at FROM fleet_plans
       UNION ALL SELECT 'agent:' || s.agent_id, p.state, p.opened_at FROM fleet_plan_steps s JOIN fleet_plans p ON p.id = s.plan_id WHERE s.phase = 'core'
       ORDER BY opened_at`,
    )
    .all();
  return new Map(rows.map((r) => [String(r.k), String(r.state)]));
}

const KEY_STEP = "s.phase = 'core' AND s.op IN ('agents.offboard', 'agents.rotate') AND s.state IN ('done', 'reported')";

/** When Core last said each agent's key is gone. It counts only if that came after the agent's current stop: an agent brought back has a new key. One query for the whole list. */
export function keyEndedAt(db: Db): Map<string, number> {
  return new Map(db.prepare(`SELECT s.agent_id AS id, MAX(s.updated_at) AS at FROM fleet_plan_steps s WHERE ${KEY_STEP} GROUP BY s.agent_id`).all().map((r) => [String(r.id), Number(r.at)]));
}

/** The paused agents of this entry with no choice made: the words of the plan come from this, what is true now, not from what the plan held when it ran. */
export function undecidedKeys(db: Db, kind: string, id: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT a.id FROM fleet_agents a LEFT JOIN fleet_people p ON p.id = a.owner_id
       WHERE ${kind === "agent" ? "a.id" : "a.owner_id"} = ? AND a.status = 'paused' AND a.keep_running = 0 AND a.lifecycle IN ('active', 'proposed', 'suspended')
         AND (a.lifecycle = 'suspended' OR p.lifecycle IN ('suspended', 'leaving', 'archived'))
         AND NOT EXISTS (SELECT 1 FROM fleet_plan_steps s WHERE s.agent_id = a.id AND ${KEY_STEP} AND s.updated_at >= MAX(a.lifecycle_at, COALESCE(p.lifecycle_at, 0)))`,
    )
    .all(id);
  return new Set(rows.map((r) => String(r.id)));
}
