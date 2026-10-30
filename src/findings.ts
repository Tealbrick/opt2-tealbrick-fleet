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
  /** the state of this entry's latest stop plan; null when it has none */
  planState?: string | null | undefined;
  /** a leaving person: Connect accounts tied to nobody that nobody has checked for this person */
  unnamedAccounts?: number | undefined;
  /** Core says this agent's key is gone */
  keyEnded?: boolean | undefined;
}

/** D2: one approval stops access, and a paused agent's key is refused. The key itself stays until the owner chooses. Said the same on the row, the plan and the finding. */
export const KEY_STILL_EXISTS = "Paused. The key still exists until you choose.";

const f = (code: string, text: string): Finding => ({ code, text });

export function findingsOf(r: FindingInput, now: number): Finding[] {
  const out: Finding[] = [];
  const agent = r.kind === "agent";
  const stoppedIntent = r.effective === "suspended" || r.effective === "leaving" || r.effective === "archived";
  // A normal Close leaves a paused card. Back means it runs again, or a row the migration closed with no card has one.
  if (agent && r.lifecycle === "archived" && (r.runtime === "running" || (r.noCard && r.runtime !== "gone"))) out.push(f("card_back_after_close", "This entry is closed, but Portal lists the agent again."));
  else if (agent && stoppedIntent && r.runtime === "running") out.push(f("not_stopped", "Governance says stop, but this agent still runs in Portal."));
  if (agent && (r.lifecycle === "active" || (r.lifecycle === "proposed" && r.reason !== null)) && !stoppedIntent && r.runtime === "paused") out.push(f("paused_outside", "This agent is paused in Portal, but Governance does not say stop."));
  if (agent && r.lifecycle === "proposed" && r.runtime === "running") out.push(f("running_unapproved", "This agent works and is not reviewed."));
  if (agent && (r.lifecycle === "active" || r.lifecycle === "proposed") && r.runtime === "gone") out.push(f("card_gone", "Portal no longer lists this agent."));
  if (agent && r.lifecycle !== "archived" && r.runtime !== "gone" && !r.hasOwner) out.push(f("no_owner", "This agent has no owner. Name an owner."));
  if (agent && r.hasOwner && r.lifecycle !== "archived" && r.ownerLifecycle !== null && r.ownerLifecycle !== "active") out.push(f("owner_inactive", "The owner of this agent is not active. Name another owner."));
  if (r.lifecycle === "leaving" && !r.planState) out.push(f("leaving_no_plan", r.reason === "migrated" ? "This entry was marked as departed before plans existed. Open it and make a plan." : "This entry is leaving, and no plan was made. Open it and make a plan."));
  if (r.kind === "person" && r.lifecycle === "leaving" && (r.unnamedAccounts ?? 0) > 0) out.push(f("unlinked_account", `${r.unnamedAccounts} accounts in Connect have no person. Check them. If none is this person's, accept this with a reason.`));
  if (agent && r.effective === "suspended" && r.runtime === "paused" && !r.keyEnded) out.push(f("key_not_decided", KEY_STILL_EXISTS));
  if (r.planState === "expired" && (r.lifecycle === "suspended" || r.lifecycle === "leaving")) out.push(f("plan_expired", "A stop request ran out of time before you approved it. Nothing in it was applied. Ask again."));
  if (r.lifecycle === "suspended" && r.at + SUSPENDED_TOO_LONG_MS < now) out.push(f("suspended_too_long", "This entry has been stopped for more than 30 days. Decide what comes next."));
  if ((r.lifecycle === "active" || r.lifecycle === "proposed") && r.validUntil !== null && r.validUntil <= now) out.push(f("date_passed", "The end date has passed. The stop waits for the next check, or for the limit on stops to clear."));
  if (r.handleConflict) out.push(f("agent_handle_conflict", "Connect gives this agent a handle that also belongs to a person. The handle is left out for this agent."));
  return out;
}
