// Trust states of contacts (people and outside agents) and agents (C166, DESIGN §4). Pure types and the ONE rule that
// says which state a new entry starts in; no I/O.

export const TRUST_STATES = ["unreviewed", "trusted", "limited", "blocked"] as const;
export type Trust = (typeof TRUST_STATES)[number];

/** Who created an entry: the owner (a person op or the Portal slice) or an agent (no agent create op exists yet). */
export type Source = "owner" | "agent";

export type ContactKind = "person" | "outside_agent";

/**
 * The start state of a new entry (Governance answer, C166): an entry the owner adds starts `trusted`; an entry that an
 * agent adds starts `unreviewed` until the owner records a review. Every insert uses this function.
 */
export function defaultTrust(source: Source): Trust {
  return source === "owner" ? "trusted" : "unreviewed";
}

/** Days between reviews, stored in `fleet_review_policy` by migration 0002 (the review operations come later). */
export const REVIEW_DAYS_DEFAULT = { agent_days: 90, contact_days: 180 } as const;

/** A workspace agent that arrives from the slice starts `unreviewed` (fail closed, like a contact an agent added). Agents that existed before 0.2.1 keep `trusted` (migration 0002). */
export const NEW_AGENT_TRUST: Trust = "unreviewed";
