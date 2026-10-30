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
};

/**
 * "A page stays hidden unless its ops are on and its rows pass" (C380 T2). The page is built, but until the QA lead records R1 to R4 as PASS
 * on BOARD it is not in the navigation: this one constant is the switch, and the PR that sets it to true carries the BOARD line.
 * The route /roles works whenever the ops exist, so QA can open it by its address.
 */
export const ROLES_ROWS_PASSED = false;

/** Same switch for "Cannot hold both" (C380 T2-c): the PR that sets it to true carries the BOARD line with R9 to R11 PASS. */
export const EXCLUSION_ROWS_PASSED = false;

const ROLE_OPS = ["roles_list", "role_get", "role_set", "role_assign", "role_end"];
const EXCLUSION_OPS = ["exclusions_list", "exclusion_set"];

/**
 * Tier 2 pages (C380 T2-b) stay off the nav until their QA rows pass: no half-shown page. One line flips each, in the PR that follows the PASS line on BOARD.
 * R5 = rounds, R6 to R8 = the access record.
 */
export const TIER2_PASSED = { rounds: false, record: false } as const;

export function featuresOf(ops: readonly string[], rolesRowsPassed: boolean = ROLES_ROWS_PASSED, exclusionRowsPassed: boolean = EXCLUSION_ROWS_PASSED, passed: { rounds: boolean; record: boolean } = TIER2_PASSED): Features {
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
  };
}

export const FEATURES = featuresOf(PERSON_OPS);
