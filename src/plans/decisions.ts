// Per-agent choices when a person stops or leaves (C380 D2, changed by C381). An agent works on through the person's change. The owner chooses a new owner, with or without a new key,
// or an explicit stop. No choice changes nothing for the agent: it runs, and a finding says it needs an owner. The one Portal step of a move is the new key (D16); it is never silent.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { setAgentMoved } from "../lifecycle/moved.ts";
import { type Actor, assertCap, type Grant, loadSubject, type Subject, transition } from "../lifecycle/transitions.ts";
import { fail } from "../meta.ts";

export interface AgentDecision {
  agent: string;
  decision: "stop" | "transfer";
  newOwner?: string | undefined;
  /** transfer: a new key, because the old owner may hold this one. Absent means yes. With no: a finding stays until a new key exists. */
  newKey?: boolean | undefined;
}

const STOPPED: readonly string[] = ["suspended", "leaving"];

/** Runs the choices in the caller's transaction, and answers the agents that get a new key. Only for a subject that is stopped. Stop choices pass the cap once per call, as in lifecycle_set. */
export function applyDecisions(db: Db, s: Subject, decisions: readonly AgentDecision[], actor: Actor, grantsOf: (agent: string) => readonly Grant[], now: number, confirmCount?: number): string[] {
  if (decisions.length > 0 && !STOPPED.includes(s.lifecycle)) fail("decisions_need_stop", "Mark this entry first. Then choose for each agent.", 409);
  if (new Set(decisions.map((d) => d.agent)).size !== decisions.length) fail("input_invalid", "Choose once for each agent.", 400);
  assertCap(db, confirmCount, now, decisions.filter((d) => d.decision === "stop" && db.prepare("SELECT lifecycle FROM fleet_agents WHERE id = ?").get(d.agent)?.lifecycle !== "leaving").map((d) => `agent:${d.agent}`));
  const newKeys: string[] = [];
  for (const d of decisions) {
    const a = db.prepare("SELECT lifecycle, owner_id FROM fleet_agents WHERE id = ?").get(d.agent) ?? fail("agent_not_found", "No such agent.", 404);
    const mine = s.kind === "agent" ? d.agent === s.id : a.owner_id === s.id;
    if (!mine) fail("agent_not_owned", "This agent does not belong to this entry.", 409);
    if (d.decision === "stop") {
      if (a.lifecycle === "leaving") continue;
      const why = s.kind === "person" ? db.prepare("SELECT lifecycle_reason AS r FROM fleet_people WHERE id = ?").get(s.id)?.r : db.prepare("SELECT lifecycle_reason AS r FROM fleet_agents WHERE id = ?").get(s.id)?.r;
      const reason = why === null || why === undefined || why === "migrated" ? "other" : (why as "other");
      transition(db, { kind: "agent", id: d.agent, to: "leaving", reason, actor, noCap: true, grants: grantsOf(d.agent) }, now);
      continue;
    }
    if (a.lifecycle === "archived") fail("agent_closed", "This agent is closed. It cannot move to a new owner.", 409);
    // A new plan replaces the old draft: a move of an agent on its way out would drop that removal with no word.
    if (a.lifecycle === "leaving") fail("agent_closed", "This agent is being stopped and removed. Undo that first.", 409);
    if (!d.newOwner) fail("input_invalid", "Name the new owner.", 400);
    if (d.newOwner === a.owner_id) fail("input_invalid", "Name a new owner. This is the owner now.", 400);
    setAgentMoved(db, { agent: d.agent, owner: d.newOwner as string }, { kind: "owner", id: actor.id }, now);
    if (d.newKey !== false) newKeys.push(d.agent);
  }
  return newKeys;
}

/** The expected revision is read before a choice moves it. */
export function subjectAt(db: Db, kind: "person" | "agent", id: string, expectedRev: number | undefined): Subject {
  const s = loadSubject(db, kind, id) ?? fail(kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
  if (expectedRev !== undefined && expectedRev !== s.rev) fail("lifecycle_stale", "This entry changed since you looked. Open it again.", 409);
  return s;
}
