// Types of `plan_preview` and `findings_list`, from the manifest of this build.
import type { FindingsListOutput, PlanPreviewOutput } from "#kit";

export type { FindingsListOutput, PlanPreviewOutput };
export type PreviewStore = PlanPreviewOutput["stores"][number];
export type PreviewItem = PreviewStore["items"][number];
export type StoreState = PreviewStore["state"];
export type ItemEffect = PreviewItem["effect"];
export type FindingRow = FindingsListOutput["items"][number];
