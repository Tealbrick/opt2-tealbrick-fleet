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
  const last = db.prepare("SELECT group_id FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND state <> 'replaced' AND purpose <> 'bar' ORDER BY opened_at DESC, id DESC LIMIT 1").get(kind, id);
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
      `SELECT subject_kind || ':' || subject_id AS k, state, opened_at FROM fleet_plans WHERE purpose <> 'bar'
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

/** Agents with their own stop, paused, whose key still exists: the words of the plan come from this, what is true now, not from what the plan held when it ran. C381: an owner's stop does not count. */
export function undecidedKeys(db: Db, kind: string, id: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT a.id FROM fleet_agents a
       WHERE ${kind === "agent" ? "a.id" : "a.owner_id"} = ? AND a.status = 'paused' AND a.lifecycle = 'suspended'
         AND NOT EXISTS (SELECT 1 FROM fleet_plan_steps s WHERE s.agent_id = a.id AND ${KEY_STEP} AND s.updated_at >= a.lifecycle_at)`,
    )
    .all(id);
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * N2-6: this person is marked leaving, has handles, and Connect has not shown the bar since. Proof is a read of Connect in a plan made after the mark, with no sender step left open.
 * A step the owner left unticked is his choice. Connect not installed: nothing can be barred, and nothing can reach an agent through it. `manual` is not proof: the messages still come. New handles are in Not changed.
 */
export function senderBarOpen(db: Db, personId: string): boolean {
  const open = db
    .prepare(
      `SELECT 1 FROM fleet_people w WHERE w.id = ? AND w.lifecycle = 'leaving' AND EXISTS (SELECT 1 FROM fleet_handles h WHERE h.person_id = w.id)
         AND NOT EXISTS (SELECT 1 FROM fleet_plans x JOIN fleet_plan_steps r ON r.plan_id = x.id
           WHERE x.subject_kind = 'person' AND x.subject_id = w.id AND x.opened_at >= w.lifecycle_at AND r.phase = 'read' AND r.target = 'connect' AND r.state IN ('done', 'not_installed')
             AND NOT EXISTS (SELECT 1 FROM fleet_plan_steps s WHERE s.plan_id = x.id AND s.item_kind = 'channel_sender' AND s.state NOT IN ('done', 'listed', 'not_installed', 'excepted')))`,
    )
    .get(personId);
  return !!open;
}

/** The last owner change of each agent that had an owner before it. From the record: the `moved` event of `setAgentMoved`. */
export function ownerChangedAt(db: Db): Map<string, number> {
  const rows = db.prepare("SELECT subject_id AS id, MAX(at) AS at FROM fleet_lifecycle_events WHERE kind = 'moved' AND subject_kind = 'agent' AND note LIKE 'Owner changed from %' AND json_extract(snapshot_json, '$.before') IS NOT NULL GROUP BY subject_id").all();
  return new Map(rows.map((r) => [String(r.id), Number(r.at)]));
}

/** Agents this entry's plans asked a new key for, and Core never replaced, still working cards. A closed or removed card has no key to replace, and must not block a new plan. */
export function owedRotations(db: Db, kind: string, id: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.agent_id AS id FROM fleet_plan_steps s JOIN fleet_plans p ON p.id = s.plan_id JOIN fleet_agents a ON a.id = s.agent_id
       WHERE p.subject_kind = ? AND p.subject_id = ? AND s.op = 'agents.rotate' AND a.status <> 'removed' AND a.lifecycle <> 'archived'
         AND NOT EXISTS (SELECT 1 FROM fleet_plan_steps d WHERE d.agent_id = s.agent_id AND d.op IN ('agents.rotate', 'agents.offboard') AND d.state IN ('done', 'reported'))`,
    )
    .all(kind, id);
  return rows.map((r) => String(r.id));
}
