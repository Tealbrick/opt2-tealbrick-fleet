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
};

/**
 * "A page stays hidden unless its ops are on and its rows pass" (C380 T2). The page is built, but until the QA lead records R1 to R4 as PASS
 * on BOARD it is not in the navigation: this one constant is the switch, and the PR that sets it to true carries the BOARD line.
 * The route /roles works whenever the ops exist, so QA can open it by its address.
 */
export const ROLES_ROWS_PASSED = false;

const ROLE_OPS = ["roles_list", "role_get", "role_set", "role_assign", "role_end"];

export function featuresOf(ops: readonly string[], rolesRowsPassed: boolean = ROLES_ROWS_PASSED): Features {
  const has = (...names: string[]) => names.every((n) => ops.includes(n));
  return {
    lifecycle: has("summary_get", "colleagues_list", "colleague_get", "lifecycle_set"),
    preview: has("plan_preview"),
    differences: has("findings_list"),
    roles: has(...ROLE_OPS),
    rolesInNav: has(...ROLE_OPS) && rolesRowsPassed,
  };
}

export const FEATURES = featuresOf(PERSON_OPS);
