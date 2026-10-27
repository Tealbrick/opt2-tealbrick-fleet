// The slice's agent list in SLICE ORDER (C373 WP-D). The grant picture (`ctx.topology()`) names agents by their index in the
// slice `agents[]`. The SDK hands the app that list in the `agentsChanged` event (needsAgentDirectory) and in no op context,
// so the event handler keeps the last list here, in memory, and `access_get` resolves indexes against it.
//
// Honest limits (also in ARCHITECTURE.md):
//  - The SDK sends `agentsChanged` once after boot and again only when ids, names, modes or statuses change (it compares the
//    list sorted by id). A pure reorder is not announced. Core builds `agents[]` in a stable order, so this is a theoretical gap;
//    when the SDK offers `ctx.agents()` (or topology rows carry the agent id) this file goes away.
//  - Before the first event after a boot the list is empty: `access_get` then answers "unavailable" with a plain note, never a guess.
// Nothing here is persisted and nothing here reaches an agent op.
export interface SliceAgentRef {
  id: string;
  name: string;
}

let list: readonly SliceAgentRef[] = [];

/** Remember the agents of the newest slice, in slice order (the index base of the topology's `agentIdx`). */
export function rememberSliceAgents(agents: readonly SliceAgentRef[]): void {
  list = agents.map((a) => ({ id: a.id, name: a.name }));
}
export function sliceAgents(): readonly SliceAgentRef[] {
  return list;
}
/** Tests only. */
export function forgetSliceAgents(): void {
  list = [];
}
