// Trust reviews (C166, DESIGN §3, §4): an agent asks, the owner decides. Agents can ask (`review_request`) and can
// never set trust; only `review_record` (a person op) changes a trust state. A review row is evidence: closed rows
// cannot change (migration 0003 triggers). One verdict, the trust update and the closing of the open requests of
// the subject are ONE transaction (L31).
//
// Snapshot: what Governance knows of the subject now (owner, teams, status, handles). The Core access data (G-2) and the
// Connect contacts (G-5) do not reach apps yet, so `access` is empty, `policy` null, `contacts` 0 and `source` says
// `directory_only` (L18: no invented data). The digest binds the verdict to the picture the owner looked at.
import { createHash } from "node:crypto";
import { canonicalize, normalizeHandle, ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { bump, fail, MAX_TEAMS_PER_ANSWER, setPerson } from "./store.ts";
import { REVIEW_DAYS_DEFAULT, type Trust } from "./trust.ts";

export type SubjectKind = "agent" | "person" | "outside_agent";
export type ReviewStatus = "requested" | "done" | "dismissed";
export type Verdict = "trusted" | "limited" | "blocked";

export const DAY_MS = 86_400_000;
/** Open requests one agent may have at the same time. */
export const MAX_OPEN_PER_AGENT = 20;
const MAX_LIST = 200;

export interface Snapshot {
  digest: string;
  takenAt: string;
  access: never[];
  policy: null;
  contacts: number;
  owner: string | null;
  teams: string[];
  source: "directory_only";
}
export interface Review {
  id: string;
  subject: { kind: SubjectKind; id: string; name: string };
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
  /** The subject now: its digest is what `review_record` needs. */
  snapshot: Snapshot;
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
  id: string;
  name: string;
  status: string;
  trust: Trust;
  createdAt: number;
  owner: string | null;
  detail: string;
}

/** The subject, or null (an unknown id, or a person id given as an outside agent and the other way round). */
export function subjectOf(db: Db, kind: SubjectKind, id: string): Subject | null {
  if (kind === "agent") {
    const r = db.prepare("SELECT id, name, status, trust, first_seen, owner_id, mode FROM fleet_agents WHERE id = ?").get(id);
    return r ? { kind, id, name: String(r.name), status: String(r.status), trust: r.trust as Trust, createdAt: Number(r.first_seen), owner: r.owner_id === null ? null : String(r.owner_id), detail: String(r.mode) } : null;
  }
  const r = db.prepare("SELECT id, name, status, trust, created_at FROM fleet_people WHERE id = ? AND kind = ?").get(id, kind);
  if (!r) return null;
  const handles = db
    .prepare("SELECT handle FROM fleet_handles WHERE person_id = ? ORDER BY handle")
    .all(id)
    .map((h) => String(h.handle));
  return { kind, id, name: String(r.name), status: String(r.status), trust: r.trust as Trust, createdAt: Number(r.created_at), owner: null, detail: handles.join(",") };
}

export function snapshotOf(db: Db, s: Subject, now: number): Snapshot {
  const teams = db
    .prepare("SELECT t.id, t.name, m.role FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.kind = ? AND m.subject_id = ? ORDER BY t.name COLLATE NOCASE, t.id")
    .all(s.kind === "agent" ? "agent" : "person", s.id);
  const digest = createHash("sha256")
    .update(canonicalize({ kind: s.kind, id: s.id, name: s.name, status: s.status, owner: s.owner, detail: s.detail, teams: teams.map((t) => [String(t.id), String(t.role)]) } as Json))
    .digest("hex");
  return {
    digest,
    takenAt: iso(now),
    access: [],
    policy: null,
    contacts: 0,
    owner: s.owner,
    teams: teams.slice(0, MAX_TEAMS_PER_ANSWER).map((t) => String(t.name)),
    source: "directory_only",
  };
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

function toReview(r: Row): Review {
  return {
    id: String(r.id),
    subject: { kind: r.subject_kind as SubjectKind, id: String(r.subject_id), name: String(r.subject_name) },
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
const openFor = (db: Db, kind: SubjectKind, id: string): Row | undefined =>
  db.prepare("SELECT * FROM fleet_reviews WHERE subject_kind = ? AND subject_id = ? AND status = 'requested' ORDER BY id LIMIT 1").get(kind, id);

function insertRequest(db: Db, s: Subject, by: Review["requestedBy"], now: number): string {
  const id = `rvw_${ulid(now)}`;
  db.prepare(
    "INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, requested_by_kind, requested_by_id, requested_why, created_at) VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?)",
  ).run(id, s.kind, s.id, s.name, by.kind, by.id, by.why, now);
  return id;
}

// ── agent op: review_request ────────────────────────────────────────────────────────────────────────────────────

/** Who asks: an agent (`agent`), a companion app (`system`, its instance id) or the owner. */
export interface Requester {
  kind: Review["requestedBy"]["kind"];
  id: string;
}

export interface RequestInput {
  subject: { kind: SubjectKind; id?: string; handle?: string; name?: string };
  why: string;
}

/**
 * An agent (or a companion app, recorded as `system`) asks the owner to review a subject. Dedup per subject (one open request each; a second ask returns the
 * open one with `duplicate: true`), at most MAX_OPEN_PER_AGENT open requests per agent. An unknown handle becomes a
 * directory entry that starts `unreviewed` (source agent). The agent can never set trust.
 */
export function requestReview(db: Db, by: Requester, input: RequestInput, now = Date.now()): { id: string; status: ReviewStatus; duplicate: boolean } {
  return db.transaction(() => {
    const why = input.why.trim();
    if (!why) fail("input_invalid", "say why the owner should review this", 400);
    const { kind, id, handle } = input.subject;
    let subject: Subject | null;
    if (kind === "agent") {
      if (!id) return fail("input_invalid", "an agent subject needs an id", 400);
      subject = subjectOf(db, "agent", id);
      if (!subject || subject.status === "removed") fail("subject_not_found", "no workspace agent with this id", 404);
    } else if (id) {
      subject = subjectOf(db, kind, id);
      if (!subject) fail("subject_not_found", "no such entry in the directory", 404);
    } else if (handle !== undefined) {
      const h = normalizeHandle(handle);
      if (!h) return fail("handle_invalid", "not a buzz, slack or telegram handle", 400);
      const hit = db.prepare("SELECT p.id, p.kind FROM fleet_handles h JOIN fleet_people p ON p.id = h.person_id WHERE h.handle = ?").get(h);
      if (hit) subject = subjectOf(db, hit.kind as SubjectKind, String(hit.id));
      else {
        // setPerson with source agent: the entry starts unreviewed and the revision moves
        const created = setPerson(db, { name: (input.subject.name?.trim() || h).slice(0, 120), kind, source: "agent", handles: [h] }, now);
        subject = subjectOf(db, kind, created.id);
      }
    } else return fail("input_invalid", "give the id or the handle of the subject", 400);
    if (!subject) return fail("subject_not_found", "no such entry in the directory", 404);

    const open = openFor(db, subject.kind, subject.id);
    if (open) return { id: String(open.id), status: "requested", duplicate: true };
    const mine = Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_reviews WHERE requested_by_kind = ? AND requested_by_id = ? AND status = 'requested'").get(by.kind, by.id)?.n);
    if (mine >= MAX_OPEN_PER_AGENT) fail("too_many_requests", `you have ${MAX_OPEN_PER_AGENT} review requests open; wait for the owner to decide`, 429);
    return { id: insertRequest(db, subject, { kind: by.kind, id: by.id, why }, now), status: "requested", duplicate: false };
  });
}

/** `agentsChanged`: a new agent gets one review request when the policy says so (system request, no duplicate). */
export function requestForNewAgents(db: Db, created: readonly { id: string; name: string }[], now = Date.now()): number {
  if (created.length === 0 || !reviewPolicy(db).reviewNewAgents) return 0;
  return db.transaction(() => {
    let n = 0;
    for (const a of created) {
      const s = subjectOf(db, "agent", a.id);
      if (!s || s.status === "removed" || openFor(db, "agent", a.id)) continue;
      insertRequest(db, s, { kind: "system", id: null, why: "New agent in this workspace." }, now);
      n++;
    }
    return n;
  });
}

// ── person ops ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RecordInput {
  subject: { kind: SubjectKind; id: string };
  verdict: Verdict;
  reason: string;
  snapshotDigest: string;
  nextReviewDays?: number;
  request?: string;
}

/**
 * The owner records a verdict. Refuses `snapshot_stale` (409) when the subject changed since the owner looked
 * (the digest no longer matches). Writes the verdict row, sets the trust, closes every open request of the subject.
 */
export function recordReview(db: Db, reviewer: string, input: RecordInput, now = Date.now()): Review {
  return db.transaction(() => {
    const s = subjectOf(db, input.subject.kind, input.subject.id) ?? fail("subject_not_found", "no such entry in the directory", 404);
    const reason = input.reason.trim();
    if (!reason) fail("input_invalid", "give a reason; it is kept with the record", 400);
    const snap = snapshotOf(db, s, now);
    if (snap.digest !== input.snapshotDigest) fail("snapshot_stale", "the subject changed since you looked; open the review again", 409);
    let by: Review["requestedBy"] = { kind: "owner", id: reviewer, why: "" };
    if (input.request !== undefined) {
      const q = getRow(db, input.request);
      if (q === undefined || q.status !== "requested" || q.subject_kind !== s.kind || q.subject_id !== s.id) return fail("request_not_found", "no open request for this subject with this id", 404);
      by = { kind: q.requested_by_kind as Review["requestedBy"]["kind"], id: q.requested_by_id === null ? null : String(q.requested_by_id), why: String(q.requested_why) };
    }
    const policy = reviewPolicy(db);
    const days = input.nextReviewDays ?? (s.kind === "agent" ? policy.agentDays : policy.contactDays);
    if (!Number.isInteger(days) || days < 7 || days > 730) fail("input_invalid", "the next review must be 7 to 730 days away", 400);
    const id = `rvw_${ulid(now)}`;
    db.prepare(
      `INSERT INTO fleet_reviews (id, subject_kind, subject_id, subject_name, status, verdict, reason, requested_by_kind, requested_by_id, requested_why, reviewer, snapshot_json, snapshot_digest, created_at, decided_at, next_due_at)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, s.kind, s.id, s.name, input.verdict, reason, by.kind, by.id, by.why, reviewer, JSON.stringify(snap), snap.digest, now, now, now + days * DAY_MS);
    if (s.kind === "agent") db.prepare("UPDATE fleet_agents SET trust = ?, updated_at = ? WHERE id = ?").run(input.verdict, now, s.id);
    else db.prepare("UPDATE fleet_people SET trust = ?, updated_at = ? WHERE id = ?").run(input.verdict, now, s.id);
    db.prepare("UPDATE fleet_reviews SET status = 'done', verdict = ?, reviewer = ?, decided_at = ?, answered_by = ? WHERE subject_kind = ? AND subject_id = ? AND status = 'requested'").run(
      input.verdict,
      reviewer,
      now,
      id,
      s.kind,
      s.id,
    );
    bump(db);
    return toReview(getRow(db, id) as Row);
  });
}

/** Closes an open request without a verdict (a duplicate, spam). A closed review cannot be dismissed again (409). */
export function dismissReview(db: Db, reviewer: string, id: string, why: string | undefined, now = Date.now()): Review {
  return db.transaction(() => {
    const r = getRow(db, id) ?? fail("review_not_found", "no review with this id", 404);
    if (r.status !== "requested") fail("review_not_open", "this review is already closed", 409);
    db.prepare("UPDATE fleet_reviews SET status = 'dismissed', reason = ?, reviewer = ?, decided_at = ? WHERE id = ?").run((why ?? "").trim().slice(0, 500), reviewer, now, id);
    return toReview(getRow(db, id) as Row);
  });
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Subjects due now: last verdict past its date, or never reviewed and older than the schedule (an `unreviewed` subject is due at once). Open requests are not repeated here. */
export function dueSubjects(db: Db, now = Date.now(), limit = MAX_LIST): { items: DueItem[]; count: number } {
  const policy = reviewPolicy(db);
  const items: DueItem[] = [];
  const last = db.prepare("SELECT id, verdict, next_due_at FROM fleet_reviews WHERE subject_kind = ? AND subject_id = ? AND status = 'done' AND answered_by IS NULL ORDER BY id DESC LIMIT 1");
  const consider = (kind: SubjectKind, id: string, name: string, trust: string, createdAt: number, days: number) => {
    if (openFor(db, kind, id)) return;
    const l = last.get(kind, id);
    const due = l ? Number(l.next_due_at) : trust === "unreviewed" ? createdAt : createdAt + days * DAY_MS;
    if (due > now) return;
    items.push({ subject: { kind, id, name }, dueAt: iso(due), lastReview: l ? String(l.id) : null, lastVerdict: l ? (l.verdict as Trust) : null, snapshot: null as unknown as Snapshot });
  };
  for (const a of db.prepare("SELECT id, name, trust, first_seen FROM fleet_agents WHERE status <> 'removed'").all()) consider("agent", String(a.id), String(a.name), String(a.trust), Number(a.first_seen), policy.agentDays);
  for (const p of db.prepare("SELECT id, name, kind, trust, created_at FROM fleet_people WHERE status = 'active'").all()) consider(p.kind as SubjectKind, String(p.id), String(p.name), String(p.trust), Number(p.created_at), policy.contactDays);
  items.sort((x, y) => x.dueAt.localeCompare(y.dueAt) || x.subject.id.localeCompare(y.subject.id));
  const shown = items.slice(0, limit);
  for (const it of shown) it.snapshot = snapshotOf(db, subjectOf(db, it.subject.kind, it.subject.id) as Subject, now);
  return { items: shown, count: items.length };
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
 * Given a `subject` instead of an id, `review` is the subject's latest verdict row (null if it was never reviewed) and
 * `current` its snapshot now: the owner's first step for a review nobody asked for.
 */
export function getReview(db: Db, q: { id?: string; subject?: { kind: SubjectKind; id: string } }, now = Date.now()): { review: Review | null; current: Snapshot | null } {
  if (q.id !== undefined) {
    const r = getRow(db, q.id) ?? fail("review_not_found", "no review with this id", 404);
    const s = subjectOf(db, r.subject_kind as SubjectKind, String(r.subject_id));
    return { review: toReview(r), current: s ? snapshotOf(db, s, now) : null };
  }
  if (!q.subject) return fail("input_invalid", "give the id of a review or a subject", 400);
  const s = subjectOf(db, q.subject.kind, q.subject.id) ?? fail("subject_not_found", "no such entry in the directory", 404);
  const last = db.prepare("SELECT * FROM fleet_reviews WHERE subject_kind = ? AND subject_id = ? AND status = 'done' AND answered_by IS NULL ORDER BY id DESC LIMIT 1").get(s.kind, s.id);
  return { review: last ? toReview(last) : null, current: snapshotOf(db, s, now) };
}
