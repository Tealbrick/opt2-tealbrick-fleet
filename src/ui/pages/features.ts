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

export function featuresOf(ops: readonly string[], rolesRowsPassed: boolean = ROLES_ROWS_PASSED, exclusionRowsPassed: boolean = EXCLUSION_ROWS_PASSED): Features {
  const has = (...names: string[]) => names.every((n) => ops.includes(n));
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
  };
}

export const FEATURES = featuresOf(PERSON_OPS);
