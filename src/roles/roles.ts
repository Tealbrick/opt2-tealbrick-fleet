// Flat roles and their assignments (C380 T2-a, DESIGN-C380 §6). Owner side only: no agent op reads or writes this file.
//
// A role is a RECORD. It allows and stops nothing by itself. Rules & Approvals may name it in a rule (`callerRoles`), and only then does it
// change a decision. Ending an assignment removes no Portal grant. These two sentences are shown to the owner (src/ui/pages/roles.tsx).
//
// What is held: an assignment that has started and has not ended. The date timer (expiry.ts) ends it when its end date has passed, with no action
// by anyone, and moves the revision, so a reader of the feed sees the role go. Every function here runs in one transaction with no await.
import { ulid } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { appendEvent } from "../lifecycle/events.ts";
import { bump, fail } from "../meta.ts";
import { cleanText } from "../text.ts";

export const ROLE_REASONS = ["new_role", "project", "cover", "contract", "access_review", "other"] as const;
export type RoleReason = (typeof ROLE_REASONS)[number];
export type EndReason = "owner" | "expired" | "closed" | "deleted";
export type SubjectKind = "person" | "agent";
export type AssignmentState = "active" | "scheduled" | "ended";

/** Limits. The feed carries at most ROLE_CAPS.roles roles and ROLE_CAPS.membersPerRole members in each (503 beyond: a reader keeps its last copy). */
export const ROLE_CAPS = { roles: 200, membersPerRole: 4000, nameMax: 80, descriptionMax: 500, noteMax: 500 } as const;
const MAX_DATE_MS = Date.UTC(2100, 0, 1);
const SYSTEM_OR_OWNER = (id: string | null) => (id === null ? { kind: "system" as const, id: null } : { kind: "owner" as const, id });

export interface RoleView {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  /** assignments held now */
  members: number;
  /** assignments that wait for a start date */
  scheduled: number;
  createdAt: string;
}
export interface AssignmentView {
  id: string;
  role: { id: string; name: string };
  subject: { kind: SubjectKind; id: string; name: string };
  reason: string;
  note: string | null;
  validFrom: string | null;
  validUntil: string | null;
  state: AssignmentState;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
}

const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const isoDay = (ms: number | null): string => (ms === null ? "no date" : new Date(ms).toISOString().slice(0, 10));

function parseDate(raw: string | null | undefined, what: string): number | null {
  if (raw === null || raw === undefined) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DATE_MS) fail("input_invalid", `${what} is not a date`, 400);
  return ms;
}

function subjectName(db: Db, kind: SubjectKind, id: string): string | null {
  const r = db.prepare(kind === "agent" ? "SELECT name FROM fleet_agents WHERE id = ?" : "SELECT name FROM fleet_people WHERE id = ?").get(id);
  return r ? String(r.name) : null;
}

const toRole = (r: Record<string, unknown>, counts: Map<string, { members: number; scheduled: number }>): RoleView => ({
  id: String(r.id),
  name: String(r.name),
  description: String(r.description),
  archived: r.archived_at !== null,
  members: counts.get(String(r.id))?.members ?? 0,
  scheduled: counts.get(String(r.id))?.scheduled ?? 0,
  createdAt: iso(r.created_at) as string,
});

function countsOf(db: Db): Map<string, { members: number; scheduled: number }> {
  const out = new Map<string, { members: number; scheduled: number }>();
  for (const r of db.prepare("SELECT role_id, SUM(started_at IS NOT NULL) AS held, SUM(started_at IS NULL) AS waiting FROM fleet_role_assignments WHERE ended_at IS NULL GROUP BY role_id").all()) {
    out.set(String(r.role_id), { members: Number(r.held), scheduled: Number(r.waiting) });
  }
  return out;
}

export function listRoles(db: Db, includeArchived: boolean): RoleView[] {
  const counts = countsOf(db);
  return db
    .prepare(`SELECT id, name, description, archived_at, created_at FROM fleet_roles ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY archived_at IS NOT NULL, lower(name), id`)
    .all()
    .map((r) => toRole(r, counts));
}

export function getRole(db: Db, id: string): RoleView {
  const r = db.prepare("SELECT id, name, description, archived_at, created_at FROM fleet_roles WHERE id = ?").get(id);
  if (!r) return fail("role_not_found", "No such role.", 404);
  return toRole(r, countsOf(db));
}

const ASSIGNMENT_SQL = `SELECT a.id, a.role_id, r.name AS role_name, a.subject_kind, a.subject_id, a.reason, a.note, a.valid_from, a.valid_until, a.started_at, a.ended_at, a.end_reason, a.created_at,
  COALESCE(CASE a.subject_kind WHEN 'agent' THEN (SELECT name FROM fleet_agents WHERE id = a.subject_id) ELSE (SELECT name FROM fleet_people WHERE id = a.subject_id) END, '(removed)') AS subject_name
  FROM fleet_role_assignments a JOIN fleet_roles r ON r.id = a.role_id`;

function toAssignment(r: Record<string, unknown>): AssignmentView {
  return {
    id: String(r.id),
    role: { id: String(r.role_id), name: String(r.role_name) },
    subject: { kind: r.subject_kind as SubjectKind, id: String(r.subject_id), name: String(r.subject_name) },
    reason: String(r.reason),
    note: r.note === null ? null : String(r.note),
    validFrom: iso(r.valid_from),
    validUntil: iso(r.valid_until),
    state: r.ended_at !== null ? "ended" : r.started_at === null ? "scheduled" : "active",
    endedAt: iso(r.ended_at),
    endReason: r.end_reason === null ? null : String(r.end_reason),
    createdAt: iso(r.created_at) as string,
  };
}

/** Open assignments of one role first, then the newest ended ones (at most `endedLimit`). */
export function assignmentsOfRole(db: Db, roleId: string, endedLimit = 50): AssignmentView[] {
  const open = db.prepare(`${ASSIGNMENT_SQL} WHERE a.role_id = ? AND a.ended_at IS NULL ORDER BY lower(subject_name), a.id`).all(roleId);
  const ended = db.prepare(`${ASSIGNMENT_SQL} WHERE a.role_id = ? AND a.ended_at IS NOT NULL ORDER BY a.ended_at DESC, a.id DESC LIMIT ?`).all(roleId, endedLimit);
  return [...open, ...ended].map(toAssignment);
}

export function assignmentsOfSubject(db: Db, kind: SubjectKind, id: string, endedLimit = 20): AssignmentView[] {
  const open = db.prepare(`${ASSIGNMENT_SQL} WHERE a.subject_kind = ? AND a.subject_id = ? AND a.ended_at IS NULL ORDER BY lower(r.name), a.id`).all(kind, id);
  const ended = db.prepare(`${ASSIGNMENT_SQL} WHERE a.subject_kind = ? AND a.subject_id = ? AND a.ended_at IS NOT NULL ORDER BY a.ended_at DESC, a.id DESC LIMIT ?`).all(kind, id, endedLimit);
  return [...open, ...ended].map(toAssignment);
}

export function getAssignment(db: Db, id: string): AssignmentView {
  const r = db.prepare(`${ASSIGNMENT_SQL} WHERE a.id = ?`).get(id);
  if (!r) return fail("assignment_not_found", "No such assignment.", 404);
  return toAssignment(r);
}

export interface RoleInput {
  id?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  archived?: boolean | undefined;
}

const WORKSPACE = { kind: "workspace", id: "", name: "Governance" };

/** Create (no id) or change a role: its name, its description, and archive or bring it back. Every change moves the revision (the name is in the feed). */
export function setRole(db: Db, input: RoleInput, actorId: string | null, now = Date.now()): RoleView {
  return db.transaction(() => {
    const actor = SYSTEM_OR_OWNER(actorId);
    let id = input.id;
    const name = input.name === undefined ? undefined : cleanText(input.name);
    if (name !== undefined && (name.length < 1 || name.length > ROLE_CAPS.nameMax)) fail("input_invalid", `A role name has 1 to ${ROLE_CAPS.nameMax} characters.`, 400);
    const description = input.description === undefined ? undefined : cleanText(input.description).slice(0, ROLE_CAPS.descriptionMax);
    if (id === undefined) {
      if (name === undefined) fail("input_invalid", "Name the role.", 400);
      const live = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_roles WHERE archived_at IS NULL").get()?.n ?? 0);
      if (live >= ROLE_CAPS.roles) fail("too_many_roles", `A workspace has at most ${ROLE_CAPS.roles} roles. Archive one first.`, 409);
      id = `rol_${ulid(now)}`;
      try {
        db.prepare("INSERT INTO fleet_roles (id, name, description, archived_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)").run(id, name as string, description ?? "", now, now);
      } catch (e) {
        throw takenOr(e);
      }
      bump(db);
      appendEvent(db, { subject: { ...WORKSPACE, kind: "role", id, name: name as string }, kind: "changed", actor, note: "Role created.", at: now });
    } else {
      const cur = db.prepare("SELECT id, name, archived_at FROM fleet_roles WHERE id = ?").get(id);
      if (!cur) fail("role_not_found", "No such role.", 404);
      const wasArchived = (cur as Record<string, unknown>).archived_at !== null;
      const archive = input.archived === undefined ? wasArchived : input.archived;
      try {
        db.prepare("UPDATE fleet_roles SET name = COALESCE(?, name), description = COALESCE(?, description), archived_at = ?, updated_at = ? WHERE id = ?").run(name ?? null, description ?? null, archive ? (wasArchived ? ((cur as Record<string, unknown>).archived_at as number) : now) : null, now, id);
      } catch (e) {
        throw takenOr(e);
      }
      bump(db);
      const what = archive !== wasArchived ? (archive ? "Role archived: a rule that names it no longer matches anyone." : "Role brought back.") : "Role changed.";
      appendEvent(db, { subject: { ...WORKSPACE, kind: "role", id, name: name ?? String((cur as Record<string, unknown>).name) }, kind: "changed", actor, note: what, at: now });
    }
    return getRole(db, id);
  });
}

function takenOr(e: unknown): unknown {
  return e instanceof Error && /UNIQUE/i.test(e.message) ? new TbError("role_name_taken", "Another role has this name.", 409) : e;
}

export interface AssignInput {
  role: string;
  subject: { kind: SubjectKind; id: string };
  reason: RoleReason;
  note?: string | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
}

/**
 * The checks of an assignment, in one place so a later lane (T2-c, "Cannot hold both") adds its check here and nowhere else. Throws a TbError.
 * Roles are for people and agents the owner can still use: not an outside agent, not one that is leaving or closed.
 */
function checkAssignable(db: Db, input: AssignInput, role: Record<string, unknown>): void {
  if (role.archived_at !== null) fail("role_archived", "This role is archived. Bring it back first.", 409);
  const s = input.subject;
  if (s.kind === "person") {
    const p = db.prepare("SELECT kind, lifecycle FROM fleet_people WHERE id = ?").get(s.id);
    if (!p) fail("person_not_found", "No such person.", 404);
    if ((p as Record<string, unknown>).kind !== "person") fail("no_roles_for_outside_agent", "An outside agent has no roles. Use its trust state.", 409);
    const l = (p as Record<string, unknown>).lifecycle;
    if (l === "leaving" || l === "archived") fail("subject_leaving", "This person is leaving or closed. Bring the person back first.", 409);
  } else {
    const a = db.prepare("SELECT lifecycle, status FROM fleet_agents WHERE id = ?").get(s.id);
    if (!a) fail("agent_not_found", "No such agent.", 404);
    const l = (a as Record<string, unknown>).lifecycle;
    if (l === "leaving" || l === "archived") fail("subject_leaving", "This agent is leaving or closed.", 409);
    if ((a as Record<string, unknown>).status === "removed") fail("agent_removed", "This agent is not in Portal any more.", 409);
  }
}

/** One assignment. A start date that has passed needs no wait. An end date that has passed is refused: it would end at once, with nobody holding the role. */
export function assignRole(db: Db, input: AssignInput, actorId: string | null, now = Date.now()): AssignmentView {
  return db.transaction(() => {
    const actor = SYSTEM_OR_OWNER(actorId);
    if (!(ROLE_REASONS as readonly string[]).includes(input.reason)) fail("input_invalid", "Choose a reason from the list.", 400);
    const role = db.prepare("SELECT id, name, archived_at FROM fleet_roles WHERE id = ?").get(input.role);
    if (!role) return fail("role_not_found", "No such role.", 404);
    checkAssignable(db, input, role);
    const from = parseDate(input.validFrom, "validFrom");
    const until = parseDate(input.validUntil, "validUntil");
    if (until !== null && until <= now) fail("date_in_past", "The end date has passed. Choose a later end date.", 400);
    if (from !== null && until !== null && from >= until) fail("input_invalid", "The start date must be before the end date.", 400);
    const held = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_role_assignments WHERE role_id = ? AND ended_at IS NULL").get(input.role)?.n ?? 0);
    if (held >= ROLE_CAPS.membersPerRole) fail("role_full", `A role holds at most ${ROLE_CAPS.membersPerRole} assignments.`, 409);
    if (db.prepare("SELECT 1 FROM fleet_role_assignments WHERE role_id = ? AND subject_kind = ? AND subject_id = ? AND ended_at IS NULL").get(input.role, input.subject.kind, input.subject.id)) {
      fail("already_assigned", "This role is already assigned. End it first to change the dates.", 409);
    }
    const name = subjectName(db, input.subject.kind, input.subject.id) as string;
    const id = `ras_${ulid(now)}`;
    const startsNow = from === null || from <= now;
    const note = cleanText(input.note ?? "").slice(0, ROLE_CAPS.noteMax) || null;
    db.prepare("INSERT INTO fleet_role_assignments (id, role_id, subject_kind, subject_id, reason, note, valid_from, valid_until, started_at, ended_at, end_reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)").run(
      id,
      input.role,
      input.subject.kind,
      input.subject.id,
      input.reason,
      note,
      startsNow ? null : from,
      until,
      startsNow ? now : null,
      actorId,
      now,
    );
    bump(db);
    appendEvent(db, {
      subject: { kind: input.subject.kind, id: input.subject.id, name },
      kind: "changed",
      actor,
      reason: input.reason,
      note: `Role ${String((role as Record<string, unknown>).name)} ${startsNow ? "assigned" : `will start on ${isoDay(from)}`}. End date ${isoDay(until)}.`.slice(0, 500),
      at: now,
    });
    return getAssignment(db, id);
  });
}

function endOne(db: Db, a: Record<string, unknown>, why: EndReason, text: string, actor: { kind: "owner" | "system"; id: string | null }, now: number): void {
  db.prepare("UPDATE fleet_role_assignments SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL").run(now, why, String(a.id));
  const name = subjectName(db, a.subject_kind as SubjectKind, String(a.subject_id)) ?? "(removed)";
  appendEvent(db, { subject: { kind: String(a.subject_kind), id: String(a.subject_id), name }, kind: "changed", actor, reason: String(a.reason), note: `Role ${String(a.role_name)} ended: ${text}`.slice(0, 500), at: now });
}

/** The owner ends one assignment now (or cancels one that waits for its start date). Ending it removes no Portal grant. */
export function endAssignment(db: Db, id: string, actorId: string | null, now = Date.now()): AssignmentView {
  return db.transaction(() => {
    const a = db.prepare(`${ASSIGNMENT_SQL} WHERE a.id = ?`).get(id);
    if (!a) return fail("assignment_not_found", "No such assignment.", 404);
    if (a.ended_at !== null) fail("already_ended", "This assignment has ended.", 409);
    bump(db);
    endOne(db, a, "owner", "the owner ended it.", SYSTEM_OR_OWNER(actorId), now);
    return getAssignment(db, id);
  });
}

/** T7 and a delete: every open assignment of the subject ends, one event each, one revision move. Returns how many. */
export function endAssignmentsOf(db: Db, kind: SubjectKind, id: string, why: "closed" | "deleted", actor: { kind: "owner" | "system"; id: string | null }, now: number): number {
  const rows = db.prepare(`${ASSIGNMENT_SQL} WHERE a.subject_kind = ? AND a.subject_id = ? AND a.ended_at IS NULL ORDER BY a.id`).all(kind, id);
  if (rows.length === 0) return 0;
  bump(db);
  for (const a of rows) endOne(db, a, why, why === "closed" ? "the entry was closed." : "the entry was deleted.", actor, now);
  return rows.length;
}

export interface FeedRole {
  id: string;
  name?: string;
  members: { kind: "agent" | "contact"; id: string }[];
}

/**
 * The `roles` of the feed (`accept: ["roles"]`): every role that is not archived, with the agents and people that hold it now. A member the feed
 * does not list is left out, like a team member. Throws the feed's 503 when the directory is larger than the caps (a reader keeps its last copy).
 */
export function feedRoles(db: Db, agentIds: ReadonlySet<string>, contactIds: ReadonlySet<string>): FeedRole[] {
  const roles = db.prepare("SELECT id, name FROM fleet_roles WHERE archived_at IS NULL ORDER BY id").all();
  if (roles.length > ROLE_CAPS.roles) throw new TbError("feed_too_large", `the directory has more than ${ROLE_CAPS.roles} roles`, 503);
  const members = new Map<string, FeedRole["members"]>();
  for (const r of db
    .prepare("SELECT a.role_id, a.subject_kind, a.subject_id FROM fleet_role_assignments a JOIN fleet_roles r ON r.id = a.role_id WHERE a.ended_at IS NULL AND a.started_at IS NOT NULL AND r.archived_at IS NULL ORDER BY a.role_id, a.subject_kind, a.subject_id")
    .all()) {
    const id = String(r.subject_id);
    const isAgent = r.subject_kind === "agent";
    if (!(isAgent ? agentIds : contactIds).has(id)) continue;
    const key = String(r.role_id);
    const list = members.get(key) ?? [];
    list.push({ kind: isAgent ? "agent" : "contact", id });
    members.set(key, list);
  }
  return roles.map((r) => {
    const name = String(r.name);
    const list = members.get(String(r.id)) ?? [];
    if (list.length > ROLE_CAPS.membersPerRole) throw new TbError("feed_too_large", `a role has more than ${ROLE_CAPS.membersPerRole} members`, 503);
    return { id: String(r.id), ...(name.length >= 1 && name.length <= ROLE_CAPS.nameMax ? { name } : {}), members: list };
  });
}

/** Counts for the Summary and the tests. */
export function roleCounts(db: Db): { roles: number; held: number; scheduled: number } {
  const r = db.prepare("SELECT (SELECT COUNT(*) FROM fleet_roles WHERE archived_at IS NULL) AS roles, COALESCE(SUM(started_at IS NOT NULL), 0) AS held, COALESCE(SUM(started_at IS NULL), 0) AS waiting FROM fleet_role_assignments WHERE ended_at IS NULL").get();
  return { roles: Number(r?.roles ?? 0), held: Number(r?.held ?? 0), scheduled: Number(r?.waiting ?? 0) };
}
