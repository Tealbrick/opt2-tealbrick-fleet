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
         AND (p.draft_state IN ('applying', 'applied') OR EXISTS (SELECT 1 FROM fleet_plan_steps s WHERE s.plan_id = p.id AND s.phase = 'core' AND s.output_json IS NOT NULL)) LIMIT 1`,
    )
    .get(kind, id);

/** T7 (Domain 6): Connect accounts tied to nobody. A person cannot close while one is unnamed: it may be theirs. The owner names one with an exception: code `unlinked_account`, subject `item`, id `<target>:<item>`. */
export const unnamedAccounts = (db: Db, now: number): number =>
  Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_access_items i WHERE i.target = 'connect' AND i.subject_kind = 'unlinked' AND i.kind IN ('account_as_me', 'account_as_itself')
           AND NOT EXISTS (SELECT 1 FROM fleet_exceptions e WHERE e.code = 'unlinked_account' AND e.subject_kind = 'item' AND e.subject_id = i.target || ':' || i.item_id AND e.until > ?)`,
      )
      .get(now)?.n ?? 0,
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
