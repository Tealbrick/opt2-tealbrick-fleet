// Trust reviews (C166, DESIGN §3, §4): an agent asks, the owner decides. Agents can ask (`review_request`) and can
// never set trust or create a directory entry; only `review_record` (a person op) changes a trust state. A review row is
// evidence: closed rows cannot change (migration 0003 triggers). One verdict, the trust update and the closing of the open
// requests of the subject are ONE transaction (L31).
//
// A request about a handle that is not in the directory stays a request: the handle is kept in the row (owner-only)
// and the entry is created only when the owner records a verdict. So an agent cannot fill the directory, squat a
// handle or learn which handles are known (a known handle gives the same answer).
//
// Snapshot: what the owner sees of the subject now (name, title, kind, status, trust, handles, owner, teams). The Core
// access data (G-2) and the Connect contacts (G-5) do not reach apps yet, so `access` is empty, `policy` null, `contacts`
// 0 and `source` says `directory_only` (L18: no invented data). The digest covers exactly that, plus the email, the id
// of the last verdict and the subject id: a second verdict made from an older picture is `snapshot_stale`.
import { createHash } from "node:crypto";
import { canonicalize, ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { type Shown, sameShown } from "./shown.ts";
import { bump, fail, fleetHandle, MAX_TEAMS_PER_ANSWER, setPerson } from "./store.ts";
import { cleanText } from "./text.ts";
import { REVIEW_DAYS_DEFAULT, type Trust } from "./trust.ts";

export type SubjectKind = "agent" | "person" | "outside_agent";
export type ReviewStatus = "requested" | "done" | "dismissed";
export type Verdict = "trusted" | "limited" | "blocked";

export const DAY_MS = 86_400_000;
/** Open requests one agent (or one app) may have at the same time. */
export const MAX_OPEN_PER_AGENT = 20;
/** Open requests Governance itself (system, no requester id) may have: new agents. */
export const MAX_OPEN_SYSTEM = 100;
const MAX_LIST = 200;

export interface Snapshot {
  digest: string;
  takenAt: string;
  name: string;
  kind: SubjectKind;
  title: string;
  status: "active" | "departed" | "paused" | "removed" | "pending";
  trust: Trust;
  handles: string[];
  owner: string | null;
  ownerName: string | null;
  access: never[];
  policy: null;
  contacts: number;
  teams: string[];
  source: "directory_only";
}
export interface Review {
  id: string;
  subject: { kind: SubjectKind; id: string; name: string };
  /** The canonical handle of a subject that is not in the directory yet (owner-only); null otherwise. */
  subjectHandle: string | null;
  status: ReviewStatus;
  verdict: Trust | null;
  reason: string;
  requestedBy: { kind: "owner" | "agent" | "system"; id: string | null; why: string };
  reviewer: string | null;
  snapshot: Snapshot | null;
  createdAt: string;
  decidedAt: string | null;
  nextDueAt: string | null;
  proposal: null;
}
export interface ReviewPolicy {
  agentDays: number;
  contactDays: number;
  reviewNewAgents: boolean;
  reviewChangedAccess: boolean;
}
export interface DueItem {
  subject: { kind: SubjectKind; id: string; name: string };
  dueAt: string;
  lastReview: string | null;
  lastVerdict: Trust | null;
}

type Row = Record<string, unknown>;
const iso = (ms: unknown) => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown) => (ms === null || ms === undefined ? null : iso(ms));

// ── policy ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function reviewPolicy(db: Db): ReviewPolicy {
  const days = Object.fromEntries(db.prepare("SELECT key, value FROM fleet_review_policy").all().map((r) => [String(r.key), Number(r.value)]));
  const flags = Object.fromEntries(db.prepare("SELECT key, value FROM fleet_review_flags").all().map((r) => [String(r.key), Number(r.value)]));
  return {
    agentDays: days.agent_days ?? REVIEW_DAYS_DEFAULT.agent_days,
    contactDays: days.contact_days ?? REVIEW_DAYS_DEFAULT.contact_days,
    reviewNewAgents: (flags.review_new_agents ?? 1) === 1,
    reviewChangedAccess: (flags.review_changed_access ?? 0) === 1,
  };
}

export function setReviewPolicy(db: Db, input: Partial<ReviewPolicy>): ReviewPolicy {
  return db.transaction(() => {
    for (const [key, v] of [["agent_days", input.agentDays], ["contact_days", input.contactDays]] as const) {
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 7 || v > 730) fail("input_invalid", `${key === "agent_days" ? "agentDays" : "contactDays"} must be 7 to 730 days`, 400);
      db.prepare("INSERT INTO fleet_review_policy (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, v);
    }
    for (const [key, v] of [["review_new_agents", input.reviewNewAgents], ["review_changed_access", input.reviewChangedAccess]] as const) {
      if (v === undefined) continue;
      db.prepare("INSERT INTO fleet_review_flags (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, v ? 1 : 0);
    }
    return reviewPolicy(db);
  });
}

// ── subjects and snapshots ──────────────────────────────────────────────────────────────────────────────────────

interface Subject {
  kind: SubjectKind;
  /** '' = not in the directory yet (a pending subject: only a handle) */
  id: string;
  handle: string | null;
  name: string;
  title: string;
  status: Snapshot["status"];
  trust: Trust;
  createdAt: number;
  owner: string | null;
  ownerName: string | null;
  email: string;
  handles: string[];
}

/** The directory entry, or null (an unknown id, or a person id given as an outside agent and the other way round). */
export function subjectOf(db: Db, kind: SubjectKind, id: string): Subject | null {
  if (kind === "agent") {
    const r = db.prepare("SELECT a.id, a.name, a.status, a.trust, a.first_seen, a.owner_id, a.role, p.name AS owner_name FROM fleet_agents a LEFT JOIN fleet_people p ON p.id = a.owner_id WHERE a.id = ?").get(id);
    return r
      ? {
          kind,
          id,
          handle: null,
          name: String(r.name),
          title: String(r.role),
          status: r.status as Snapshot["status"],
          trust: r.trust as Trust,
          createdAt: Number(r.first_seen),
          owner: r.owner_id === null ? null : String(r.owner_id),
          ownerName: r.owner_name === null ? null : String(r.owner_name),
          email: "",
          handles: [],
        }
      : null;
  }
  const r = db.prepare("SELECT id, name, title, status, trust, created_at, email FROM fleet_people WHERE id = ? AND kind = ?").get(id, kind);
  if (!r) return null;
  const handles = db
    .prepare("SELECT handle FROM fleet_handles WHERE person_id = ? ORDER BY handle")
    .all(id)
    .map((h) => String(h.handle));
  return {
    kind,
    id,
    handle: null,
    name: String(r.name),
    title: String(r.title),
    status: r.status as Snapshot["status"],
    trust: r.trust as Trust,
    createdAt: Number(r.created_at),
    owner: null,
    ownerName: null,
    email: r.email === null ? "" : String(r.email),
    handles,
  };
}

/** A handle that is not in the directory but has open requests: the picture is what the requests say. */
function pendingSubject(db: Db, handle: string): Subject | null {
  const r = db.prepare("SELECT subject_kind, subject_name, created_at FROM fleet_reviews WHERE status = 'requested' AND subject_id = '' AND subject_handle = ? ORDER BY id DESC LIMIT 1").get(handle);
  if (!r) return null;
  return { kind: r.subject_kind as SubjectKind, id: "", handle, name: String(r.subject_name), title: "", status: "pending", trust: "unreviewed", createdAt: Number(r.created_at), owner: null, ownerName: null, email: "", handles: [handle] };
}

/** The entry that owns a canonical handle, if any. */
function contactByHandle(db: Db, handle: string): Subject | null {
  const hit = db.prepare("SELECT p.id, p.kind FROM fleet_handles h JOIN fleet_people p ON p.id = h.person_id WHERE h.handle = ?").get(handle);
  return hit ? subjectOf(db, hit.kind as SubjectKind, String(hit.id)) : null;
}

/** By id (a directory entry) or by handle (an entry, else a pending subject). */
function resolveSubject(db: Db, q: { kind: SubjectKind; id?: string; handle?: string }): Subject | null {
  if (q.id) return subjectOf(db, q.kind, q.id);
  if (q.handle === undefined || q.kind === "agent") return null;
  const h = fleetHandle(q.handle);
  return h ? (contactByHandle(db, h) ?? pendingSubject(db, h)) : null;
}

export function snapshotOf(db: Db, s: Subject, now: number): Snapshot {
  const teams = s.id
    ? db
        .prepare("SELECT t.id, t.name, m.role FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.kind = ? AND m.subject_id = ? ORDER BY t.name COLLATE NOCASE, t.id")
        .all(s.kind === "agent" ? "agent" : "person", s.id)
    : [];
  const last = s.id ? db.prepare("SELECT id FROM fleet_reviews WHERE subject_kind = ? AND subject_id = ? AND status = 'done' AND answered_by IS NULL ORDER BY id DESC LIMIT 1").get(s.kind, s.id) : undefined;
  const shown = {
    name: s.name,
    kind: s.kind,
    title: s.title,
    status: s.status,
    trust: s.trust,
    handles: s.handles,
    owner: s.owner,
    ownerName: s.ownerName,
    teams: teams.slice(0, MAX_TEAMS_PER_ANSWER).map((t) => String(t.name)),
  };
  const digest = createHash("sha256")
    .update(canonicalize({ ...shown, id: s.id, handle: s.handle, teamRoles: teams.map((t) => [String(t.id), String(t.role)]), email: s.email, lastVerdict: last ? String(last.id) : null } as Json))
    .digest("hex");
  return { digest, takenAt: iso(now), ...shown, access: [], policy: null, contacts: 0, source: "directory_only" };
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

function toReview(r: Row): Review {
  return {
    id: String(r.id),
    subject: { kind: r.subject_kind as SubjectKind, id: String(r.subject_id), name: String(r.subject_name) },
    subjectHandle: r.subject_handle === null ? null : String(r.subject_handle),
    status: r.status as ReviewStatus,
    verdict: (r.verdict as Trust | null) ?? null,
    reason: String(r.reason),
    requestedBy: { kind: r.requested_by_kind as Review["requestedBy"]["kind"], id: r.requested_by_id === null ? null : String(r.requested_by_id), why: String(r.requested_why) },
    reviewer: r.reviewer === null ? null : String(r.reviewer),
    snapshot: r.snapshot_json === null ? null : (JSON.parse(String(r.snapshot_json)) as Snapshot),
    createdAt: iso(r.created_at),
    decidedAt: isoOrNull(r.decided_at),
    nextDueAt: isoOrNull(r.next_due_at),
    proposal: null,
  };
}

const getRow = (db: Db, id: string): Row | undefined => db.prepare("SELECT * FROM fleet_reviews WHERE id = ?").get(id);

/** Who asks: an agent (`agent`), a companion app (`system`, its instance id), the owner, or Governance itself (`system`, no id). */
export interface Requester {
  kind: Review["requestedBy"]["kind"];
  id: string | null;
}

/** This requester's open request for the subject, if any (dedup is per requester: nobody learns another requester's request). */
function ownOpen(db: Db, by: Requester, s: Subject): Row | undefined {
  const who = "status = 'requested' AND requested_by_kind = ? AND IFNULL(requested_by_id, '') = ?";
  return s.id
    ? db.prepare(`SELECT * FROM fleet_reviews WHERE ${who} AND subject_kind = ? AND subject_id = ? LIMIT 1`).get(by.kind, by.id ?? "", s.kind, s.id)
    : db.prepare(`SELECT * FROM fleet_reviews WHERE ${who} AND subject_id = '' AND subject_handle = ? LIMIT 1`).get(by.kind, by.id ?? "", s.handle);
}

function insertRequest(db: Db, s: Subject, by: Requester, why: string, now: number): string {
  const id = `rvw_${ulid(now)}`;
  db.prepare(
    "INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_handle, subject_name, status, requested_by_kind, requested_by_id, requested_why, created_at) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)",
  ).run(id, s.kind, s.id, s.id ? null : s.handle, s.name, by.kind, by.id, why, now);
  return id;
}

// ── agent op: review_request ────────────────────────────────────────────────────────────────────────────────────

export interface RequestInput {
  subject: { kind: SubjectKind; id?: string; handle?: string; name?: string };
  why: string;
}

/**
 * An agent (or a companion app, recorded as `system`) asks the owner to review a subject. Dedup per (requester,
 * subject): asking again returns the requester's OWN open request with `duplicate: true`, never another requester's.
 * At most MAX_OPEN_PER_AGENT open requests per requester. An unknown handle creates NO directory entry: the request keeps
 * the handle and the owner decides whether to add it. The text is stored as untrusted text (control characters removed).
 */
export function requestReview(db: Db, by: Requester & { id: string }, input: RequestInput, now = Date.now()): { id: string; status: ReviewStatus; duplicate: boolean } {
  return db.transaction(() => {
    const why = cleanText(input.why);
    if (!why) fail("input_invalid", "say why the owner should review this", 400);
    const { kind, id, handle } = input.subject;
    let subject: Subject | null;
    if (kind === "agent") {
      if (!id) return fail("input_invalid", "an agent subject needs an id", 400);
      subject = subjectOf(db, "agent", id);
      if (!subject || subject.status === "removed") return fail("subject_not_found", "no workspace agent with this id", 404);
    } else if (id) {
      subject = subjectOf(db, kind, id);
      if (!subject) return fail("subject_not_found", "no such entry in the directory", 404);
    } else if (handle !== undefined) {
      const h = fleetHandle(handle);
      if (!h) return fail("handle_invalid", "not a buzz, slack or telegram handle", 400);
      // a known handle and an unknown one answer the same way (no way to find out which handles are in the directory)
      subject = contactByHandle(db, h) ?? {
        kind,
        id: "",
        handle: h,
        name: cleanText(input.subject.name ?? "").slice(0, 120) || h,
        title: "",
        status: "pending",
        trust: "unreviewed",
        createdAt: now,
        owner: null,
        ownerName: null,
        email: "",
        handles: [h],
      };
    } else return fail("input_invalid", "give the id or the handle of the subject", 400);

    const mine = ownOpen(db, by, subject);
    if (mine) return { id: String(mine.id), status: "requested", duplicate: true };
    const open = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE requested_by_kind = ? AND requested_by_id = ? AND status = 'requested'").get(by.kind, by.id)?.n);
    if (open >= MAX_OPEN_PER_AGENT) fail("too_many_requests", `you have ${MAX_OPEN_PER_AGENT} review requests open; wait for the owner to decide`, 429);
    return { id: insertRequest(db, subject, by, why, now), status: "requested", duplicate: false };
  });
}

/** `agentsChanged`: a new agent gets one review request when the policy says so (system request; at most MAX_OPEN_SYSTEM open). */
export function requestForNewAgents(db: Db, created: readonly { id: string; name: string }[], now = Date.now()): number {
  if (created.length === 0 || !reviewPolicy(db).reviewNewAgents) return 0;
  return db.transaction(() => {
    let n = 0;
    let open = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE requested_by_kind = 'system' AND requested_by_id IS NULL AND status = 'requested'").get()?.n);
    for (const a of created) {
      if (open >= MAX_OPEN_SYSTEM) break;
      const s = subjectOf(db, "agent", a.id);
      if (!s || s.status === "removed" || ownOpen(db, { kind: "system", id: null }, s)) continue;
      insertRequest(db, s, { kind: "system", id: null }, "New agent in this workspace.", now);
      n++;
      open++;
    }
    return n;
  });
}

// ── person ops ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RecordInput {
  subject: { kind: SubjectKind; id?: string; handle?: string; name?: string };
  verdict: Verdict;
  reason: string;
  snapshotDigest: string;
  nextReviewDays?: number;
  request?: string;
}

/**
 * The owner records a verdict. Refuses `snapshot_stale` (409) when the subject changed since the owner looked (the digest
 * no longer matches; it also covers the last verdict, so two tabs cannot both decide). Writes the verdict row, sets the
 * trust, closes every open request of the subject. For a handle that is not in the directory the entry is created now,
 * with this verdict as its trust: "add as trusted / limited / blocked".
 */
export function recordReview(db: Db, reviewer: string, input: RecordInput, now = Date.now()): Review {
  return db.transaction(() => {
    let s = resolveSubject(db, input.subject) ?? fail("subject_not_found", "no such entry in the directory, and no open request about this handle", 404);
    const reason = cleanText(input.reason);
    if (!reason) fail("input_invalid", "give a reason; it is kept with the record", 400);
    const snap = snapshotOf(db, s, now);
    if (snap.digest !== input.snapshotDigest) fail("snapshot_stale", "the subject changed since you looked; open the review again", 409);
    let by: Review["requestedBy"] = { kind: "owner", id: reviewer, why: "" };
    if (input.request !== undefined) {
      const q = getRow(db, input.request);
      const sameSubject = q !== undefined && (s.id ? q.subject_kind === s.kind && q.subject_id === s.id : q.subject_id === "" && q.subject_handle === s.handle);
      if (q === undefined || q.status !== "requested" || !sameSubject) return fail("request_not_found", "no open request for this subject with this id", 404);
      by = { kind: q.requested_by_kind as Review["requestedBy"]["kind"], id: q.requested_by_id === null ? null : String(q.requested_by_id), why: String(q.requested_why) };
    }
    const policy = reviewPolicy(db);
    const days = input.nextReviewDays ?? (s.kind === "agent" ? policy.agentDays : policy.contactDays);
    if (!Number.isInteger(days) || days < 7 || days > 730) fail("input_invalid", "the next review must be 7 to 730 days away", 400);

    const pendingHandle = s.id === "" ? s.handle : null;
    if (pendingHandle !== null) {
      // the owner adds the entry now (source agent: it came from an agent's request); the verdict is its first trust state
      const name = cleanText(input.subject.name ?? "").slice(0, 120) || s.name.slice(0, 120);
      const made = setPerson(db, { name, kind: s.kind as "person" | "outside_agent", source: "agent", handles: [pendingHandle] }, now);
      s = subjectOf(db, s.kind, made.id) as Subject;
    }
    // The stale check above bound the picture the owner LOOKED at (for a handle: "pending", no owner, no teams). What is KEPT with
    // the verdict is the entry as it is after this write (L31, same transaction): the picture the next review_get computes, so
    // "changed since the last review" starts false and turns true only on a real change. For a known entry the two are the same.
    const kept = pendingHandle !== null ? snapshotOf(db, s, now) : snap;
    const id = `rvw_${ulid(now)}`;
    db.prepare(
      `INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, verdict, reason, requested_by_kind, requested_by_id, requested_why, reviewer, snapshot_json, snapshot_digest, created_at, decided_at, next_due_at)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, s.kind, s.id, s.name, input.verdict, reason, by.kind, by.id, by.why, reviewer, JSON.stringify(kept), kept.digest, now, now, now + days * DAY_MS);
    if (s.kind === "agent") db.prepare("UPDATE fleet_agents SET trust = ?, updated_at = ? WHERE id = ?").run(input.verdict, now, s.id);
    else db.prepare("UPDATE fleet_people SET trust = ?, updated_at = ? WHERE id = ?").run(input.verdict, now, s.id);
    // every open request about this entry, and about any of its handles, is answered by this verdict
    const handles = [...new Set([...s.handles, ...(pendingHandle ? [pendingHandle] : [])])];
    db.prepare(
      `UPDATE fleet_reviews SET status = 'done', verdict = ?, reviewer = ?, decided_at = ?, snapshot_digest = ?, answered_by = ?
       WHERE status = 'requested' AND ((subject_kind = ? AND subject_id = ?) ${handles.length ? `OR (subject_id = '' AND subject_handle IN (${handles.map(() => "?").join(",")}))` : ""})`,
    ).run(input.verdict, reviewer, now, kept.digest, id, s.kind, s.id, ...handles);
    bump(db);
    return toReview(getRow(db, id) as Row);
  });
}

/** Closes an open request without a verdict (a duplicate, spam). A closed review cannot be dismissed again (409). */
export function dismissReview(db: Db, reviewer: string, id: string, why: string | undefined, now = Date.now()): Review {
  return db.transaction(() => {
    const r = getRow(db, id) ?? fail("review_not_found", "no review with this id", 404);
    if (r.status !== "requested") fail("review_not_open", "this review is already closed", 409);
    db.prepare("UPDATE fleet_reviews SET status = 'dismissed', reason = ?, reviewer = ?, decided_at = ? WHERE id = ?").run(cleanText(why ?? "").slice(0, 500), reviewer, now, id);
    return toReview(getRow(db, id) as Row);
  });
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface ScheduleRow {
  kind: SubjectKind;
  id: string;
  name: string;
  /** When the next review is due (ms): the last verdict's date; else the schedule counted from when it was added (an `unreviewed` one at once). */
  dueMs: number;
  lastId: string | null;
  lastVerdict: Trust | null;
  /** The subject has an open request (it waits for the owner and is not repeated as "due"). */
  hasOpen: boolean;
}

/** The review schedule of every scheduled subject (active people and outside agents, agents that are not removed). ONE query; the only place that decides a due date. */
function reviewSchedule(db: Db): ScheduleRow[] {
  const policy = reviewPolicy(db);
  const rows = db
    .prepare(
      `WITH latest AS (SELECT subject_kind AS k, subject_id AS sid, MAX(id) AS lid FROM fleet_reviews WHERE status = 'done' AND answered_by IS NULL GROUP BY subject_kind, subject_id)
       SELECT s.kind, s.id, s.name, s.trust, s.created, l.id AS last_id, l.verdict AS last_verdict, l.next_due_at AS last_due,
              EXISTS (SELECT 1 FROM fleet_reviews o WHERE o.status = 'requested' AND o.subject_kind = s.kind AND o.subject_id = s.id) AS has_open
       FROM (SELECT 'agent' AS kind, id, name, trust, first_seen AS created FROM fleet_agents WHERE status <> 'removed'
             UNION ALL SELECT kind, id, name, trust, created_at AS created FROM fleet_people WHERE status = 'active') s
       LEFT JOIN latest ON latest.k = s.kind AND latest.sid = s.id
       LEFT JOIN fleet_reviews l ON l.id = latest.lid`,
    )
    .all();
  return rows.map((r) => {
    const days = r.kind === "agent" ? policy.agentDays : policy.contactDays;
    return {
      kind: r.kind as SubjectKind,
      id: String(r.id),
      name: String(r.name),
      dueMs: r.last_id !== null ? Number(r.last_due) : r.trust === "unreviewed" ? Number(r.created) : Number(r.created) + days * DAY_MS,
      lastId: r.last_id === null ? null : String(r.last_id),
      lastVerdict: r.last_id === null ? null : (r.last_verdict as Trust),
      hasOpen: Number(r.has_open) === 1,
    };
  });
}

/** The next review date of every scheduled subject, by `kind:id` (the topology shows it; departed people and removed agents have none). */
export function reviewDueDates(db: Db): Map<string, string> {
  return new Map(reviewSchedule(db).map((r) => [`${r.kind}:${r.id}`, iso(r.dueMs)]));
}

/**
 * Subjects due now: last verdict past its date, or never reviewed and older than the schedule (an `unreviewed` subject
 * is due at once). Subjects with an open request are not repeated here. ONE query for every subject.
 */
export function dueSubjects(db: Db, now = Date.now(), limit = MAX_LIST): { items: DueItem[]; count: number } {
  const items: DueItem[] = reviewSchedule(db)
    .filter((r) => !r.hasOpen && r.dueMs <= now)
    .map((r) => ({ subject: { kind: r.kind, id: r.id, name: r.name }, dueAt: iso(r.dueMs), lastReview: r.lastId, lastVerdict: r.lastVerdict }));
  items.sort((x, y) => x.dueAt.localeCompare(y.dueAt) || x.subject.id.localeCompare(y.subject.id));
  return { items: items.slice(0, limit), count: items.length };
}

/**
 * The subjects (`kind:id`) whose picture is no longer the one their LAST verdict looked at (name, title, status, handles,
 * owner or teams; the rule is `sameShown`, shared with the page). A subject that was never reviewed is not in the set.
 * SET-BASED: one read for the last verdicts and four reads for the current pictures, whatever the number of subjects (the
 * per-subject `subjectOf` + `snapshotOf` cost about 4 queries each: 9,500 at the design size). `within` limits the work to
 * those `kind:id` keys (a focused topology answer). A test compares this with `snapshotOf` for every subject.
 */
export function changedSinceReview(db: Db, within?: ReadonlySet<string>): Set<string> {
  const ids = within ? JSON.stringify([...new Set([...within].map((k) => k.slice(k.indexOf(":") + 1)))]) : null;
  const only = (col: string) => (ids === null ? "" : ` AND ${col} IN (SELECT value FROM json_each(?))`);
  const arg = ids === null ? [] : [ids];
  const verdicts = db
    .prepare(
      `SELECT r.subject_kind, r.subject_id, r.snapshot_json FROM fleet_reviews r
       JOIN (SELECT subject_kind AS k, subject_id AS sid, MAX(id) AS lid FROM fleet_reviews WHERE status = 'done' AND answered_by IS NULL AND subject_id <> ''${only("subject_id")} GROUP BY subject_kind, subject_id) latest ON latest.lid = r.id
       WHERE r.snapshot_json IS NOT NULL`,
    )
    .all(...arg)
    .filter((r) => !within || within.has(`${r.subject_kind}:${r.subject_id}`));
  if (verdicts.length === 0) return new Set();
  // the current pictures of exactly these subjects, in the same shape and order as `snapshotOf`
  const subjects = JSON.stringify([...new Set(verdicts.map((r) => String(r.subject_id)))]);
  const people = new Map(db.prepare("SELECT id, kind, name, title, status FROM fleet_people WHERE id IN (SELECT value FROM json_each(?))").all(subjects).map((r) => [String(r.id), r]));
  const agents = new Map(db.prepare("SELECT id, name, role, status, owner_id FROM fleet_agents WHERE id IN (SELECT value FROM json_each(?))").all(subjects).map((r) => [String(r.id), r]));
  const handles = new Map<string, string[]>();
  for (const h of db.prepare("SELECT person_id, handle FROM fleet_handles WHERE person_id IN (SELECT value FROM json_each(?)) ORDER BY person_id, handle").all(subjects)) {
    const list = handles.get(String(h.person_id)) ?? [];
    list.push(String(h.handle));
    handles.set(String(h.person_id), list);
  }
  const teams = new Map<string, string[]>();
  for (const t of db
    .prepare("SELECT m.kind, m.subject_id, t.name FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.subject_id IN (SELECT value FROM json_each(?)) ORDER BY t.name COLLATE NOCASE, t.id")
    .all(subjects)) {
    const key = `${t.kind}:${t.subject_id}`;
    const list = teams.get(key) ?? [];
    list.push(String(t.name));
    teams.set(key, list);
  }
  const changed = new Set<string>();
  for (const r of verdicts) {
    const kind = r.subject_kind as SubjectKind;
    const id = String(r.subject_id);
    let now: Shown;
    if (kind === "agent") {
      const a = agents.get(id);
      if (!a) continue; // gone: nothing to compare
      now = { name: String(a.name), title: String(a.role), status: String(a.status), handles: [], owner: a.owner_id === null ? null : String(a.owner_id), teams: (teams.get(`agent:${id}`) ?? []).slice(0, MAX_TEAMS_PER_ANSWER) };
    } else {
      const p = people.get(id);
      if (!p || p.kind !== kind) continue;
      now = { name: String(p.name), title: String(p.title), status: String(p.status), handles: handles.get(id) ?? [], owner: null, teams: (teams.get(`person:${id}`) ?? []).slice(0, MAX_TEAMS_PER_ANSWER) };
    }
    if (!sameShown(JSON.parse(String(r.snapshot_json)) as Snapshot, now)) changed.add(`${kind}:${id}`);
  }
  return changed;
}

export interface ReviewList {
  reviews: Review[];
  due: DueItem[];
  dueCount: number;
  openCount: number;
  policy: ReviewPolicy;
  nextCursor: string | null;
}

export function listReviews(db: Db, q: { status?: "open" | "due" | "done" | "all"; subject?: string; cursor?: string; limit?: number }, now = Date.now()): ReviewList {
  const limit = Math.min(q.limit ?? 50, MAX_LIST);
  const status = q.status ?? "all";
  // history = the verdict rows (an answered request points at its verdict row and is not repeated)
  const where = status === "open" ? "status = 'requested'" : status === "done" ? "status = 'done' AND answered_by IS NULL" : status === "due" ? "0" : "(status = 'requested' OR answered_by IS NULL)";
  const rows = db
    .prepare(`SELECT * FROM fleet_reviews WHERE ${where} ${q.subject ? "AND subject_id = ?" : ""} ${q.cursor ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`)
    .all(...[...(q.subject ? [q.subject] : []), ...(q.cursor ? [q.cursor] : []), limit + 1]);
  const page = rows.slice(0, limit);
  const due = dueSubjects(db, now);
  return {
    reviews: page.map(toReview),
    due: due.items,
    dueCount: due.count,
    openCount: Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE status = 'requested'").get()?.n),
    policy: reviewPolicy(db),
    nextCursor: rows.length > limit ? String(page[page.length - 1]?.id) : null,
  };
}

/**
 * One review and the subject's snapshot now (null when the subject is gone). Compare the digests to see what changed.
 * Given a `subject` instead of an id, `review` is the subject's latest verdict row (null if it was never reviewed or is not
 * in the directory yet) and `current` its snapshot now: the owner's first step, and the digest to record against.
 */
export function getReview(db: Db, q: { id?: string; subject?: { kind: SubjectKind; id?: string; handle?: string } }, now = Date.now()): { review: Review | null; current: Snapshot | null } {
  if (q.id !== undefined) {
    const r = getRow(db, q.id) ?? fail("review_not_found", "no review with this id", 404);
    const kind = r.subject_kind as SubjectKind;
    const s = r.subject_id !== "" ? subjectOf(db, kind, String(r.subject_id)) : resolveSubject(db, { kind, handle: String(r.subject_handle) });
    return { review: toReview(r), current: s ? snapshotOf(db, s, now) : null };
  }
  if (!q.subject) return fail("input_invalid", "give the id of a review or a subject", 400);
  const s = resolveSubject(db, q.subject) ?? fail("subject_not_found", "no such entry in the directory, and no open request about this handle", 404);
  const last = s.id ? db.prepare("SELECT * FROM fleet_reviews WHERE subject_kind = ? AND subject_id = ? AND status = 'done' AND answered_by IS NULL ORDER BY id DESC LIMIT 1").get(s.kind, s.id) : undefined;
  return { review: last ? toReview(last) : null, current: snapshotOf(db, s, now) };
}
