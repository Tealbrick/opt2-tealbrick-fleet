// The owner's words for the lifecycle pages (DESIGN-C380 §10): reason lists, the "Not changed" block, and what may be said
// about Rules before a change is made. No state is inferred here: the one-line state, the findings and what Rules has
// confirmed come from the server, which reads Core and Rules. Plain text only, no raw id.
import type { ColleagueGetOutput, LifecycleSetInput } from "#kit";

export type Reason = NonNullable<LifecycleSetInput["reason"]>;
export type Lifecycle = NonNullable<LifecycleSetInput["to"]>;
export type Floor = ColleagueGetOutput["colleague"]["floor"];

const LABEL: Record<Reason, string> = {
  left: "They left",
  contract_ended: "Contract ended",
  role_changed: "Role changed",
  security: "Security",
  mistake: "It was a mistake",
  reviewed: "Reviewed",
  returned: "They came back",
  other: "Other",
};
export const reasonLabel = (r: string): string => (r === "migrated" ? "Marked as departed before this version" : (LABEL[r as Reason] ?? "Other"));

/** The reasons offered for a change to `to`. A list, never free text: this row is kept (business F13). */
const STOP: Reason[] = ["left", "contract_ended", "role_changed", "security", "other"];
const BACK: Reason[] = ["returned", "mistake", "other"];
export const REASONS: Record<Lifecycle, Reason[]> = { suspended: STOP, leaving: STOP, archived: STOP, active: BACK, proposed: BACK };
export const reasonOptions = (to: Lifecycle) => REASONS[to].map((r) => ({ value: r, label: LABEL[r] }));

export const NOTE_HINT = "Optional. Do not write health, pay or disciplinary details.";

/** What a stop does not change (§9 "Not true"). It goes on each Confirm, not only in docs. */
export const NOT_CHANGED: readonly string[] = [
  "Their own logins, such as Slack, Google or a bank.",
  "The agent's machine and its native tools.",
  "Copies of data that were already made.",
  "Other people with the shared Portal login. Change the Portal login if they had it.",
  "Engine steps after an agent step.",
  "Scheduled posts before you approve.",
];

/**
 * What may be said BEFORE a change, from what Governance can read. Rules can have confirmed only a change already made,
 * and Governance cannot read the hook switch, so this never says that anything stopped.
 */
export function beforeChangeText(floor: Pick<Floor, "state">): string {
  switch (floor.state) {
    case "not_installed":
      return "Rules & Approvals adds an early stop. It is not installed, so nothing stops until you approve in Portal.";
    case "older":
      return "Rules & Approvals is too old to confirm this change, so nothing may stop until you approve in Portal.";
    case "not_read":
      return "Governance could not read Rules & Approvals, so nothing may stop until you approve in Portal.";
    default:
      return "If the Rules hook is on, calls stop in about 2 minutes. Governance cannot see that switch: check it in Portal. The next screen says if Rules has this change.";
  }
}

/** The tone before a change: a warning only when Rules cannot help. */
export const beforeChangeTone = (floor: Pick<Floor, "state">): "needs-you" | "neutral" => (floor.state === "older" || floor.state === "not_read" ? "needs-you" : "neutral");

/** A stop's Notice tone: only a change Rules confirmed reads as live, and even that is not "stopped". */
export const floorTone = (floor: Pick<Floor, "state">): "live" | "needs-you" | "neutral" => (floor.state === "confirmed" ? "live" : floor.state === "not_installed" ? "neutral" : "needs-you");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `30 Oct 2026, 15:50 UTC`; empty when there is no valid time. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
