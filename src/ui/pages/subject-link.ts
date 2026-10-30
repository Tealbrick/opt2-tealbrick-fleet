// The person or agent page is one route with the entry in the query, so the ids stay in the URL and out of the page text.
export type SubjectKind = "person" | "agent";
export const SUBJECT_PATH = "person-or-agent";

export const subjectHref = (kind: SubjectKind, id: string) => `./${SUBJECT_PATH}?kind=${kind}&id=${encodeURIComponent(id)}`;

export function subjectFromUrl(search: string): { kind: SubjectKind; id: string } | null {
  const q = new URLSearchParams(search);
  const kind = q.get("kind");
  const id = q.get("id");
  if ((kind !== "person" && kind !== "agent") || !id) return null;
  return { kind, id };
}

/** Go there with the back button working; useNav and the page both follow popstate. */
export function openSubject(kind: SubjectKind, id: string) {
  globalThis.history.pushState(null, "", subjectHref(kind, id));
  globalThis.dispatchEvent(new PopStateEvent("popstate"));
}
