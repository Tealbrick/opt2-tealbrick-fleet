// How often the page reads a plan. Plain logic, so a test can run it without a DOM.
type Poll = { closedAt: string | null; reviewUrl: string | null; mode: string };

/** The owner's next move is in Portal once the request is ready, so only then does the page slow down. Null: every plan ended. */
export const pollDelay = (plans: readonly Poll[]): number | null => {
  const open = plans.filter((p) => p.closedAt === null);
  if (plans.length > 0 && open.length === 0) return null;
  return open.some((p) => p.reviewUrl === null && p.mode === "draft") ? 2000 : 30000;
};

/** The plans that belong to this stop: open ones, and ended ones from after the last change of the entry. */
export function currentPlans<T extends Poll & { groupId: string; openedAt: string }>(plans: readonly T[], since: string | null | undefined): T[] {
  const newest = plans.filter((p) => p.groupId === plans[0]?.groupId);
  return newest.filter((p) => p.closedAt === null || !since || p.openedAt >= since);
}

/** An alert stays true only while its plan does: "waits for your approval" is over once the plan moved on. */
export function liveBanners<B extends { plan: string; kind: string }>(out: { plans: readonly { id: string; state: string }[]; banners: readonly B[] }): B[] {
  return out.banners.filter((b) => {
    if (b.kind !== "waiting") return true;
    return out.plans.find((p) => p.id === b.plan)?.state === "waiting";
  });
}
