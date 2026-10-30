// The owner's choice for each agent at a stop (C380 D2). No choice is the default: the agent is only paused, because offboarding has no
// quick undo. Plain logic, so a test can run it without a DOM.
export type Choice = "later" | "stop" | "transfer" | "keep";
export type AgentChoice = { choice: Choice; reason: string; newOwner: string };
export type Choices = Readonly<Record<string, AgentChoice>>;
export type Decision = { agent: string; decision: "stop" | "transfer" | "keep"; reason?: string; newOwner?: string };

export const LATER: AgentChoice = { choice: "later", reason: "", newOwner: "" };
export const choiceOf = (all: Choices, id: string): AgentChoice => all[id] ?? LATER;

/** An agent already leaving or closed has nothing to choose. */
export const canChoose = (a: { lifecycle: string }) => a.lifecycle === "proposed" || a.lifecycle === "active" || a.lifecycle === "suspended";
/** An agent with its own stop can go on to Stop and remove; keeping or moving it needs that stop undone first (server: agent_stopped_itself). */
export const hasOwnStop = (a: { lifecycle: string }) => a.lifecycle === "suspended";

/** What goes in plan_send: only what the owner chose. An agent left at "later" is not in the list. */
export function decisionsOf(agents: readonly { id: string }[], all: Choices): Decision[] {
  const out: Decision[] = [];
  for (const a of agents) {
    const c = choiceOf(all, a.id);
    if (c.choice === "stop") out.push({ agent: a.id, decision: "stop" });
    else if (c.choice === "keep") out.push({ agent: a.id, decision: "keep", reason: c.reason.trim() });
    else if (c.choice === "transfer") out.push({ agent: a.id, decision: "transfer", newOwner: c.newOwner });
  }
  return out;
}

/** A keep needs a named reason, and a transfer a new owner. */
export const choicesReady = (agents: readonly { id: string }[], all: Choices): boolean =>
  agents.every((a) => {
    const c = choiceOf(all, a.id);
    return c.choice === "keep" ? c.reason.trim().length > 0 : c.choice === "transfer" ? c.newOwner.length > 0 : true;
  });

export function choiceSummary(agents: readonly { id: string }[], all: Choices): string {
  const n = (x: Choice) => agents.filter((a) => choiceOf(all, a.id).choice === x).length;
  return `${n("later")} paused and decided later, ${n("stop")} stopped and removed, ${n("transfer")} moved to a new owner, ${n("keep")} kept running`;
}
