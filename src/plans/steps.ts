// The states of a plan and of its steps (C380, DESIGN-C380 §5). Pure: no I/O. The database has no CHECK on them; this file is the one place
// that knows them. "Nothing is done until proved by its owner": only `done` means proved. What Core or an app merely says stays apart.

/** Waits for the owner, for a store or for the slice. */
export const OPEN_PLAN_STATES = ["preparing", "waiting", "applying", "running", "partial"] as const;
/** Nothing runs any more, and the owner can ask again with plan_retry. */
export const ENDED_PLAN_STATES = ["done", "reported", "expired", "rejected", "withdrawn", "replaced", "cancelled", "stale", "failed", "lost"] as const;
export type PlanState = (typeof OPEN_PLAN_STATES)[number] | (typeof ENDED_PLAN_STATES)[number];
export const isOpenPlan = (s: string): boolean => (OPEN_PLAN_STATES as readonly string[]).includes(s);

export type StepState =
  | "pending" // nothing sent yet
  | "sending" // attempt and key persisted; the call may have run: only a fresh list tells
  | "claimed" // the store says revoked; a fresh list has not shown it yet
  | "waiting" // held for the owner in the store's approval page; the key stays
  | "refused" // Rules or the owner refused; "Try again" takes a new attempt
  | "failed" // retried by the job, at most MAX_TRIES, then by "Try again"
  | "changed" // the store's row is not what the owner saw
  | "not_revocable" // the store waits for the agent to stop (agent_running)
  | "not_read" // the store did not answer. Never zero
  | "pending_bridge" // Core says done, the slice does not show it yet
  // final
  | "done" // proved by its owner: the slice, or a fresh list of the store
  | "reported" // Core says it did this; Governance cannot see it. Never shown as done
  | "not_provable" // no Core answer and no view: the owner acts in Portal, Governance cannot check
  | "manual" // no version can end this from here: someone acts by hand
  | "listed" // kept, listed for the record
  | "not_installed"
  | "excepted"
  | "cancelled";

export const FINAL_STEP_STATES: readonly StepState[] = ["done", "reported", "not_provable", "manual", "listed", "not_installed", "excepted", "cancelled"];
export const isFinalStep = (s: string): boolean => (FINAL_STEP_STATES as readonly string[]).includes(s);
/** Needs the owner's "Try again" or a new plan; the job does not move it by itself. */
const OWNER_MUST_ACT: readonly string[] = ["refused", "changed"];
export const MAX_TRIES = 6;

export interface StepRow {
  phase: string;
  state: string;
  tries: number;
  code: string | null;
}

/** A failed step the job does not retry any more, or one that only the owner can move. */
export function stuckStep(s: StepRow): boolean {
  if (OWNER_MUST_ACT.includes(s.state)) return true;
  if (s.state === "not_revocable") return s.tries >= MAX_TRIES;
  return s.state === "failed" && (s.tries >= MAX_TRIES || s.code === "idempotency_conflict");
}

/** The state of a plan whose draft is finished or absent: from its steps only. `done` needs every step proved or stated as a limit. */
export function stateFromSteps(steps: readonly StepRow[]): Extract<PlanState, "running" | "partial" | "done" | "reported"> {
  if (steps.some(stuckStep)) return "partial";
  if (steps.some((s) => !isFinalStep(s.state))) return "running";
  return steps.some((s) => s.state === "reported" || s.state === "not_provable") ? "reported" : "done";
}

/** The kinds a store ends by pausing: the row stays and reads `paused`. For every other kind only absence proves the end: an account row reads `paused` when its AGENT is paused. */
export const ENDS_BY_PAUSE: readonly string[] = ["routine"];

/** Past a job's timeout (5 min). */
export const TICK_LEASE_MS = 6 * 60_000;
export const POLL_FAST_MS = 60_000;
export const POLL_SLOW_MS = 15 * 60_000;
export const FAST_WINDOW_MS = 30 * 60_000;
/** "Portal stopped mid-way": a draft `applying` for longer than this. */
export const APPLYING_STUCK_MS = 30 * 60_000;
export const LIST_BACKOFF_MS = 15 * 60_000;
export const HOLD_RECHECK_MS = 5 * 60_000;
export const REISSUE_MS = 86_400_000;
export const STEPS_PER_DRAFT = 100;
export const DEFAULT_EXPIRES_SEC = 86_400;
export const DRAFT_TITLE = "Governance: stop request";
