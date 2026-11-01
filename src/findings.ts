// Differences, computed on read (C380, DESIGN-C380 §4): no table, so nothing can go out of sync. This file holds the differences the
// lifecycle and the slice can show. The sweep lane adds the rows of the store inventories. A finding never changes anything by itself.
import type { Effective, Lifecycle } from "./lifecycle/states.ts";

export const SUSPENDED_TOO_LONG_MS = 30 * 86_400_000;

export interface Finding {
  code: string;
  text: string;
}

export interface FindingInput {
  kind: "person" | "agent";
  lifecycle: Lifecycle;
  effective: Effective;
  /** agents: Core's fact from the slice */
  runtime: "running" | "paused" | "gone" | null;
  hasOwner: boolean;
  ownerLifecycle: string | null;
  reason: string | null;
  at: number;
  validUntil: number | null;
  noCard: boolean;
  handleConflict: boolean;
  /** C381: a person marked leaving with no handle in the directory: nothing can bar their messages */
  noHandleToBar?: boolean | undefined;
  /** N2-6: a person marked leaving whose sender bar Connect has not shown */
  senderBarOpen?: boolean | undefined;
  /** the state of this entry's latest stop plan; null when it has none */
  planState?: string | null | undefined;
  /** a leaving person: Connect accounts tied to nobody that nobody has checked for this person */
  unnamedAccounts?: number | undefined;
  /** Core says this agent's key is gone */
  keyEnded?: boolean | undefined;
  /** the owner changed, from someone, and Core has not replaced the key since */
  keyAfterTransfer?: boolean | undefined;
  /** the owner is not active, and Core has not replaced the key since that */
  ownerMayHoldKey?: boolean | undefined;
  /** Core replaced the key: "yes" Portal shows no key yet, "not_seen" Governance cannot see */
  needsConnect?: "yes" | "not_seen" | null | undefined;
}

/** C381: a new key is never a silent stop. Said the same on the row and the finding. */
export const NEEDS_CONNECT = "The old key is gone. Connect this agent in Portal. It cannot work until then.";
/** How long the line stays with no way to see a connection. */
export const CONNECT_UNSEEN_MS = 14 * 86_400_000;

/** An agent with its own stop: a paused agent's key is refused, and the key itself stays until the owner chooses. Said the same on the row, the plan and the finding. */
export const KEY_STILL_EXISTS = "Paused. The key still exists. Resume this agent, or use Stop and remove access.";

const f = (code: string, text: string): Finding => ({ code, text });

// A finding may know since when it holds, so an acceptance older than that does not cover it. It is kept beside the finding, not in it: the
// manifest output of a finding has exactly `code` and `text`.
const NEWEST = new WeakMap<Finding, number>();
export const stampFinding = (finding: Finding, at: number): void => void NEWEST.set(finding, at);
export const stampOf = (finding: Finding): number | null => NEWEST.get(finding) ?? null;

export function findingsOf(r: FindingInput, now: number): Finding[] {
  const out: Finding[] = [];
  const agent = r.kind === "agent";
  const stoppedIntent = r.effective === "suspended" || r.effective === "leaving" || r.effective === "archived";
  // A normal Close leaves a paused card. Back means it runs again, or a row the migration closed with no card has one.
  if (agent && r.lifecycle === "archived" && (r.runtime === "running" || (r.noCard && r.runtime !== "gone"))) out.push(f("card_back_after_close", "This entry is closed, but Portal lists the agent again."));
  else if (agent && stoppedIntent && r.runtime === "running") out.push(f("not_stopped", "Governance says stop, but this agent still runs in Portal."));
  if (agent && (r.lifecycle === "active" || (r.lifecycle === "proposed" && r.reason !== null)) && !stoppedIntent && r.runtime === "paused") out.push(f("paused_outside", "This agent is paused in Portal, but Governance does not say stop. Resume it in Portal if it should work."));
  if (agent && r.lifecycle === "proposed" && r.runtime === "running") out.push(f("running_unapproved", "This agent works and is not reviewed."));
  if (agent && (r.lifecycle === "active" || r.lifecycle === "proposed") && r.runtime === "gone") out.push(f("card_gone", "Portal no longer lists this agent."));
  if (agent && r.lifecycle !== "archived" && r.runtime !== "gone" && !r.hasOwner) out.push(f("no_owner", "This agent has no owner. It keeps working. Name an owner."));
  if (agent && r.hasOwner && r.lifecycle !== "archived" && r.ownerLifecycle !== null && r.ownerLifecycle !== "active") out.push(f("owner_inactive", r.ownerMayHoldKey ? "This agent needs an owner: its owner is not active, and may still hold its key. It keeps working. Name a new owner and make a new key." : "This agent needs an owner: its owner is not active. It keeps working. Name a new owner."));
  if (r.lifecycle === "leaving" && !r.planState) out.push(f("leaving_no_plan", r.reason === "migrated" ? "This entry was marked as departed before plans existed. Open it and make a plan." : "This entry is leaving, and no plan was made. Open it and make a plan."));
  if (r.kind === "person" && r.lifecycle === "leaving" && (r.unnamedAccounts ?? 0) > 0) out.push(f("unlinked_account", `${r.unnamedAccounts} accounts in Connect have no person. Check them. If none is this person's, accept this with a reason.`));
  if (agent && r.effective === "suspended" && r.runtime === "paused" && !r.keyEnded) out.push(f("key_not_decided", KEY_STILL_EXISTS));
  if (r.noHandleToBar) out.push(f("no_handle_to_bar", "This person has no channel handle in the directory, so Governance cannot bar their messages. Add their handles."));
  if (r.senderBarOpen) out.push(f("sender_bar_open", "Messages from this person can still reach agents. Connect has not shown the bar yet."));
  if (agent && r.keyAfterTransfer && r.lifecycle !== "archived" && r.runtime !== "gone") out.push(f("key_after_transfer", "The owner changed, and the old owner may still hold this agent's key. Make a new key. The agent must then be connected again."));
  if (agent && r.needsConnect === "yes") out.push(f("connect_again", NEEDS_CONNECT));
  if (agent && r.needsConnect === "not_seen") out.push(f("connect_again", "The old key is gone. If you did not connect this agent again, do it in Portal. Governance cannot see this. Turn on 'See who has access'."));
  if (r.planState === "expired" && (r.lifecycle === "suspended" || r.lifecycle === "leaving")) out.push(f("plan_expired", "A request ran out of time before you approved it. Nothing in it was applied. Ask again."));
  if (r.lifecycle === "suspended" && r.at + SUSPENDED_TOO_LONG_MS < now) out.push(f("suspended_too_long", "This entry has been stopped for more than 30 days. Decide what comes next."));
  if ((r.lifecycle === "active" || r.lifecycle === "proposed") && r.validUntil !== null && r.validUntil <= now) out.push(f("date_passed", "The end date has passed. The stop waits for the next check, or for the limit on stops to clear."));
  if (r.handleConflict) out.push(f("agent_handle_conflict", "Connect gives this agent a handle that also belongs to a person. The handle is left out for this agent."));
  return out;
}
