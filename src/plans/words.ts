// Plain words for a plan (C380, DESIGN-C380 §10). Each sentence says only what its state proves: `done` words are for proofs, the others say who said what.
import { TARGET_NAMES } from "../access/items.ts";
import { KEY_STILL_EXISTS } from "../findings.ts";
import type { Row } from "./plan.ts";
import { MAX_TRIES } from "./steps.ts";

const NAMES: Record<string, string> = { ...TARGET_NAMES, core: "Portal" };
export const storeName = (t: string): string => NAMES[t] ?? t;

export function coreLabel(op: string, name: string): string {
  if (op === "agents.pause") return `Pause ${name}`;
  if (op === "agents.offboard") return `Stop ${name} and remove its access`;
  return `Remove the old key of ${name}`;
}

/** `undecided`: this agent is paused now, and no choice was made for it. */
export function coreStepText(s: Row, mode: string, undecided = false): string {
  const state = String(s.state);
  const pause = s.op === "agents.pause";
  switch (state) {
    case "pending":
      return mode === "portal_link" ? "Not applied: do this in Portal" : "Waiting for you in Portal";
    case "pending_bridge":
      return "Portal says this is done. The bridge has not shown it yet.";
    case "done":
      return pause ? (undecided ? KEY_STILL_EXISTS : "Stopped at the bridge.") : s.op === "agents.offboard" ? "Stopped at the bridge. Portal shows no access left." : "Portal shows no old key left.";
    case "reported":
      return String(s.detail ?? "Portal says this is done. Governance cannot see it.");
    case "not_provable":
      return String(s.detail ?? "Governance cannot see this. Check it in Portal.");
    case "failed":
      return `Portal could not do this. Open Portal and apply it again. ${String(s.detail ?? "")}`.trim();
    default:
      return "Not done.";
  }
}

export function itemStepText(s: Row): string {
  const app = storeName(String(s.target));
  switch (String(s.state)) {
    case "pending":
      return s.phase === "after" ? "Waits for the stop in Portal." : "Waits its turn.";
    case "sending":
      return `Governance asked ${app}. The answer is not known yet.`;
    case "claimed":
      return `${app} says this ended. Governance is checking.`;
    case "waiting":
      return `Waiting for approval. ${app} asked for it.`;
    case "refused":
      return `${app} refused: ${String(s.detail ?? s.code ?? "no reason given")}`;
    case "failed":
      return s.code === "still_listed" ? `${app} says this ended, but it still lists it.` : `${app} could not end this.`;
    case "changed":
      return "This changed since you looked. Nothing was done. Make a new plan to end it.";
    case "not_revocable":
      return Number(s.tries) >= MAX_TRIES ? `${app} still sees this agent as running. Try again when Portal shows it stopped.` : "Waits for the agent to stop.";
    case "done":
      return s.item_kind === "routine" ? `${app} shows this as paused.` : `${app} no longer lists this.`;
    case "reported":
      return String(s.detail ?? `${app} says this ended. This version cannot list it.`);
    case "excepted":
      return "You accepted this. It stays.";
    case "not_provable":
      return String(s.detail ?? `Governance cannot see this. Check it in ${app}.`);
    case "manual":
      return `Governance cannot end this. Someone must do it in ${app}.`;
    case "listed":
      return "Stays. Nothing was changed.";
    case "not_installed":
      return `${app} is not installed.`;
    default:
      return "Not done.";
  }
}

export function readText(s: Row): string | null {
  const app = storeName(String(s.target));
  switch (String(s.state)) {
    case "done":
      return null;
    case "not_installed":
      return "Not installed";
    case "refused":
      return `${app} refused this read: ${String(s.detail ?? s.code ?? "no reason given")}`;
    case "waiting":
      return `A person must approve this read in ${app}.`;
    case "pending":
      return "Not read yet.";
    default:
      return "Could not be read";
  }
}

export function headlineOf(p: Row, counts: { proved: number; said: number; manual: number; open: number }): string {
  const link = p.rail === "portal_link";
  switch (String(p.state)) {
    case "preparing":
      return p.code === "owner_drafts_full" ? "Too many requests wait for you in Portal. This one is next." : p.code ? "Portal does not answer. Governance tries again." : "Governance is preparing this.";
    case "waiting":
      return link ? "Not applied: do these in Portal" : "Waiting for you in Portal";
    case "applying":
      return p.code === "portal_stopped" ? "Portal stopped mid-way. Open Portal and check." : "Portal is applying this.";
    case "running":
      return link ? `${counts.open} still open.` : `Portal applied this. ${counts.open} still open.`;
    case "partial":
      return p.code === "core_failed" ? "Portal stopped on a step. Open Portal and apply it again." : "Part of this did not work. Look at the open steps.";
    case "done":
      if (counts.manual > 0) return `Governance did its part. ${counts.manual} are for someone to do by hand.`;
      return counts.proved > 0 ? "Done. Each step is proved by the app or Portal that owns it." : "Nothing was left to end.";
    case "reported":
      return link ? `Governance could not see ${counts.said} of the steps. Check them in Portal.` : `Portal says this is done. Governance could not see ${counts.said} of the steps.`;
    case "expired":
      return p.code === "partly_applied" ? "This request expired after Portal did part of it. Look at the steps." : "This request expired. Nothing in it was applied.";
    case "rejected":
      return p.code === "partly_applied" ? "This request was rejected after Portal did part of it. Look at the steps." : "This request was rejected in Portal. Nothing in it was applied.";
    case "withdrawn":
      return p.code === "not_taken_back" ? NOTE_NOT_TAKEN_BACK : p.code === "partly_applied" ? "This request was taken back after Portal did part of it. Look at the steps." : "This request was taken back.";
    case "replaced":
      return "A newer plan replaced this one.";
    case "cancelled":
      return "You cancelled this plan. What was already applied stays.";
    case "stale":
      return "This entry changed after you confirmed. Nothing more runs. Make a new plan.";
    case "lost":
      return "Portal no longer knows this request. Ask again.";
    default:
      return p.code === "core_mismatch" ? "Portal answered about other steps. Nothing more runs. Open Portal and check." : "This could not be asked. Governance stopped.";
  }
}

export const noteKeys = (n: number): string => `${n === 1 ? "1 agent stays" : `${n} agents stay`} paused with the key. Choose for each: stop and remove, move to a new owner, or keep running.`;
export const NOTE_NOT_REACHED = "Portal did not answer when you asked to take this back, so it could still be applied. Try that again.";
export const NOTE_APPROVED_FIRST = "You approved this part in Portal first. It cannot be taken back here.";
export const NOTE_MIXED = "The parts of this plan do not all have the same state. Read each part.";
export const NOTE_STILL_STOPPED = "This entry is still marked as stopped.";
export const NOTE_NOT_TAKEN_BACK = "Governance could not take this request back. If it is still in Portal, reject it there.";
export const NOTE_CONSENT = "To let Governance prepare this for you, turn on 'See who has access' for Governance in Portal.";
export const NOTE_RAIL_OFF = "Portal cannot take a request from Governance here.";
