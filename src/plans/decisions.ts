// Per-agent choices at the first step of a stop (C380, QA D2, Coordinator's ruling). Two stages stay: a mistaken firing must be undoable and offboard is costly, so with no choice
// an agent is only paused. An owner who knows the answer can finish in one approval: `stop` adds agents.offboard, `transfer` adds agents.rotate, `keep` adds nothing, all in the same draft.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { setAgentMoved } from "../lifecycle/moved.ts";
import type { Lifecycle } from "../lifecycle/states.ts";
import { type Actor, assertCap, type Grant, loadSubject, type Subject, setKeepRunning, transition } from "../lifecycle/transitions.ts";
import { fail } from "../meta.ts";

export interface AgentDecision {
  agent: string;
  decision: "stop" | "transfer" | "keep";
  reason?: string | undefined;
  newOwner?: string | undefined;
}

const STOPPED: readonly string[] = ["suspended", "leaving"];

/** Runs the choices in the caller's transaction, and answers the agents that get a new key. Only for a subject that is stopped. Stop choices pass the cap once per call, as in lifecycle_set. */
export function applyDecisions(db: Db, s: Subject, decisions: readonly AgentDecision[], actor: Actor, grantsOf: (agent: string) => readonly Grant[], now: number, confirmCount?: number): string[] {
  if (decisions.length > 0 && !STOPPED.includes(s.lifecycle)) fail("decisions_need_stop", "Stop this entry first. Then choose for each agent.", 409);
  if (new Set(decisions.map((d) => d.agent)).size !== decisions.length) fail("input_invalid", "Choose once for each agent.", 400);
  if (decisions.some((d) => d.decision === "stop" && db.prepare("SELECT lifecycle FROM fleet_agents WHERE id = ?").get(d.agent)?.lifecycle !== "leaving")) assertCap(db, confirmCount, now);
  const moved: string[] = [];
  for (const d of decisions) {
    const a = db.prepare("SELECT lifecycle, owner_id FROM fleet_agents WHERE id = ?").get(d.agent) ?? fail("agent_not_found", "No such agent.", 404);
    const mine = s.kind === "agent" ? d.agent === s.id : a.owner_id === s.id;
    if (!mine) fail("agent_not_owned", "This agent does not belong to this entry.", 409);
    const own = a.lifecycle as Lifecycle;
    if (d.decision === "stop") {
      if (own === "leaving") continue;
      const why = s.kind === "person" ? db.prepare("SELECT lifecycle_reason AS r FROM fleet_people WHERE id = ?").get(s.id)?.r : db.prepare("SELECT lifecycle_reason AS r FROM fleet_agents WHERE id = ?").get(s.id)?.r;
      const reason = why === null || why === undefined || why === "migrated" ? "other" : (why as "other");
      transition(db, { kind: "agent", id: d.agent, to: "leaving", reason, actor, noCap: true, grants: grantsOf(d.agent) }, now);
      continue;
    }
    // Keep-running and a new owner lift a stop that comes from the owner. A stop on the agent itself is undone by its own step, not here.
    if (STOPPED.includes(own) || own === "archived") fail("agent_stopped_itself", "This agent has its own stop. Undo that first.", 409);
    if (d.decision === "keep") {
      setKeepRunning(db, d.agent, d.reason ?? "", actor, now);
      continue;
    }
    if (!d.newOwner) fail("input_invalid", "Name the new owner.", 400);
    if (d.newOwner === a.owner_id) fail("input_invalid", "Name a new owner. This is the owner now.", 400);
    setAgentMoved(db, { agent: d.agent, owner: d.newOwner as string }, { kind: "owner", id: actor.id }, now, { transfer: true });
    moved.push(d.agent);
  }
  return moved;
}

/** The expected revision is read before a choice moves it. */
export function subjectAt(db: Db, kind: "person" | "agent", id: string, expectedRev: number | undefined): Subject {
  const s = loadSubject(db, kind, id) ?? fail(kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
  if (expectedRev !== undefined && expectedRev !== s.rev) fail("lifecycle_stale", "This entry changed since you looked. Open it again.", 409);
  return s;
}
