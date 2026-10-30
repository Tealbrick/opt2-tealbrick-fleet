// The ONE writer of a lifecycle (C380, DESIGN-C380 §2). test/lifecycle.test.ts scans src/ for any other writer. No op an agent
// can call reaches this file: every caller is a person op, the agentsChanged event or the date timer. Every function here runs inside
// one transaction with no await, and every change writes one event in that transaction.
//
// Governance records intent. Nothing here calls another app or Core: Rules sees the change through the feed, and Core acts only
// after the owner approves there.
import { canonicalize } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { bump, fail, revision } from "../meta.ts";
import { hasAppliedStop, hasOpenPlan, lastPlanUnfinished, senderBarOpen, unnamedAccounts } from "../plans/guards.ts";
import { endAssignmentsOf } from "../roles/roles.ts";
import { cleanText } from "../text.ts";
import type { Trust } from "../trust.ts";
import { appendEvent, SNAPSHOT_MAX, stoppedSince, stopsSince } from "./events.ts";
import { coolingDays, stopCap } from "./settings.ts";
import { type Lifecycle, NEXT, personStatusOf, type Reason, STOP_STATES, type SubjectKind } from "./states.ts";

export const DAY_MS = 86_400_000;
export const CAP_WINDOW_MS = 600_000;

export interface Actor {
  kind: "owner" | "system";
  id: string | null;
}

export interface Subject {
  kind: SubjectKind;
  id: string;
  name: string;
  lifecycle: Lifecycle;
  rev: number;
  at: number;
  validFrom: number | null;
  validUntil: number | null;
  trust: Trust;
  /** agents only */
  ownerId: string | null;
  runtime: "active" | "paused" | "removed" | null;
  noCard: boolean;
  keepRunning: boolean;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The subject, or null when unknown. A contact with no lifecycle (an outside agent) throws `no_lifecycle`. */
export function loadSubject(db: Db, kind: SubjectKind, id: string): Subject | null {
  if (kind === "agent") {
    const r = db.prepare("SELECT id, name, lifecycle, lifecycle_rev, lifecycle_at, valid_from, valid_until, trust, owner_id, status, migrated_note, keep_running FROM fleet_agents WHERE id = ?").get(id);
    if (!r) return null;
    return {
      kind,
      id,
      name: String(r.name),
      lifecycle: r.lifecycle as Lifecycle,
      rev: Number(r.lifecycle_rev),
      at: Number(r.lifecycle_at),
      validFrom: num(r.valid_from),
      validUntil: num(r.valid_until),
      trust: r.trust as Trust,
      ownerId: r.owner_id === null ? null : String(r.owner_id),
      runtime: r.status as Subject["runtime"],
      noCard: r.migrated_note === "no_card",
      keepRunning: Number(r.keep_running) === 1,
    };
  }
  const r = db.prepare("SELECT id, name, kind, lifecycle, lifecycle_rev, lifecycle_at, valid_from, valid_until, trust FROM fleet_people WHERE id = ?").get(id);
  if (!r) return null;
  if (r.lifecycle === null) fail("no_lifecycle", "An outside agent has no lifecycle. Use its trust state.", 409);
  return { kind, id, name: String(r.name), lifecycle: r.lifecycle as Lifecycle, rev: Number(r.lifecycle_rev), at: Number(r.lifecycle_at), validFrom: num(r.valid_from), validUntil: num(r.valid_until), trust: r.trust as Trust, ownerId: null, runtime: null, noCard: false, keepRunning: false };
}

const personLifecycle = (db: Db, id: string | null): string | null => (id === null ? null : ((db.prepare("SELECT lifecycle FROM fleet_people WHERE id = ?").get(id)?.lifecycle as string | null | undefined) ?? null));

/** Agents of this person whose stop is not decided: no keep-running tick, not themselves leaving or closed. */
export function undecidedAgents(db: Db, personId: string): string[] {
  return db
    .prepare("SELECT name FROM fleet_agents WHERE owner_id = ? AND status <> 'removed' AND lifecycle NOT IN ('leaving', 'archived') AND keep_running = 0 ORDER BY name COLLATE NOCASE")
    .all(personId)
    .map((r) => String(r.name));
}

/** Agents of this person that were decided `stop` and still run. */
function stillRunning(db: Db, personId: string): string[] {
  return db
    .prepare("SELECT name FROM fleet_agents WHERE owner_id = ? AND status = 'active' AND lifecycle IN ('leaving', 'archived') ORDER BY name COLLATE NOCASE")
    .all(personId)
    .map((r) => String(r.name));
}

export interface Problem {
  code: string;
  message: string;
  status: number;
}
const no = (code: string, message: string, status = 409): Problem => ({ code, message, status });

export const coolingEnd = (s: Pick<Subject, "at">, days: number): number => s.at + days * DAY_MS;

/**
 * The guards of one transition, or null when it may run. Reads only. The same function answers the `blocked` text on the page and the
 * refusal in the setter, so the two cannot differ. `waive` is the named reason that ends the cooling period early (T7).
 */
export function guardOf(db: Db, s: Subject, to: Lifecycle, opts: { waive?: string | undefined }, now: number): Problem | null {
  if (s.lifecycle === to) return no("already_in_state", "It is already in this state.");
  // T9: a closed agent stays closed. The one exception is a row the migration closed with no card, whose card came back.
  if (s.kind === "agent" && s.lifecycle === "archived" && !(s.noCard && s.runtime !== "removed")) {
    return no("archived_terminal", "A closed agent stays closed. Reinstate it in Portal within 30 days, or add a new agent.");
  }
  if (!NEXT[s.lifecycle].includes(to)) return no("transition_not_allowed", `It cannot move from ${s.lifecycle} to ${to}.`);
  // T6: an applied stop is not undone by a word here. Bring it back (T6b): grants do not restore.
  if (to === "active" && s.lifecycle === "leaving" && hasAppliedStop(db, s.kind, s.id)) return no("plan_applied", "You approved this stop in Portal. Use Bring back: grants do not come back by themselves.");
  if (to === "active") {
    if (s.trust === "blocked") return no("trust_blocked", "It is blocked. Record a new review first.");
    if (s.kind === "agent") {
      if (s.ownerId === null) return no("owner_required", "Name an owner first.");
      if (personLifecycle(db, s.ownerId) !== "active") return no("owner_inactive", "The owner is not active. Name an active owner first.");
    }
    if (s.validUntil !== null && s.validUntil <= now) return no("date_passed", "The end date has passed. Change the end date first.");
  }
  if (to === "archived") {
    if (hasOpenPlan(db, s.kind, s.id)) return no("plan_open", "A plan for this entry is still open. Finish it or cancel it first.");
    if (lastPlanUnfinished(db, s.kind, s.id) && !cleanText(opts.waive ?? "")) return no("plan_not_finished", "The last plan for this entry did not finish. Make a new plan, or give a reason to close it now.");
    const days = coolingDays(db);
    if (coolingEnd(s, days) > now && !cleanText(opts.waive ?? "")) return no("cooling_not_over", `You can close this after the cooling period of ${days} days. To close it now, give a reason.`);
    if (s.kind === "agent" && s.runtime === "active") return no("plan_open", "This agent still runs. Pause it in Portal first.");
    if (s.kind === "person") {
      if (senderBarOpen(db, s.id) && !cleanText(opts.waive ?? "")) return no("sender_bar_open", "Messages from this person can still reach agents. Wait for Connect to show the bar, or give a reason to close it now.");
      const unnamed = unnamedAccounts(db, s.id, now);
      if (unnamed > 0) return no("unlinked_accounts", `${unnamed} accounts in Connect have no person. Check them. If none is this person's, accept that with a reason.`);
      const open = undecidedAgents(db, s.id);
      if (open.length > 0) return no("agents_undecided", `Decide for these agents first: ${open.slice(0, 5).join(", ")}${open.length > 5 ? ` and ${open.length - 5} more` : ""}.`);
      const running = stillRunning(db, s.id);
      if (running.length > 0) return no("plan_open", `These agents still run. Pause them in Portal first: ${running.slice(0, 5).join(", ")}${running.length > 5 ? ` and ${running.length - 5} more` : ""}.`);
    }
  }
  return null;
}

/** Stops in the last 10 minutes and the limit (S2-7). */
export function capState(db: Db, now: number): { used: number; limit: number } {
  return { used: stopsSince(db, now - CAP_WINDOW_MS), limit: stopCap(db) };
}

/** The entries one stop reaches: a person and the agents that stop with them. */
export function stopReach(db: Db, kind: string, id: string): string[] {
  const own = kind === "person" ? db.prepare("SELECT id FROM fleet_agents WHERE owner_id = ? AND status <> 'removed' AND keep_running = 0 AND lifecycle <> 'archived'").all(id).map((r) => `agent:${String(r.id)}`) : [];
  return [`${kind}:${id}`, ...own];
}

/** N2-3: counted in entries, and only what is new in this window needs the confirm. `details.count` stays: any page that can call this can read the count, so hiding it would stop no script. */
export function assertCap(db: Db, confirmCount: number | undefined, now: number, adding: readonly string[]): void {
  const seen = stoppedSince(db, now - CAP_WINDOW_MS);
  const before = seen.size;
  for (const k of adding) seen.add(k);
  const limit = stopCap(db);
  if (seen.size > before && seen.size > limit && confirmCount !== seen.size) throw new TbError("stop_cap_reached", `This makes ${seen.size} stopped in the last 10 minutes. Confirm ${seen.size}.`, 409, { count: seen.size });
}

export interface Grant {
  agent: string;
  product: string;
  crud: string[];
}

/** What the subject could reach before the change, kept with the event so "Bring back" can show what to grant again. Kept under the size limit by cutting the longest list. */
function snapshotOf(db: Db, s: Subject, grants: readonly Grant[]): Json {
  const kindRow = s.kind === "agent" ? "agent" : "person";
  const teams = db
    .prepare("SELECT t.name, m.role FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.kind = ? AND m.subject_id = ? ORDER BY t.name COLLATE NOCASE, t.id")
    .all(kindRow, s.id)
    .map((t) => ({ team: String(t.name), role: String(t.role) }));
  const agents = s.kind === "person" ? db.prepare("SELECT id, name FROM fleet_agents WHERE owner_id = ? AND status <> 'removed' ORDER BY name COLLATE NOCASE, id").all(s.id).map((a) => ({ id: String(a.id), name: String(a.name) })) : [];
  const doc = { name: s.name, lifecycle: s.lifecycle, trust: s.trust, teams, agents, grants: [...grants], cut: false };
  const fits = () => JSON.stringify(doc).length <= SNAPSHOT_MAX;
  for (const list of [doc.grants, doc.agents, doc.teams] as unknown[][]) {
    while (!fits() && list.length > 0) {
      list.pop();
      doc.cut = true;
    }
  }
  return JSON.parse(canonicalize(doc as unknown as Json)) as Json;
}

export interface TransitionInput {
  kind: SubjectKind;
  id: string;
  to: Lifecycle;
  reason: Reason;
  note?: string | undefined;
  actor: Actor;
  expectedRev?: number | undefined;
  confirmCount?: number | undefined;
  waive?: string | undefined;
  grants?: readonly Grant[] | undefined;
  /** A stop decided inside a person's own change: that change already counted. */
  noCap?: boolean | undefined;
}

function writeState(db: Db, s: Subject, to: Lifecycle, reason: Reason | "migrated", note: string | null, now: number): number {
  bump(db);
  const rev = revision(db);
  // No write of updated_at: an agent reads it in the lean views, and no agent may see that a stop or a leaving started (S2-8). lifecycle_at holds the date.
  if (s.kind === "agent") {
    db.prepare("UPDATE fleet_agents SET lifecycle = ?, lifecycle_rev = ?, lifecycle_reason = ?, lifecycle_note = ?, lifecycle_at = ?, migrated_note = NULL WHERE id = ?").run(to, rev, reason, note, now, s.id);
  } else {
    db.prepare("UPDATE fleet_people SET lifecycle = ?, status = ?, lifecycle_rev = ?, lifecycle_reason = ?, lifecycle_note = ?, lifecycle_at = ? WHERE id = ?").run(to, personStatusOf(to), rev, reason, note, now, s.id);
  }
  return rev;
}

/** One transition with all its guards and causes. Throws the guard's TbError; a refusal writes nothing. */
export function transition(db: Db, input: TransitionInput, now = Date.now()): { from: Lifecycle; to: Lifecycle; event: string; rev: number } {
  return db.transaction(() => {
    const s = loadSubject(db, input.kind, input.id) ?? fail(input.kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
    if (input.expectedRev !== undefined && input.expectedRev !== s.rev) fail("lifecycle_stale", "This entry changed since you looked. Open it again.", 409);
    const problem = guardOf(db, s, input.to, { waive: input.waive }, now);
    if (problem) throw new TbError(problem.code, problem.message, problem.status);
    if (STOP_STATES.includes(input.to) && !input.noCap) assertCap(db, input.confirmCount, now, stopReach(db, s.kind, s.id));
    const note = cleanText(input.note ?? "").slice(0, 500) || null;
    const waive = cleanText(input.waive ?? "").slice(0, 200);
    const from = s.lifecycle;
    const closing = input.to === "archived";
    // T5 keeps a picture of what to grant again, T2 what was reviewed. T7 keeps the picture after the close: see below.
    const before = input.to === "leaving" || (from === "proposed" && input.to === "active") ? snapshotOf(db, s, input.grants ?? []) : undefined;
    const rev = writeState(db, s, input.to, input.reason, note, now);
    const backToWork = input.to === "active" && s.kind === "person";
    if (backToWork) clearKeepRunning(db, s.id);
    if (closing) endMemberships(db, s, input.actor, now);
    const after = closing ? snapshotOf(db, { ...s, lifecycle: "archived" }, []) : undefined;
    const event = appendEvent(db, {
      subject: { kind: s.kind, id: s.id, name: s.name },
      kind: "transition",
      from,
      to: input.to,
      actor: input.actor,
      reason: input.reason,
      note: closing && waive ? `Cooling period waived: ${waive}${note ? `. ${note}` : ""}`.slice(0, 500) : note,
      ...(before !== undefined ? { snapshot: before } : after !== undefined ? { snapshot: after } : {}),
      at: now,
    });
    return { from, to: input.to, event, rev };
  });
}

/** T7: team memberships and role assignments end, one event each. Handles stay on the row. */
function endMemberships(db: Db, s: Subject, actor: Actor, now: number): void {
  const kind = s.kind === "agent" ? "agent" : "person";
  endAssignmentsOf(db, kind, s.id, "closed", actor, now);
  const rows = db.prepare("SELECT m.team_id, t.name FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.kind = ? AND m.subject_id = ? ORDER BY t.name COLLATE NOCASE, t.id").all(kind, s.id);
  for (const t of rows) {
    db.prepare("DELETE FROM fleet_members WHERE team_id = ? AND kind = ? AND subject_id = ?").run(t.team_id, kind, s.id);
    db.prepare("UPDATE fleet_teams SET updated_at = ? WHERE id = ?").run(now, t.team_id);
    appendEvent(db, { subject: { kind: s.kind, id: s.id, name: s.name }, kind: "moved", actor, note: `Left team ${String(t.name)}: the entry was closed.`.slice(0, 500), at: now });
  }
}

function clearKeepRunning(db: Db, personId: string): void {
  db.prepare("UPDATE fleet_agents SET keep_running = 0, keep_reason = NULL WHERE owner_id = ?").run(personId);
}

/** The tick ends with an owner change: it was about the old owner's key. */
export function clearAgentKeep(db: Db, agentId: string): void {
  db.prepare("UPDATE fleet_agents SET keep_running = 0, keep_reason = NULL WHERE id = ?").run(agentId);
}

/** T1 for an agent: the row exists with the default state; this writes its date and event in the same transaction. */
export function markNewAgent(db: Db, a: { id: string; name: string }, now: number): void {
  db.prepare("UPDATE fleet_agents SET lifecycle_rev = ?, lifecycle_at = ? WHERE id = ?").run(revision(db), now, a.id);
  appendEvent(db, { subject: { kind: "agent", id: a.id, name: a.name }, kind: "transition", from: null, to: "proposed", actor: { kind: "system", id: null }, reason: "other", note: "New agent in this workspace.", at: now });
}

/** A person the owner adds starts `active`. An outside agent has no lifecycle. */
export function initPerson(db: Db, id: string, kind: string, name: string, now: number): void {
  if (kind !== "person") return;
  db.prepare("UPDATE fleet_people SET lifecycle = 'active', status = 'active', lifecycle_rev = ?, lifecycle_at = ? WHERE id = ?").run(revision(db), now, id);
  appendEvent(db, { subject: { kind: "person", id, name }, kind: "transition", from: null, to: "active", actor: { kind: "owner", id: null }, reason: "other", at: now });
}

/** person_set changed the kind. A person with a stop in force cannot become an outside agent: that would lift the stop. */
export function kindChanged(db: Db, id: string, name: string, from: string, to: string, status: string, now: number): void {
  if (from === to) return;
  if (to === "person") {
    const l: Lifecycle = status === "active" ? "active" : "leaving";
    db.prepare("UPDATE fleet_people SET lifecycle = ?, status = ?, lifecycle_rev = ?, lifecycle_at = ? WHERE id = ?").run(l, personStatusOf(l), revision(db), now, id);
    appendEvent(db, { subject: { kind: "person", id, name }, kind: "transition", from: null, to: l, actor: { kind: "owner", id: null }, reason: "other", note: "Changed from outside agent to person.", at: now });
    return;
  }
  const cur = db.prepare("SELECT lifecycle FROM fleet_people WHERE id = ?").get(id)?.lifecycle;
  if (cur !== "active") fail("lifecycle_open", "This person is not active. Bring the person back first.", 409);
  endAssignmentsOf(db, "person", id, "kind_changed", { kind: "owner", id: null }, now); // an outside agent has no roles
  db.prepare("UPDATE fleet_people SET lifecycle = NULL, lifecycle_rev = ?, lifecycle_at = ? WHERE id = ?").run(revision(db), now, id);
  appendEvent(db, { subject: { kind: "person", id, name }, kind: "transition", from: "active", to: null, actor: { kind: "owner", id: null }, reason: "other", note: "Changed from person to outside agent.", at: now });
}

/**
 * person_set with a status: the old form. `departed` is T5 for an entry that is not departed yet, and is a no-op otherwise. `active`
 * on a departed entry is refused: it would skip the guards of T6 and T8, so it goes through the lifecycle.
 */
export function statusRequested(db: Db, id: string, want: "active" | "departed", actor: Actor, now: number): void {
  const s = loadSubject(db, "person", id);
  if (!s) return;
  const cur = personStatusOf(s.lifecycle);
  if (cur === want) return;
  if (want === "active") fail("use_bring_back", "This person left. Use Bring back on the person's page.", 409);
  // This form has no confirm to send. It stops when the window has room, however many agents the person has; past that it names the page that can confirm.
  const { used, limit } = capState(db, now);
  if (used >= limit) throw new TbError("stop_cap_reached", `${used} were stopped in the last 10 minutes. Open this person's page to confirm this stop.`, 409);
  transition(db, { kind: "person", id, to: "leaving", reason: "other", note: "Marked as departed on the People page.", actor, noCap: true }, now);
}

/** person_delete: a stop must end first, by the owner's named step, because the delete would remove the floor on this person's handles and lift the owned agents' stop. Handles stay on a closed row (T7). */
export function beforePersonDelete(db: Db, id: string, actor: Actor, now: number): void {
  const r = db.prepare("SELECT name, kind, lifecycle FROM fleet_people WHERE id = ?").get(id);
  if (!r) return;
  if (r.lifecycle === "suspended" || r.lifecycle === "leaving" || r.lifecycle === "archived") fail("lifecycle_open", "This person is stopped, leaving or closed. Undo that or bring the person back first. A delete would end the refusal on this person's handles.", 409);
  appendEvent(db, { subject: { kind: r.kind === "person" ? "person" : "outside_agent", id, name: String(r.name) }, kind: "changed", from: r.lifecycle === null ? null : String(r.lifecycle), to: null, actor, note: "Deleted from the directory.", at: now });
}

const MAX_DATE_MS = Date.UTC(2100, 0, 1);
function parseDate(raw: string | null, what: string): number | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DATE_MS) fail("input_invalid", `${what} is not a date`, 400);
  return ms;
}

/** Start and end dates. An end date in the past needs a confirm: it stops the entry at the next timer ticks. */
export function setDates(db: Db, input: { kind: SubjectKind; id: string; validFrom?: string | null | undefined; validUntil?: string | null | undefined; confirmPastDate?: boolean | undefined; confirmCount?: number | undefined; noCap?: boolean | undefined; actor: Actor }, now = Date.now()): void {
  db.transaction(() => {
    const s = loadSubject(db, input.kind, input.id) ?? fail(input.kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
    const typed = input.validFrom === undefined ? s.validFrom : parseDate(input.validFrom, "validFrom");
    const from = typed !== null && typed <= now && input.validFrom !== undefined ? null : typed; // a start date that has passed needs no wait
    const until = input.validUntil === undefined ? s.validUntil : parseDate(input.validUntil, "validUntil");
    if (from !== null && until !== null && from >= until) fail("input_invalid", "The start date must be before the end date.", 400);
    if (input.validUntil !== undefined && until !== null && until <= now && !input.confirmPastDate) fail("date_in_past", "This end date has passed. Confirm that you want to stop this entry.", 409);
    // S2-7: a start date in the future stops a working entry at once (floor, not_started), so it counts as a stop. A later date on an entry that already waits does not.
    const startsLater = from !== null && from > now && (s.validFrom === null || s.validFrom <= now) && (s.lifecycle === "active" || s.lifecycle === "proposed");
    if (startsLater && !input.noCap) assertCap(db, input.confirmCount, now, stopReach(db, s.kind, s.id));
    bump(db);
    const table = s.kind === "agent" ? "fleet_agents" : "fleet_people";
    db.prepare(`UPDATE ${table} SET valid_from = ?, valid_until = ?, lifecycle_rev = ? WHERE id = ?`).run(from, until, revision(db), s.id);
    const iso = (ms: number | null) => (ms === null ? "none" : new Date(ms).toISOString().slice(0, 10));
    appendEvent(db, { subject: { kind: s.kind, id: s.id, name: s.name }, kind: "changed", from: s.lifecycle, to: startsLater ? "not_started" : s.lifecycle, actor: input.actor, note: `Start date ${iso(from)}. End date ${iso(until)}.`, at: now });
  });
}

/** The keep-running tick of one agent. The reason is kept: the person who left may still hold this agent's key. */
export function setKeepRunning(db: Db, agentId: string, reason: string, actor: Actor, now = Date.now()): void {
  db.transaction(() => {
    const s = loadSubject(db, "agent", agentId) ?? fail("agent_not_found", "No such agent.", 404);
    const why = cleanText(reason).slice(0, 200);
    if (!why) fail("reason_required", "Say why this agent keeps running.", 400);
    bump(db);
    db.prepare("UPDATE fleet_agents SET keep_running = 1, keep_reason = ?, lifecycle_rev = ? WHERE id = ?").run(why, revision(db), agentId);
    appendEvent(db, { subject: { kind: "agent", id: s.id, name: s.name }, kind: "changed", from: s.lifecycle, to: s.lifecycle, actor, note: `Keeps running: ${why}`.slice(0, 500), at: now });
  });
}

/** The timer: a start date has passed. The date ends and the revision moves, so a reader sees the floor lift. Two ticks agreed before this call. */
export function startDatePassed(db: Db, kind: SubjectKind, id: string, now: number): void {
  db.transaction(() => {
    const s = loadSubject(db, kind, id);
    if (!s || s.validFrom === null || s.validFrom > now) return;
    bump(db);
    const table = kind === "agent" ? "fleet_agents" : "fleet_people";
    db.prepare(`UPDATE ${table} SET valid_from = NULL, lifecycle_rev = ? WHERE id = ?`).run(revision(db), id);
    appendEvent(db, { subject: { kind, id, name: s.name }, kind: "changed", from: "not_started", to: s.lifecycle, actor: { kind: "system", id: null }, note: "The start date passed.", at: now });
  });
}
