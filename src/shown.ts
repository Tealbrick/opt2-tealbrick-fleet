// The ONE rule for "changed since the last review" (server: src/reviews.ts, topology_get). The Trust reviews page needs the
// same rule in the browser: src/ui/shown.ts is a byte-for-byte copy of the code below this header (test/boundaries.test.ts
// fails on any drift). Server modules never import from src/ui: scripts/build-ui.ts moves dist/ui/* into a hashed
// assets directory, so a server import of dist/ui/<file>.js does not exist at run time (0.2.2 QA-GOV022-1).

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
