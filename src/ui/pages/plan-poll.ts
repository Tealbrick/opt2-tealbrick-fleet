// How often the page reads a plan. Plain logic, so a test can run it without a DOM.
type Poll = { closedAt: string | null; reviewUrl: string | null; mode: string };

/** The owner's next move is in Portal once the request is ready, so only then does the page slow down. Null: every plan ended. */
export const pollDelay = (plans: readonly Poll[]): number | null => {
  const open = plans.filter((p) => p.closedAt === null);
  if (plans.length > 0 && open.length === 0) return null;
  return open.some((p) => p.reviewUrl === null && p.mode === "draft") || plans.length === 0 ? 2000 : 30000;
};
