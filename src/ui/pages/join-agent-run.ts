// Sends the Join of a new agent (C380 T2-d): its owner, its team, then the review. In that order, and the review is last: nothing is
// marked as reviewed until the owner and the team are saved, and an owner is a guard of the review (T2). Each step is kept when it
// went through, so "Send again" goes on from the step that failed and never repeats one that worked. No React.
import type { ColleagueGetOutput, OverviewGetOutput } from "#kit";
import type { Deps } from "./join-run.ts";

export interface AgentJoin {
  agent: string;
  /** the owner to set, or null to leave it */
  owner: string | null;
  /** the team to put the agent in, or null */
  team: string | null;
  /** the last day as an instant, or null */
  until: string | null;
  /** the owner chose "no end" and the agent has a last day already: it is removed */
  clearUntil?: boolean;
}
export type Step = "owner" | "team" | "review";
export interface AgentRun {
  batch: string;
  done: Set<Step>;
  /** the step that failed and what the server said; null while nothing failed */
  failed: { step: Step; message: string } | null;
  teamName: string | null;
  tries: number;
}
export const newAgentRun = (batch: string): AgentRun => ({ batch, done: new Set(), failed: null, teamName: null, tries: 0 });

/** Runs every step that is not done. Stops at the first that fails. */
export async function sendAgentJoin(run: AgentRun, j: AgentJoin, deps: Deps): Promise<void> {
  run.failed = null;
  run.tries++;
  const at = (step: Step, e: unknown) => {
    run.failed = { step, message: deps.say(e) };
  };
  if (j.owner && !run.done.has("owner")) {
    try {
      await deps.call("agent_set", { agent: j.agent, owner: j.owner }, `join-${run.batch}-owner`);
      run.done.add("owner");
    } catch (e) {
      return at("owner", e);
    }
  }
  if (j.team && !run.done.has("team")) {
    try {
      const dir = await deps.call<OverviewGetOutput>("overview_get", {}, `join-${run.batch}-dir-${run.tries}`);
      const team = dir.teams.find((t) => t.id === j.team);
      if (!team) throw Object.assign(new Error("This team is gone. Choose a team on the People page."), { code: "team_not_found" });
      const members = team.members ?? [];
      const people = members.filter((m) => m.kind === "person").map((m) => ({ id: m.id, role: m.role }));
      const agents = members.filter((m) => m.kind === "agent").map((m) => ({ id: m.id, role: m.role }));
      if (!agents.some((a) => a.id === j.agent)) agents.push({ id: j.agent, role: "member" as const });
      await deps.call("members_set", { team: team.id, people, agents }, `join-${run.batch}-team-${run.tries}`);
      run.teamName = team.name;
      run.done.add("team");
    } catch (e) {
      return at("team", e);
    }
  }
  if (!run.done.has("review")) {
    try {
      // the revision is read now: the owner step above may have moved the entry
      const now = await deps.call<ColleagueGetOutput>("colleague_get", { kind: "agent", id: j.agent }, `join-${run.batch}-get-${run.tries}`);
      const input: Record<string, unknown> = { kind: "agent", id: j.agent, to: "active", reason: "reviewed", expectedRev: now.colleague.rev };
      if (j.until) input.validUntil = j.until;
      else if (j.clearUntil) input.validUntil = null;
      await deps.call("lifecycle_set", input, `join-${run.batch}-review-${run.tries}`);
      run.done.add("review");
    } catch (e) {
      return at("review", e);
    }
  }
}
