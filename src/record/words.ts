// The words of the access record (C380 T2-b, DESIGN-C380 §7, §15 D7, D8). Plain words, as a file for a reader who is not in this app. The
// record claims no more than it is: our own apps report this data, and one login approves. It makes no claim about any law or standard.
import { NOT_CHANGED } from "../plans/portal-link.ts";

export const RECORD_FORMAT = "tealbrick.access-record/1";
export const HEADER = "What each app reported and what the Portal slice showed, in Teal Brick stores only. Not proof of compliance.";

/** D8: what the file holds about people. Written for the owner who decides if this stays. */
export const CONTENTS = {
  includes: [
    "Names and ids of people and agents, as the directory has them now.",
    "The label an app gives to each access item. It can hold an account name or a handle.",
    "Reasons for each change as codes, and the note the owner typed or Governance wrote on that change.",
    "The reason the owner typed for each review verdict and each accepted difference.",
    "The ids of the sign-ins that approved. An id is opaque and names no one by itself.",
    "Dates and times.",
  ],
  excludes: [
    "Email addresses, titles, tags and organisation of people.",
    "The handles of people (Buzz, Slack, Telegram).",
    "The content of any document, message or memory.",
    "Keys, tokens and credentials.",
    "The text that agents wrote in review requests.",
  ],
  decision: "What this file holds about people is a default. The owner of the workspace decides how long it is kept and who receives it. Nobody checked this against a law.",
} as const;

export const NO_APPROVER = "No person approved an item in this period.";
export const ONE_APPROVER = "One person approved all items.";
export const manyApprovers = (n: number): string => `${n} people approved items. Each item names who approved it.`;

export interface LimitInput {
  /** the time (ms) from which lists were kept; sweeps before it have no list */
  since: number | null;
  /** sweeps of the period that have no list */
  unknownSweeps: number;
  approverLine: string;
}

export function limitsOf(i: LimitInput): string[] {
  return [
    "Our own apps report this data. A list proves only what the app reported. An app that reports nothing can still hold access.",
    "This record makes no claim about any law, standard or audit. Use it as a record for your own access-control file.",
    `${i.approverLine} Governance has one owner login today, so the owner reviews and approves. A second person does not check the owner.`,
    "The file is kept on your own volume, and the owner can change it. Each event holds the hash of the event before it, so an edit of an old event breaks the chain. This is not a signature.",
    "A restore of a backup removes the events after that backup. A restored event says so. Export this record before you restore or roll back.",
    "Approvals in Portal are made in Portal. This record holds the id of the Portal receipt, not the receipt. Portal keeps a receipt for 90 days, so Portal's answer for each step is copied here. For a step at an app the state and the time are kept.",
    "Findings are the ones open when this file was made. An earlier finding is not kept, except as an event or a plan outcome.",
    `The list of a sweep is built from a change log that starts ${i.since === null ? "at the first sweep" : new Date(i.since).toISOString()}. ${i.unknownSweeps > 0 ? `${i.unknownSweeps} sweeps in this period are before it and have no list.` : "Every sweep in this period has a list."}`,
    "An app that was not read in a sweep is marked as not read. The kinds an app says it cannot list are named. Neither is shown as empty.",
    `Not part of this record: ${NOT_CHANGED.join(" ")}`,
  ];
}
