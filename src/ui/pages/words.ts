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
  "Their agents. Agents keep working when a person leaves, unless you choose Stop this agent for one.",
  "A key to one of their agents that this person may hold. It works until you make a new key.",
  "Their own logins, such as Slack, Google or a bank.",
  "An agent's machine and its native tools.",
  "Copies of data that were already made.",
  "Other people with the shared Portal login. Change the Portal login if they had it.",
  "For an agent you stop: engine steps after an agent step, and scheduled posts before you approve.",
  "An agent can still send to a Slack direct message id it already knows. Governance bars what comes in from that person, not this.",
  "Channels or groups the person is still in. The sender bar does not cover them.",
  "Messages read through tool accounts.",
  "Messages stored before the bar. Data apps can still read them.",
  "New handles of this person.",
  "Edits the person makes to their own direct messages older than 30 days.",
  "Email, Teams and Discord. Governance bars Buzz, Slack and Telegram handles only. Use the Accounts page in Connect for the others.",
];

/** C383 QA S3-11: for an agent's own stop. No line about a person's logins, messages or handles. */
const NOT_CHANGED_AGENT: readonly string[] = [
  "This agent's machine and its native tools.",
  "Copies of data that were already made.",
  "Engine steps after an agent step, and scheduled posts before you approve.",
  "Its key. It ends only with Stop and remove access, when you approve in Portal.",
];

/** The block for one entry: the person's list is for a person. */
export const notChangedOf = (kind: "person" | "agent"): readonly string[] => (kind === "person" ? NOT_CHANGED : NOT_CHANGED_AGENT);

/**
 * What may be said BEFORE a change, from what Governance can read. Rules can have confirmed only a change already made,
 * and Governance cannot read the hook switch, so this never says that anything stopped.
 */
export function beforeChangeText(floor: Pick<Floor, "state">, kind: "person" | "agent" = "agent"): string {
  // C381: a person is barred by Rules and by the sender bar in Connect. No approval in Portal bars a person.
  if (kind === "person") {
    switch (floor.state) {
      case "not_installed":
        return "Rules & Approvals is not installed, so it does not refuse calls for this person. If they have handles in the directory, the sender bar in Connect drops their messages.";
      case "older":
        return "Rules & Approvals is too old to refuse calls for this person. Update it. If they have handles in the directory, the sender bar in Connect drops their messages.";
      case "not_read":
        return "Governance could not read Rules & Approvals, so calls for this person may go on. If they have handles in the directory, the sender bar in Connect drops their messages.";
      default:
        return "If the Rules hook is on, calls by, for and to this person are refused in about 2 minutes. Governance cannot see that switch: check it in Portal. The next screen says if Rules has this change.";
    }
  }
  switch (floor.state) {
    case "not_installed":
      return "Rules & Approvals adds an early stop. It is not installed, so the agent stops only when you approve in Portal.";
    case "older":
      return "Rules & Approvals is too old to refuse calls for this agent, so it stops only when you approve in Portal.";
    case "not_read":
      return "Governance could not read Rules & Approvals, so calls may go on. The agent stops for certain when you approve in Portal.";
    default:
      return "If the Rules hook is on, calls stop in about 2 minutes. Governance cannot see that switch: check it in Portal. The next screen says if Rules has this change.";
  }
}

/** The tone before a change: a warning only when Rules cannot help. */
export const beforeChangeTone = (floor: Pick<Floor, "state">): "needs-you" | "neutral" => (floor.state === "older" || floor.state === "not_read" ? "needs-you" : "neutral");

/** After a change: what the server says Rules has, plus what Governance cannot see. The gate note gets a readable time. */
export function afterChangeText(floor: Floor, kind: "person" | "agent" = "agent"): string {
  // C381: no approval in Portal stops a person. The server's sentence about Portal is for an agent.
  const first = kind === "person" && floor.state === "not_confirmed" ? "Rules has not read this change yet." : kind === "person" && floor.state === "not_read" ? "Rules & Approvals could not be read, so calls for this person may go on." : floor.text;
  const parts = [first];
  if (floor.state === "confirmed") parts.push(kind === "person" ? "If its hook is on, calls by, for and to this person are refused in about 2 minutes. Governance cannot see that switch: check it in Portal." : "If its hook is on, calls stop in about 2 minutes. Governance cannot see that switch: check it in Portal.");
  if (floor.rulesHolds) parts.push(floor.rulesHolds);
  if (floor.gateNote && floor.lastGateAt) parts.push(`Rules has not checked a call since ${when(floor.lastGateAt)}.`);
  return parts.join(" ");
}

/** A stop's Notice tone: only a change Rules confirmed reads as live, and even that is not "stopped". */
export const floorTone = (floor: Pick<Floor, "state">): "live" | "needs-you" | "neutral" => (floor.state === "confirmed" ? "live" : floor.state === "not_installed" ? "neutral" : "needs-you");

/** How old a read is, in words (QA D10). */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `30 Oct 2026, 15:50 UTC`; empty when there is no valid time. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
