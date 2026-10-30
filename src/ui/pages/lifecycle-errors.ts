// Plain sentences for what `lifecycle_set` refuses (L18). Codes of this op only; everything else goes to the shared wording.
export type LifecycleErrorInfo = { code: string | null; message: string };

const MESSAGES: Record<string, string> = {
  lifecycle_stale: "This entry changed after you opened it. Close this and open it again.",
  transition_refused: "This change is not possible in the state this entry has now. Reload the page.",
  reason_required: "Choose a reason.",
};

type Err = { code?: unknown; message?: unknown; details?: { used?: unknown; limit?: unknown; windowMinutes?: unknown } };

/** The count the server wants confirmed when the stop cap is reached (S2-7), else null. */
export function stopCapOf(e: unknown): number | null {
  const err = (e ?? {}) as Err;
  if (err.code !== "stop_cap_reached") return null;
  return typeof err.details?.used === "number" ? err.details.used : null;
}

export function lifecycleError(e: unknown, fallback: (e: unknown) => string): LifecycleErrorInfo {
  const err = (e ?? {}) as Err;
  const code = typeof err.code === "string" ? err.code : null;
  if (code === "stop_cap_reached") {
    const used = typeof err.details?.used === "number" ? err.details.used : null;
    const minutes = typeof err.details?.windowMinutes === "number" ? err.details.windowMinutes : 10;
    return { code, message: used === null ? `You stopped many entries in the last ${minutes} minutes. Check that this is you.` : `You stopped ${used} entries in the last ${minutes} minutes. Check that this is you, then stop this one too.` };
  }
  if (code && MESSAGES[code]) return { code, message: MESSAGES[code] as string };
  return { code, message: fallback(e) };
}
