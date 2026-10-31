// What the bulk editors on Teams, Roles and Agents compute (C382 batch 2). No React, so the tests run the same functions.
import type { AccessCell, AccessChange } from "@opt2-tealbrick/ui";

export type MemberRole = "member" | "lead";
export type MemberRow = { kind: "person" | "agent"; id: string; name: string; role: MemberRole };

/** A person or an agent in one id: both lists can hold the same id text, and the two ops send them apart. */
export const subjectKey = (kind: "person" | "agent", id: string) => `${kind}:${id}`;
export function subjectOf(key: string): { kind: "person" | "agent"; id: string } {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at) as "person" | "agent", id: key.slice(at + 1) };
}

/**
 * members_set replaces the whole list, so one click is ONE call, built on the list read just before it. A member the page does not show
 * (an agent that left Portal) and a member someone added since the page loaded both stay.
 */
export function membersAfter(members: readonly Pick<MemberRow, "kind" | "id" | "role">[], changes: readonly AccessChange[]): { people: { id: string; role: MemberRole }[]; agents: { id: string; role: MemberRole }[] } {
  const next = new Map(members.map((m) => [subjectKey(m.kind, m.id), m.role]));
  for (const c of changes) {
    if (c.level === null) next.delete(c.agent);
    else next.set(c.agent, c.level as MemberRole);
  }
  const out = { people: [] as { id: string; role: MemberRole }[], agents: [] as { id: string; role: MemberRole }[] };
  for (const [key, role] of next) {
    const s = subjectOf(key);
    (s.kind === "person" ? out.people : out.agents).push({ id: s.id, role });
  }
  return out;
}

export const memberCells = (teamId: string, members: readonly Pick<MemberRow, "kind" | "id" | "role">[]): AccessCell[] => members.map((m) => ({ agent: subjectKey(m.kind, m.id), scope: teamId, level: m.role }));

/** How many tags a team card shows, leads first: a team of 40 agents keeps a card you can read. */
export const CARD_MEMBERS = 6;
export function memberPreview<T extends Pick<MemberRow, "role">>(members: readonly T[], shown = CARD_MEMBERS): { tags: T[]; more: number; line: string } {
  const leads = members.filter((m) => m.role === "lead");
  const tags = [...leads, ...members.filter((m) => m.role !== "lead")].slice(0, shown);
  const n = members.length;
  const line = `${n} ${n === 1 ? "member" : "members"}${leads.length ? `, ${leads.length} ${leads.length === 1 ? "lead" : "leads"}` : ""}`;
  return { tags, more: n - tags.length, line };
}

export type GiveForm = { reason: string; from: string; until: string };
/** A local date-time field value to an ISO moment: null for an empty field, undefined for a value that is not a date. */
export const isoOf = (local: string): string | null | undefined => {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Why this give cannot be sent yet: the same checks for one or for many, so a bad date does not fail every row one by one. Null when it can. */
export function giveProblem(form: GiveForm, now = Date.now()): string | null {
  if (!form.reason) return "Choose why.";
  const from = isoOf(form.from);
  const until = isoOf(form.until);
  if (from === undefined) return "Check the start date.";
  if (until === undefined) return "Check the end date.";
  if (until && new Date(until).getTime() <= now) return "The end date has passed. Choose a later end date.";
  if (from && until && from >= until) return "The start date must be before the end date.";
  return null;
}
