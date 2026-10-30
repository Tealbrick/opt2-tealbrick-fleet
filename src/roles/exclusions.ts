// "Cannot hold both" (C380 T2-c, DESIGN-C380 §6, REDTEAM item 12 "SoD by owner"). Owner side only: no agent op reads or writes this file.
//
// A rule names two roles that must not be held together:
//   roles         no person or agent may have role A and role B at the same time;
//   holder_owner  an agent may not have role A while its owner has role B.
// It is checked when a role is given, with date overlap (checkExclusions, called by assignRole inside its transaction, no await), and shown as a
// difference when it is broken later (exclusionFindings, computed on read like every finding: a rule added after the roles, a new owner).
// Only an assignment is ever refused. A stop, a transfer or a new owner is never blocked by a rule: removing access must stay possible.
//
// What it reads: role assignments only. Portal grants are not checked (EXCLUSION_LINE, shown on the page). An archived role matches no one in
// Rules, so an archived role is not held here either. Two assignments overlap when each starts before the other ends; an end date is the first
// moment the role is gone, so "ends 1 Dec" and "starts 1 Dec" are a handover, not a clash. The owner of an agent is its owner now: a later change
// of owner is flagged, not predicted.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { type Finding, stampFinding } from "../findings.ts";
import { appendEvent } from "../lifecycle/events.ts";
import { fail } from "../meta.ts";
import { cleanText } from "../text.ts";
import type { SubjectKind } from "./roles.ts";

export const EXCLUSION_KINDS = ["roles", "holder_owner"] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];
export const EXCLUSION_CAPS = { rules: 200, noteMax: 300, clashesShown: 10 } as const;
/** The label on every screen and refusal that shows a rule. */
export const EXCLUSION_LINE = "This checks roles only. Portal grants are not checked.";
export const CLASH_CODE = "cannot_hold_both";

export interface ExclusionView {
  id: string;
  kind: ExclusionKind;
  a: { id: string; name: string };
  b: { id: string; name: string };
  /** The rule in one plain sentence. */
  text: string;
  note: string | null;
  archived: boolean;
  /** A role of the rule is archived: it matches no one, so the rule does nothing until the role is back. */
  idle: boolean;
  /** Who breaks it now (at most EXCLUSION_CAPS.clashesShown listed, all counted). */
  clashCount: number;
  clashes: { subject: { kind: SubjectKind; id: string; name: string }; text: string }[];
  createdAt: string;
}

type Row = Record<string, unknown>;
const INF = Number.POSITIVE_INFINITY;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();

/** The rule as a clause ("no one may have both A and B") and as a sentence. */
const clause = (kind: ExclusionKind, a: string, b: string): string => (kind === "roles" ? `no one may have both ${a} and ${b}` : `an agent may not have ${a} while its owner has ${b}`);
export const ruleText = (kind: ExclusionKind, a: string, b: string): string => {
  const c = clause(kind, a, b);
  return `${c.charAt(0).toUpperCase()}${c.slice(1)}.`;
};

/** A period during which a subject has a role: it starts at the start date (or when it was given) and ends, exclusive, at the end date. */
interface Span {
  id: string;
  role: string;
  roleName: string;
  start: number;
  end: number;
  created: number;
}
const overlap = (x: Span, y: Span): { from: number; to: number } | null => {
  const from = Math.max(x.start, y.start);
  const to = Math.min(x.end, y.end);
  return from < to ? { from, to } : null;
};

/** When a span is, in words: "until 2026-12-01", "from 2026-11-05 until 2026-12-01", "with no end date". */
function spanText(s: Span, now: number): string {
  const until = s.end === INF ? null : day(s.end);
  if (s.start > now) return until ? `from ${day(s.start)} until ${until}` : `from ${day(s.start)}, no end date`;
  return until ? `until ${until}` : "with no end date";
}

const SPAN_SQL = `SELECT a.id, a.role_id, r.name AS role_name, a.subject_kind, a.subject_id, a.valid_from, a.valid_until, a.started_at, a.created_at
  FROM fleet_role_assignments a JOIN fleet_roles r ON r.id = a.role_id WHERE a.ended_at IS NULL AND r.archived_at IS NULL`;

function toSpan(r: Row): Span {
  return {
    id: String(r.id),
    role: String(r.role_id),
    roleName: String(r.role_name),
    // given now: valid_from is NULL and started_at is the moment; given with a start date: valid_from stays, started_at is when the timer started it
    start: Number(r.valid_from ?? r.started_at ?? r.created_at),
    end: r.valid_until === null ? INF : Number(r.valid_until),
    created: Number(r.created_at),
  };
}

const spansOf = (db: Db, kind: string, id: string): Span[] => db.prepare(`${SPAN_SQL} AND a.subject_kind = ? AND a.subject_id = ?`).all(kind, id).map(toSpan);

const liveRules = (db: Db): Row[] => db.prepare("SELECT id, kind, role_a, role_b, created_at FROM fleet_exclusions WHERE archived_at IS NULL ORDER BY id").all();

const nameOf = (db: Db, table: "fleet_agents" | "fleet_people", id: string): string => String(db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name ?? "(removed)");
const roleName = (db: Db, id: string): string => String(db.prepare("SELECT name FROM fleet_roles WHERE id = ?").get(id)?.name ?? "(removed)");

export interface NewAssignment {
  role: { id: string; name: string };
  subject: { kind: SubjectKind; id: string; name: string };
  /** The moment the role starts: now for "now", else the start date. */
  from: number;
  until: number | null;
}

/**
 * Refuses an assignment that would break a live rule, naming both roles. Call it inside the transaction that inserts the assignment: it reads and
 * the insert follow with no await between, so two assignments cannot slip past each other. Throws `cannot_hold_both` (409).
 */
export function checkExclusions(db: Db, n: NewAssignment, now: number): void {
  const rules = liveRules(db);
  if (rules.length === 0) return;
  const mine: Span = { id: "new", role: n.role.id, roleName: n.role.name, start: n.from, end: n.until ?? INF, created: now };
  const refuse = (rule: Row, text: string): never => {
    const a = roleName(db, String(rule.role_a));
    const b = roleName(db, String(rule.role_b));
    return fail(CLASH_CODE, `${text} A rule says ${clause(rule.kind as ExclusionKind, a, b)}. Choose dates that do not overlap, or end the other role first.`, 409);
  };
  const own = spansOf(db, n.subject.kind, n.subject.id);
  for (const rule of rules) {
    const a = String(rule.role_a);
    const b = String(rule.role_b);
    if (rule.kind === "roles") {
      const other = n.role.id === a ? b : n.role.id === b ? a : null;
      if (other === null) continue;
      const held = own.find((s) => s.role === other && overlap(mine, s));
      if (held) refuse(rule, `${n.subject.name} already has ${held.roleName} (${spanText(held, now)}).`);
      continue;
    }
    // holder_owner: this agent with this role against its owner; or this owner with this role against the agents it owns
    if (n.subject.kind === "agent" && n.role.id === a) {
      const owner = db.prepare("SELECT owner_id FROM fleet_agents WHERE id = ?").get(n.subject.id)?.owner_id;
      if (typeof owner === "string") {
        const held = spansOf(db, "person", owner).find((s) => s.role === b && overlap(mine, s));
        if (held) refuse(rule, `The owner of ${n.subject.name}, ${nameOf(db, "fleet_people", owner)}, already has ${held.roleName} (${spanText(held, now)}).`);
      }
    }
    if (n.subject.kind === "person" && n.role.id === b) {
      for (const agent of db.prepare("SELECT id, name FROM fleet_agents WHERE owner_id = ? AND status <> 'removed' ORDER BY id").all(n.subject.id)) {
        const held = spansOf(db, "agent", String(agent.id)).find((s) => s.role === a && overlap(mine, s));
        if (held) refuse(rule, `${n.subject.name} owns the agent ${String(agent.name)}, which already has ${held.roleName} (${spanText(held, now)}).`);
      }
    }
  }
}

interface Clash {
  subject: { kind: SubjectKind; id: string; name: string };
  text: string;
  /** when the clash came to be: the newest of the two assignments and the rule. An acceptance older than this does not cover it. */
  since: number;
  rule: string;
}

/** The first clash of one pair of spans, in words: now, or from a later date. */
function when(o: { from: number; to: number }, now: number): string {
  return o.from <= now ? "now" : `from ${day(o.from)}`;
}

/** Every broken rule, by who breaks it, from the rows as they are now. No row is written. */
function clashesOf(db: Db, rules: Row[], now: number): Clash[] {
  if (rules.length === 0) return [];
  const bySubject = new Map<string, Span[]>();
  for (const r of db
    .prepare(`${SPAN_SQL} AND a.role_id IN (SELECT role_a FROM fleet_exclusions WHERE archived_at IS NULL UNION SELECT role_b FROM fleet_exclusions WHERE archived_at IS NULL) ORDER BY a.id`)
    .all()) {
    const key = `${String(r.subject_kind)}:${String(r.subject_id)}`;
    const list = bySubject.get(key) ?? [];
    list.push(toSpan(r));
    bySubject.set(key, list);
  }
  const out: Clash[] = [];
  const agents = new Map<string, { name: string; owner: string }>();
  for (const a of db.prepare("SELECT id, name, owner_id FROM fleet_agents WHERE owner_id IS NOT NULL AND status <> 'removed'").all()) agents.set(String(a.id), { name: String(a.name), owner: String(a.owner_id) });
  const people = new Map<string, string>(db.prepare("SELECT id, name FROM fleet_people").all().map((p) => [String(p.id), String(p.name)] as const));
  const names = new Map<string, string>();
  for (const rule of rules) {
    const a = String(rule.role_a);
    const b = String(rule.role_b);
    const ruleAt = Number(rule.created_at);
    names.set(a, names.get(a) ?? roleName(db, a));
    names.set(b, names.get(b) ?? roleName(db, b));
    if (rule.kind === "roles") {
      for (const [key, spans] of bySubject) {
        const x = spans.find((s) => s.role === a);
        if (!x) continue;
        const y = spans.find((s) => s.role === b);
        const o = y ? overlap(x, y) : null;
        if (!y || !o) continue;
        const kind = key.slice(0, key.indexOf(":")) as SubjectKind;
        const id = key.slice(key.indexOf(":") + 1);
        const name = kind === "agent" ? (agents.get(id)?.name ?? nameOf(db, "fleet_agents", id)) : (people.get(id) ?? "(removed)");
        out.push({ subject: { kind, id, name }, text: `${name} has ${x.roleName} and ${y.roleName} ${when(o, now)}. A rule says no one may have both.`, since: Math.max(x.created, y.created, ruleAt), rule: String(rule.id) });
      }
      continue;
    }
    for (const [agentId, info] of agents) {
      const x = bySubject.get(`agent:${agentId}`)?.find((s) => s.role === a);
      const y = bySubject.get(`person:${info.owner}`)?.find((s) => s.role === b);
      const o = x && y ? overlap(x, y) : null;
      if (!x || !y || !o) continue;
      out.push({
        subject: { kind: "agent", id: agentId, name: info.name },
        text: `${info.name} has ${x.roleName}, and its owner, ${people.get(info.owner) ?? "(removed)"}, has ${y.roleName} ${when(o, now)}. A rule says an agent may not have ${x.roleName} while its owner has ${y.roleName}.`,
        since: Math.max(x.created, y.created, ruleAt),
        rule: String(rule.id),
      });
    }
  }
  return out;
}

/**
 * The differences of the Differences page for broken rules, by subject: one finding for a subject, naming up to three clashes, so one acceptance
 * has one subject. The finding carries the time the newest clash began (stampFinding), so an acceptance made before it does not cover it.
 */
export function exclusionFindings(db: Db, now: number): Map<string, Finding> {
  const out = new Map<string, Finding>();
  const rules = liveRules(db);
  if (rules.length === 0) return out;
  const by = new Map<string, Clash[]>();
  for (const c of clashesOf(db, rules, now)) {
    const key = `${c.subject.kind}:${c.subject.id}`;
    by.set(key, [...(by.get(key) ?? []), c]);
  }
  for (const [key, list] of by) {
    const shown = list.slice(0, 3).map((c) => c.text);
    const more = list.length > 3 ? ` And ${list.length - 3} more.` : "";
    const f: Finding = { code: CLASH_CODE, text: `${shown.join(" ")}${more}`.slice(0, 1200) };
    stampFinding(f, Math.max(...list.map((c) => c.since)));
    out.set(key, f);
  }
  return out;
}

function toView(db: Db, r: Row, clashes: Clash[]): ExclusionView {
  const aId = String(r.role_a);
  const bId = String(r.role_b);
  const role = (id: string) => db.prepare("SELECT name, archived_at FROM fleet_roles WHERE id = ?").get(id);
  const ra = role(aId);
  const rb = role(bId);
  const a = String(ra?.name ?? "(removed)");
  const b = String(rb?.name ?? "(removed)");
  const mine = clashes.filter((c) => c.rule === String(r.id));
  return {
    id: String(r.id),
    kind: r.kind as ExclusionKind,
    a: { id: aId, name: a },
    b: { id: bId, name: b },
    text: ruleText(r.kind as ExclusionKind, a, b),
    note: r.note === null ? null : String(r.note),
    archived: r.archived_at !== null,
    idle: ra?.archived_at !== null || rb?.archived_at !== null,
    clashCount: mine.length,
    clashes: mine.slice(0, EXCLUSION_CAPS.clashesShown).map((c) => ({ subject: c.subject, text: c.text })),
    createdAt: iso(r.created_at),
  };
}

const SELECT = "SELECT id, kind, role_a, role_b, note, archived_at, created_at FROM fleet_exclusions";

/** Live rules first, newest first, then archived ones when asked. Clashes are counted for live rules only. */
export function listExclusions(db: Db, includeArchived: boolean, now = Date.now()): ExclusionView[] {
  const live = liveRules(db);
  const clashes = clashesOf(db, live, now);
  return db
    .prepare(`${SELECT} ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY archived_at IS NOT NULL, created_at DESC, id DESC`)
    .all()
    .map((r) => toView(db, r, r.archived_at === null ? clashes : []));
}

export function getExclusion(db: Db, id: string, now = Date.now()): ExclusionView {
  const r = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  if (!r) return fail("rule_not_found", "No such rule.", 404);
  return toView(db, r, r.archived_at === null ? clashesOf(db, liveRules(db), now) : []);
}

export interface ExclusionInput {
  id?: string | undefined;
  kind?: ExclusionKind | undefined;
  roleA?: string | undefined;
  roleB?: string | undefined;
  note?: string | undefined;
  archived?: boolean | undefined;
}

/** The event of a rule: its subject is the rule, named by its sentence. */
const ruleSubject = (id: string, text: string) => ({ kind: "exclusion", id, name: text.slice(0, 120) });

function assertRoleLive(db: Db, id: string): void {
  const r = db.prepare("SELECT archived_at FROM fleet_roles WHERE id = ?").get(id);
  if (!r) fail("role_not_found", "No such role.", 404);
  if ((r as Row).archived_at !== null) fail("role_archived", "This role is archived. Bring it back first.", 409);
}

function assertFree(db: Db, kind: string, a: string, b: string, exceptId: string | null): void {
  const same = db.prepare("SELECT id FROM fleet_exclusions WHERE archived_at IS NULL AND kind = ? AND role_a = ? AND role_b = ?").get(kind, a, b);
  if (same && String(same.id) !== exceptId) fail("rule_exists", "A rule for these roles exists.", 409);
}

/**
 * Create a rule (no id: kind and two roles) or archive one and bring it back (id). A rule is never edited: another pair is another rule. A new rule
 * is made even when the roles are already held together: the answer counts who breaks it, and the differences list shows them.
 */
export function setExclusion(db: Db, input: ExclusionInput, actorId: string | null, now = Date.now()): ExclusionView {
  return db.transaction(() => {
    const actor = actorId === null ? ({ kind: "system", id: null } as const) : ({ kind: "owner", id: actorId } as const);
    let id = input.id;
    if (id === undefined) {
      if (input.kind === undefined || input.roleA === undefined || input.roleB === undefined) return fail("input_invalid", "Choose the kind of rule and two roles.", 400);
      if (input.archived === true) return fail("input_invalid", "A new rule cannot start archived.", 400);
      const kind = input.kind;
      if (!(EXCLUSION_KINDS as readonly string[]).includes(kind)) return fail("input_invalid", "Choose the kind of rule from the list.", 400);
      if (kind === "roles" && input.roleA === input.roleB) return fail("same_role", "Choose two different roles.", 400);
      assertRoleLive(db, input.roleA);
      assertRoleLive(db, input.roleB);
      const [a, b] = kind === "roles" && input.roleA > input.roleB ? [input.roleB, input.roleA] : [input.roleA, input.roleB];
      const live = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_exclusions WHERE archived_at IS NULL").get()?.n ?? 0);
      if (live >= EXCLUSION_CAPS.rules) return fail("too_many_rules", `A workspace has at most ${EXCLUSION_CAPS.rules} rules. Archive one first.`, 409);
      assertFree(db, kind, a, b, null);
      const note = cleanText(input.note ?? "").slice(0, EXCLUSION_CAPS.noteMax) || null;
      id = `xcl_${ulid(now)}`;
      try {
        db.prepare("INSERT INTO fleet_exclusions (id, kind, role_a, role_b, note, archived_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)").run(id, kind, a, b, note, actorId, now, now);
      } catch (e) {
        // the unique index is the net under assertFree
        if (e instanceof Error && /UNIQUE/i.test(e.message)) return fail("rule_exists", "A rule for these roles exists.", 409);
        throw e;
      }
      const text = ruleText(kind, roleName(db, a), roleName(db, b));
      appendEvent(db, { subject: ruleSubject(id, text), kind: "changed", actor, note: `Rule added: ${text}`.slice(0, 500), at: now });
      return getExclusion(db, id, now);
    }
    const cur = db.prepare(`${SELECT} WHERE id = ?`).get(id);
    if (!cur) return fail("rule_not_found", "No such rule.", 404);
    if (input.kind !== undefined || input.roleA !== undefined || input.roleB !== undefined || input.note !== undefined) return fail("input_invalid", "A rule is not changed. Archive it and add another.", 400);
    if (input.archived === undefined) return fail("input_invalid", "Say whether to archive the rule or bring it back.", 400);
    const wasArchived = cur.archived_at !== null;
    if (input.archived === wasArchived) return getExclusion(db, id, now);
    const kind = String(cur.kind);
    const text = ruleText(kind as ExclusionKind, roleName(db, String(cur.role_a)), roleName(db, String(cur.role_b)));
    if (!input.archived) {
      // a rule that comes back needs a free pair, and roles that are in use, like a new one
      assertFree(db, kind, String(cur.role_a), String(cur.role_b), id);
      assertRoleLive(db, String(cur.role_a));
      assertRoleLive(db, String(cur.role_b));
    }
    db.prepare("UPDATE fleet_exclusions SET archived_at = ?, updated_at = ? WHERE id = ?").run(input.archived ? now : null, now, id);
    appendEvent(db, { subject: ruleSubject(id, text), kind: "changed", actor, note: `${input.archived ? "Rule archived: it is no longer checked" : "Rule brought back"}: ${text}`.slice(0, 500), at: now });
    return getExclusion(db, id, now);
  });
}

/** Counts for the Summary and the tests. */
export function exclusionCounts(db: Db): { rules: number } {
  return { rules: Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_exclusions WHERE archived_at IS NULL").get()?.n ?? 0) };
}
