// The ONE rule for "changed since the last review", shared by the server (src/reviews.ts, topology_get) and the Trust
// reviews page (src/ui/reviews.tsx). Pure: no imports, so the browser build can take it.

/** The part of a snapshot the owner sees and a verdict looked at (the trust state is not part of it: a verdict changes trust). */
export interface Shown {
  name: string;
  title: string;
  status: string;
  handles: readonly string[];
  owner: string | null;
  teams: readonly string[];
}

/** Same picture apart from the trust state. */
export function sameShown(a: Shown, b: Shown): boolean {
  return JSON.stringify([a.name, a.title, a.status, a.handles, a.owner, a.teams]) === JSON.stringify([b.name, b.title, b.status, b.handles, b.owner, b.teams]);
}
