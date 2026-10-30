// Plan, "Portal link" mode (C380, DESIGN-C380 §5): the skeleton's only mode. Governance applies nothing. It lists the exact Portal
// actions, and proves each from the slice: paused from agents[].status, access from the topology when the owner consented and it is not
// truncated. Computed on read, no table. What the slice cannot prove says so; it is never shown as done.
import type { DecodedTopology } from "../topology-slice.ts";

export type StepAction = "pause" | "remove_access" | "resume" | "reinstate";
export type StepState = "open" | "done" | "not_provable";
export interface PortalStep {
  id: string;
  agent: { id: string; name: string };
  action: StepAction;
  text: string;
  state: StepState;
  proof: string;
}
export interface PortalPlan {
  mode: "portal_link";
  applied: false;
  headline: string;
  portalUrl: string | null;
  steps: PortalStep[];
  openSteps: number;
  notChanged: string[];
  note: string | null;
}

export const NOT_APPLIED = "Not applied: do these in Portal";
/** The manifest's maxItems of `plan.steps`. */
export const MAX_STEPS = 400;

/** The Confirm screen's "Not changed" block (DESIGN-C380 §9). On the screen, not only in docs. */
export const NOT_CHANGED: readonly string[] = [
  "Their own logins, such as Slack, Google or a bank.",
  "The agent's machine and its native tools.",
  "Copies of data that were already made.",
  "Other people with the shared Portal login. Change the Portal login if they had it.",
  "Engine steps after an agent step.",
  "Scheduled posts before you approve.",
  "Channels or groups the person is still in. The sender bar does not cover them.",
  "Messages that agents read through tool accounts.",
  "Messages stored before the bar. Data apps can still read them.",
  "New handles of this person. The bar covers the handles known now.",
  "Edits the person makes to their own direct messages older than 30 days.",
  "Email, Teams and Discord. Governance bars Buzz, Slack and Telegram handles only. Use the Accounts page in Connect for the others.",
];

export interface PlanAgent {
  id: string;
  name: string;
  /** own lifecycle */
  lifecycle: string;
  effective: string;
  runtime: "running" | "paused" | "gone" | null;
  /** it left before (a leaving snapshot exists): bringing it back needs Portal's reinstate */
  wasStopped: boolean;
}

function accessProof(a: PlanAgent, topology: DecodedTopology | null): { state: StepState; proof: string } {
  if (a.runtime === "gone") return { state: "done", proof: "Portal no longer lists this agent." };
  if (!topology) return { state: "not_provable", proof: "Governance cannot see this. Turn on 'See who has access' to check it here." };
  if (topology.truncated) return { state: "not_provable", proof: "The list of access is too long to check here. Check it in Portal." };
  const edges = topology.edges.filter((e) => e.agent === a.id).length;
  const keys = topology.connections.filter((c) => c.agt === a.id && c.status === "active").length;
  if (edges === 0 && keys === 0) return { state: "done", proof: "Portal shows no app access and no connection." };
  return { state: "open", proof: `Portal shows ${edges} app access and ${keys} connections.` };
}

function stepsFor(a: PlanAgent, topology: DecodedTopology | null): PortalStep[] {
  const ref = { id: a.id, name: a.name };
  const out: PortalStep[] = [];
  const stop = a.effective === "suspended" || a.effective === "leaving" || a.effective === "archived";
  if (stop && a.runtime !== "gone") {
    const paused = a.runtime === "paused";
    out.push({ id: `pause:${a.id}`, agent: ref, action: "pause", text: `Pause ${a.name} in Portal.`, state: paused ? "done" : "open", proof: paused ? "Portal shows this agent as paused." : "Portal shows this agent as running." });
  }
  if (a.lifecycle === "leaving" || a.lifecycle === "archived") {
    out.push({ id: `access:${a.id}`, agent: ref, action: "remove_access", text: `Remove the app access and the connections of ${a.name} in Portal.`, ...accessProof(a, topology) });
  }
  if (!stop && a.runtime === "paused" && !(a.lifecycle === "proposed" && a.wasStopped)) {
    out.push({ id: `resume:${a.id}`, agent: ref, action: "resume", text: `Resume ${a.name} in Portal.`, state: "open", proof: "Portal shows this agent as paused." });
  }
  if (!stop && a.runtime === "paused" && a.lifecycle === "proposed" && a.wasStopped) {
    out.push({ id: `reinstate:${a.id}`, agent: ref, action: "reinstate", text: `To bring ${a.name} back, reinstate it in Portal and grant its access again.`, state: "open", proof: "Portal shows this agent as paused." });
  }
  return out;
}

export function portalPlan(agents: readonly PlanAgent[], topology: DecodedTopology | null, portalUrl: string | null, note: string | null = null): PortalPlan {
  const steps = agents.flatMap((a) => stepsFor(a, topology));
  const more = steps.length > MAX_STEPS ? `${steps.length - MAX_STEPS} more steps are not shown. Do these first, then open this page again.` : null;
  return { mode: "portal_link", applied: false, headline: NOT_APPLIED, portalUrl, steps: steps.slice(0, MAX_STEPS), openSteps: steps.filter((s) => s.state === "open").length, notChanged: [...NOT_CHANGED], note: more ?? note };
}
