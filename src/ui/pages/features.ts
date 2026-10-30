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
  /** the live plan, Try again, the request in Portal */
  plans: boolean;
  /** The Join page has a route (C380 T2-d). */
  join: boolean;
  /** The Add people button on People and agents: Join is on AND the QA rows R12 to R14 passed. */
  joinInNav: boolean;
};

/**
 * "A page stays hidden unless its ops are on and its rows pass" (C380 T2). Join is built, but until the QA lead records R12 to R14 as
 * PASS on BOARD, nothing links to it: this one constant is the switch, and the PR that sets it to true carries the BOARD line.
 * The route /join works whenever the ops exist, so QA can open it by its address.
 */
export const JOIN_ROWS_PASSED = false;

const JOIN_OPS = ["person_set", "overview_get", "members_set"];

export function featuresOf(ops: readonly string[], joinRowsPassed: boolean = JOIN_ROWS_PASSED): Features {
  const has = (...names: string[]) => names.every((n) => ops.includes(n));
  return {
    lifecycle: has("summary_get", "colleagues_list", "colleague_get", "lifecycle_set"),
    preview: has("plan_preview"),
    differences: has("findings_list"),
    plans: has("plan_send", "plan_get", "plan_retry", "plan_cancel"),
    join: has(...JOIN_OPS),
    joinInNav: has(...JOIN_OPS) && joinRowsPassed,
  };
}

export const FEATURES = featuresOf(PERSON_OPS);
