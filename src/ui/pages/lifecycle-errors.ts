// Plain sentences for what `lifecycle_set` refuses (L18). The server writes these codes' messages for the owner (src/lifecycle), so
// they are shown as they are; any other code gets the shared wording. No raw code or upstream text reaches the page.
export type LifecycleErrorInfo = { code: string | null; message: string };

/** Codes of this op whose message the server wrote as a plain sentence. */
const OWNER_CODES = new Set(["already_in_state", "archived_terminal", "trust_blocked", "owner_required", "owner_inactive", "date_passed", "date_in_past", "cooling_not_over", "plan_open", "agents_undecided", "agent_not_owned", "lifecycle_stale", "lifecycle_open", "use_bring_back", "no_lifecycle", "reason_required", "decisions_need_stop", "agent_stopped_itself", "agent_closed", "plan_open", "subject_closed", "nothing_to_stop", "input_invalid", "plan_applied", "plan_applying", "portal_unavailable"]);
const MOVE_REFUSED = "This change is not possible in the state this entry has now. Reload the page.";

type Err = { code?: unknown; message?: unknown; details?: { count?: unknown } };

/** The number the server wants as `confirmCount` when the stop cap is reached (S2-7), else null. */
export function stopCapOf(e: unknown): number | null {
  const err = (e ?? {}) as Err;
  if (err.code !== "stop_cap_reached") return null;
  return typeof err.details?.count === "number" ? err.details.count : null;
}

export function lifecycleError(e: unknown, fallback: (e: unknown) => string): LifecycleErrorInfo {
  const err = (e ?? {}) as Err;
  const code = typeof err.code === "string" ? err.code : null;
  if (code === "stop_cap_reached") {
    const count = typeof err.details?.count === "number" ? err.details.count : null;
    if (count !== null) return { code, message: `This makes ${count} stopped in the last 10 minutes, with the agents that stop with them. Check that this is you, then confirm.` };
    // the old People form has no confirm to send: the server's sentence names the page that can
    return { code, message: typeof err.message === "string" && err.message.trim() ? err.message.trim() : fallback(e) };
  }
  if (code === "transition_not_allowed") return { code, message: MOVE_REFUSED };
  if (code && OWNER_CODES.has(code) && typeof err.message === "string" && err.message.trim()) return { code, message: err.message.trim() };
  return { code, message: fallback(e) };
}
