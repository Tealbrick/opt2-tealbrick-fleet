// The owner's choice for each agent when a person leaves (C380 D2, changed by C381). An agent works on through a person's change. The default is a move to a new owner: the
// workspace default owner when one is set. A new key is ticked by default for a person leaving (D16): the old owner may hold the key. An explicit stop stays a choice. Plain logic, so a test can run it without a DOM.
export type Choice = "move" | "stop" | "later";
export type AgentChoice = { choice: Choice; newOwner: string; newKey: boolean };
export type Choices = Readonly<Record<string, AgentChoice>>;
export type Decision = { agent: string; decision: "stop" } | { agent: string; decision: "transfer"; newOwner: string; newKey: boolean };
/** What an agent starts with on this page. */
export type ChoiceDefaults = { owner: string; newKey: boolean };

/** No owner can take it: nobody to move it to, so the only starting point is "name one later". */
export const defaultChoice = (d: ChoiceDefaults, canMove: boolean): AgentChoice => ({ choice: canMove ? "move" : "later", newOwner: d.owner, newKey: d.newKey });
export const choiceOf = (all: Choices, id: string, d: ChoiceDefaults, canMove = true): AgentChoice => all[id] ?? defaultChoice(d, canMove);

/** An agent already leaving or closed has nothing to choose. */
export const canChoose = (a: { lifecycle: string }) => a.lifecycle === "proposed" || a.lifecycle === "active" || a.lifecycle === "suspended";

/** What goes in plan_send. An agent left at "later" is not in the list: it keeps running, and a finding says it needs an owner. */
export function decisionsOf(agents: readonly { id: string }[], all: Choices, d: ChoiceDefaults, canMove = true): Decision[] {
  const out: Decision[] = [];
  for (const a of agents) {
    const c = choiceOf(all, a.id, d, canMove);
    if (c.choice === "stop") out.push({ agent: a.id, decision: "stop" });
    else if (c.choice === "move") out.push({ agent: a.id, decision: "transfer", newOwner: c.newOwner, newKey: c.newKey });
  }
  return out;
}

/** A move needs a new owner. */
export const choicesReady = (agents: readonly { id: string }[], all: Choices, d: ChoiceDefaults, canMove = true): boolean => agents.every((a) => {
  const c = choiceOf(all, a.id, d, canMove);
  return c.choice !== "move" || c.newOwner.length > 0;
});

/** The ids the owner chose to stop: only their things would stop. */
export const stoppingOf = (agents: readonly { id: string }[], all: Choices, d: ChoiceDefaults, canMove = true): string[] => agents.filter((a) => choiceOf(all, a.id, d, canMove).choice === "stop").map((a) => a.id);

const counted = (n: number, what: string) => `${n} ${what}`;

export function choiceSummary(agents: readonly { id: string }[], all: Choices, d: ChoiceDefaults, canMove = true): string {
  const list = agents.map((a) => choiceOf(all, a.id, d, canMove));
  const moves = list.filter((c) => c.choice === "move");
  const keys = moves.filter((c) => c.newKey).length;
  return [counted(moves.length, keys === moves.length || keys === 0 ? `move to a new owner${moves.length > 0 && keys > 0 ? " with a new key" : ""}` : `move to a new owner, ${keys} of them with a new key`), counted(list.filter((c) => c.choice === "stop").length, "stop and remove"), counted(list.filter((c) => c.choice === "later").length, "keep this owner for now")].join(", ");
}

/** D16: a new key is never a silent stop. The sentence the owner reads before any approval, or null with no new key. */
export function newKeyEffect(agents: readonly { id: string; name: string }[], all: Choices, d: ChoiceDefaults, canMove = true): string | null {
  const names = agents.filter((a) => {
    const c = choiceOf(all, a.id, d, canMove);
    return c.choice === "move" && c.newKey;
  }).map((a) => a.name);
  if (names.length === 0) return null;
  return `New key: ${names.join(", ")}. ${names.length === 1 ? "It keeps working until you approve in Portal. Then the old key stops, and it cannot work until you connect it again." : "They keep working until you approve in Portal. Then the old keys stop, and they cannot work until you connect them again."}`;
}
