// The lifecycle states and the rules that are pure (C380, DESIGN-C380 §2). No I/O. This file is the only place that knows
// the states: the database has no CHECK on them. Three axes stay apart: lifecycle (the owner's intent), trust (trust.ts) and
// runtime (Core's fact, fleet_agents.status, never written with intent).
import type { Trust } from "../trust.ts";

export const LIFECYCLES = ["proposed", "active", "suspended", "leaving", "archived"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
/** What is in force now. Computed, sent in the feed, never stored. */
export type Effective = Lifecycle | "not_started";
export type SubjectKind = "person" | "agent";

/** A list, not free text: a reason can go to a record for later reading. The free text `note` carries a warning in the UI. */
export const REASONS = ["left", "contract_ended", "role_changed", "security", "mistake", "reviewed", "returned", "other"] as const;
export type Reason = (typeof REASONS)[number];

/**
 * T2 to T8 of DESIGN-C380 §2. `archived` -> `proposed` is T8 (a person). T9: an archived agent is terminal, with one exception
 * in transitions.ts for a row the migration closed that has a card again.
 */
export const NEXT: Readonly<Record<Lifecycle, readonly Lifecycle[]>> = {
  proposed: ["active", "suspended", "leaving"],
  active: ["suspended", "leaving"],
  suspended: ["active", "leaving"],
  leaving: ["active", "proposed", "archived"],
  archived: ["proposed"],
};

export const STOP_STATES: readonly Lifecycle[] = ["suspended", "leaving"];
const OWNER_STOPS: readonly (string | null)[] = ["suspended", "leaving", "archived"];

/** A person's directory status (the 0.3.2 field) is derived from the lifecycle. */
export const personStatusOf = (l: Lifecycle): "active" | "departed" => (l === "active" || l === "suspended" ? "active" : "departed");

/** What an agent may read: `departed` from `archived` only, so no agent learns of a leaver before the person knows (S2-8). Outside agents have no lifecycle. */
export const leanPersonStatus = (status: "active" | "departed", lifecycle: string | null): "active" | "departed" => (lifecycle === null ? status : lifecycle === "archived" ? "departed" : "active");

<<<<<<< HEAD
/** A stored start date reads `not_started` until the timer ends it (two ticks agree, the revision moves). So time alone never changes an answer at one revision. */
export function effectivePerson(p: { lifecycle: Lifecycle; validFrom: number | null }): Effective {
  if ((p.lifecycle === "active" || p.lifecycle === "proposed") && p.validFrom !== null) return "not_started";
=======
export function effectivePerson(p: { lifecycle: Lifecycle; validFrom: number | null }, now: number): Effective {
  if ((p.lifecycle === "active" || p.lifecycle === "proposed") && p.validFrom !== null && p.validFrom > now) return "not_started";
>>>>>>> origin/main
  return p.lifecycle;
}

/** An agent whose owner is stopped is effectively `suspended` unless its keep-running tick is set. Lifts by itself when the owner's state lifts. */
<<<<<<< HEAD
export function effectiveAgent(a: { lifecycle: Lifecycle; validFrom: number | null; keepRunning: boolean }, ownerLifecycle: string | null): Effective {
  if (a.lifecycle === "suspended" || a.lifecycle === "leaving" || a.lifecycle === "archived") return a.lifecycle;
  if (OWNER_STOPS.includes(ownerLifecycle) && !a.keepRunning) return "suspended";
  if (a.validFrom !== null) return "not_started";
=======
export function effectiveAgent(a: { lifecycle: Lifecycle; validFrom: number | null; keepRunning: boolean }, ownerLifecycle: string | null, now: number): Effective {
  if (a.lifecycle === "suspended" || a.lifecycle === "leaving" || a.lifecycle === "archived") return a.lifecycle;
  if (OWNER_STOPS.includes(ownerLifecycle) && !a.keepRunning) return "suspended";
  if (a.validFrom !== null && a.validFrom > now) return "not_started";
>>>>>>> origin/main
  return a.lifecycle;
}

/** Feed `floor`. A row the migration closed (no card) is not refused by its lifecycle; a blocked entry always is. */
export function floorOf(effective: Effective | null, trust: Trust, noCard = false): boolean {
  if (trust === "blocked") return true;
  if (effective === null || noCard) return false;
  return effective === "not_started" || effective === "suspended" || effective === "leaving" || effective === "archived";
}
