// Local types of `plan_preview` and `findings_list` until B9b's ops are in the manifest; then these come from #kit. Every page that
// uses them is off until the ops are there (features.ts).
export type StoreState = "read" | "not_installed" | "not_read" | "refused" | "waiting";
export type ItemEffect = "stops" | "manual" | "stays" | "about";

export type PreviewItem = { id: string; kind: string; label: string; level: string; direction: string; state: string; effect: ItemEffect; who: string | null };
export type PreviewStore = { product: string; name: string; state: StoreState; text: string | null; at: string | null; notShown: { kind: string; reason: string }[]; items: PreviewItem[] };
export type PlanPreviewOutput = { subject: { kind: "person" | "agent"; id: string; name: string }; asOf: string; unlinkedAccounts: number; stores: PreviewStore[] };

export type FindingRow = { code: string; text: string; subject: { kind: "person" | "agent"; id: string; name: string } | null; productName: string | null; since: string | null; exception: { reason: string; until: string } | null };
export type FindingsListOutput = { lastSweepAt: string | null; storesRead: number; unread: { product: string; name: string; text: string }[]; items: FindingRow[] };
