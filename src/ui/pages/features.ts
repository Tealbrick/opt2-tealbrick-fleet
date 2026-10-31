// What the owner may see depends on what this build of the app can answer: a page or button for an op the manifest does
// not have does not appear (C380). The list is the generated PERSON_OPS of this very build, so it cannot drift.
import { PERSON_OPS } from "#kit";

export type Features = {
  /** Summary and People and agents */
  lifecycle: boolean;
  /** "See what would stop" */
  preview: boolean;
  /** Access > Differences */
  differences: boolean;
  /** The Roles page has a route (C380 T2-a): the role ops are in this build. */
  roles: boolean;
  /** The Roles page is in the navigation: its ops are on AND the QA rows R1 to R4 passed. */
  rolesInNav: boolean;
  /** The Cannot hold both page has a route (C380 T2-c): the role ops and the two rule ops are in this build. */
  exclusions: boolean;
  /** The page is in the navigation: its ops are on AND the QA rows R9 to R11 passed. */
  exclusionsInNav: boolean;
  /** the live plan, Try again, the request in Portal */
  plans: boolean;
  /** Review rounds: the route works when the ops are there (QA reaches it by its address) */
  rounds: boolean;
  /** Access record */
  record: boolean;
  /** the nav entries: the ops are there AND the QA rows of the page passed */
  roundsNav: boolean;
  recordNav: boolean;
  /** The Join page has a route (C380 T2-d). */
  join: boolean;
  /** The Add people button on People and agents: Join is on AND the QA rows R12 to R14 passed. */
  joinInNav: boolean;
};

/**
 * "A page stays hidden unless its ops are on and its rows pass" (C380 T2). The page is built, but until the QA lead records R1 to R4 as PASS
 * on BOARD it is not in the navigation: this one constant is the switch, and the PR that sets it to true carries the BOARD line.
 * The route /roles works whenever the ops exist, so QA can open it by its address.
 */
export const ROLES_ROWS_PASSED = true; // QA R1 to R4 PASS, BOARD 2026-10-31 (Closed-mode allow variant not run)

/** Same switch for "Cannot hold both" (C380 T2-c): the PR that sets it to true carries the BOARD line with R9 to R11 PASS. */
export const EXCLUSION_ROWS_PASSED = true; // QA R9 to R11 PASS, BOARD 2026-10-31

const ROLE_OPS = ["roles_list", "role_get", "role_set", "role_assign", "role_end"];
const EXCLUSION_OPS = ["exclusions_list", "exclusion_set"];

/**
 * Tier 2 pages (C380 T2-b) stay off the nav until their QA rows pass: no half-shown page. One line flips each, in the PR that follows the PASS line on BOARD.
 * R5 = rounds, R6 to R8 = the access record.
 */
export const TIER2_PASSED = { rounds: true, record: true } as const; // QA R5 to R7 PASS, BOARD 2026-10-31; stated gaps: one plan over 3 agents, print, chain (R8 unit only)

/**
 * "A page stays hidden unless its ops are on and its rows pass" (C380 T2). Join is built, but until the QA lead records R12 to R14 as
 * PASS on BOARD, nothing links to it: this one constant is the switch, and the PR that sets it to true carries the BOARD line.
 * The route /join works whenever the ops exist, so QA can open it by its address.
 */
export const JOIN_ROWS_PASSED = true; // QA R12 to R14 PASS, BOARD 2026-10-31; R13's 100-line cap and error lines not run

const JOIN_OPS = ["person_set", "overview_get", "members_set"];

export function featuresOf(ops: readonly string[], rolesRowsPassed: boolean = ROLES_ROWS_PASSED, exclusionRowsPassed: boolean = EXCLUSION_ROWS_PASSED, passed: { rounds: boolean; record: boolean } = TIER2_PASSED, joinRowsPassed: boolean = JOIN_ROWS_PASSED): Features {
  const has = (...names: string[]) => names.every((n) => ops.includes(n));
  const rounds = has("round_create", "round_get", "round_verdict", "round_set");
  const record = has("record_export");
  return {
    lifecycle: has("summary_get", "colleagues_list", "colleague_get", "lifecycle_set"),
    preview: has("plan_preview"),
    differences: has("findings_list"),
    roles: has(...ROLE_OPS),
    rolesInNav: has(...ROLE_OPS) && rolesRowsPassed,
    // the page lists roles and makes rules: it needs both sets of ops
    exclusions: has(...ROLE_OPS, ...EXCLUSION_OPS),
    exclusionsInNav: has(...ROLE_OPS, ...EXCLUSION_OPS) && exclusionRowsPassed,
    plans: has("plan_send", "plan_get", "plan_retry", "plan_cancel"),
    rounds,
    record,
    roundsNav: rounds && passed.rounds,
    recordNav: record && passed.record,
    join: has(...JOIN_OPS),
    joinInNav: has(...JOIN_OPS) && joinRowsPassed,
  };
}

export const FEATURES = featuresOf(PERSON_OPS);
