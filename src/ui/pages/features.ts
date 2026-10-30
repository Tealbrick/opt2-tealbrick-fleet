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
  /** Review rounds: the route works when the ops are there (QA reaches it by its address) */
  rounds: boolean;
  /** Access record */
  record: boolean;
  /** the nav entries: the ops are there AND the QA rows of the page passed */
  roundsNav: boolean;
  recordNav: boolean;
};

/**
 * Tier 2 pages (C380 T2-b) stay off the nav until their QA rows pass: no half-shown page. One line flips each, in the PR that follows the PASS line on BOARD.
 * R5 = rounds, R6 to R8 = the access record.
 */
export const TIER2_PASSED = { rounds: false, record: false } as const;

export function featuresOf(ops: readonly string[], passed: { rounds: boolean; record: boolean } = TIER2_PASSED): Features {
  const has = (...names: string[]) => names.every((n) => ops.includes(n));
  const rounds = has("round_create", "round_get", "round_verdict", "round_set");
  const record = has("record_export");
  return {
    lifecycle: has("summary_get", "colleagues_list", "colleague_get", "lifecycle_set"),
    preview: has("plan_preview"),
    differences: has("findings_list"),
    rounds,
    record,
    roundsNav: rounds && passed.rounds,
    recordNav: record && passed.record,
  };
}

export const FEATURES = featuresOf(PERSON_OPS);
