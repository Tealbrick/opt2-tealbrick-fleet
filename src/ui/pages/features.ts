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
};

export function featuresOf(ops: readonly string[]): Features {
  const has = (...names: string[]) => names.every((n) => ops.includes(n));
  return {
    lifecycle: has("summary_get", "colleagues_list", "colleague_get", "lifecycle_set"),
    preview: has("plan_preview"),
    differences: has("findings_list"),
    plans: has("plan_send", "plan_get", "plan_retry", "plan_cancel"),
  };
}

export const FEATURES = featuresOf(PERSON_OPS);
