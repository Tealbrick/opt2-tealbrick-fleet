// Access > Differences (C380, DESIGN-C380 §4): what no longer matches, computed on read, no table, so nothing goes out of sync. The owner
// may accept one with a reason until a date. A finding never changes anything by itself, and an acceptance changes no access.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { ExceptionSetInput, ExceptionSetOutput, FindingsListOutput } from "#kit";
import { type Finding, stampOf } from "../findings.ts";
import { appendEvent } from "../lifecycle/events.ts";
import type { SubjectKind } from "../lifecycle/states.ts";
import { fail } from "../meta.ts";
import { cleanText } from "../text.ts";
import { readStates } from "./client.ts";
import { type AccessTarget, TARGET_NAMES, unlinkedCount } from "./items.ts";
import { lastSweepAt } from "./sweep.ts";

export const ACCESS_AFTER_LEAVE: Finding = { code: "access_after_leave", text: "Still has access after leaving." };
const ORPHAN: Finding = { code: "orphan", text: "An app lists access for an agent that is gone, or for someone Governance does not know." };
const EXCEPTION_MAX_MS = 366 * 86_400_000;
const FINDINGS_MAX = 2000;
/** Findings where the time of the last lifecycle change says since when. */
const SINCE_THE_CHANGE: ReadonlySet<string> = new Set(["not_stopped", "access_after_leave", "suspended_too_long", "leaving_no_plan"]);

const nameOf = (target: string): string => TARGET_NAMES[target as AccessTarget] ?? target;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Stores that still report something a leaving or closed subject holds, by subject. An item for information, one that only says others
 * can read the subject's things, and a dormant one are not access held. A paused one is: it comes back at a resume, until it is revoked.
 * C383 QA S3-5: an agent's own memory area and Buzz name are not access held once Portal no longer lists it, or Core removed its access since this stop: nobody can act as it. What can run without it, as a scheduled post, still counts.
 * C383 review (row 5): the same for its owner's personal memory: Knowledge lists what the directory says the agent would reach, and only a call with a key reads it. A key or app access Portal shows again (`back`), or an agent that runs again, which needs no picture to see, ends all of this.
 */
export function accessAfterLeave(db: Db, back: ReadonlySet<string> = new Set()): Map<string, { stores: string[]; newest: number }> {
  const out = new Map<string, { stores: string[]; newest: number }>();
  const rows = db
    .prepare(
      `SELECT i.subject_kind AS kind, i.subject_id AS id, i.target, MAX(i.first_seen) AS newest FROM fleet_access_items i
       LEFT JOIN fleet_agents a ON i.subject_kind = 'agent' AND a.id = i.subject_id
       LEFT JOIN fleet_people p ON i.subject_kind = 'person' AND p.id = i.subject_id
       WHERE i.level <> 'info' AND i.direction = 'held_by' AND i.state <> 'dormant' AND COALESCE(a.lifecycle, p.lifecycle) IN ('leaving', 'archived')
         AND NOT (i.kind IN ('buzz_identity', 'agent_area', 'person_area') AND (a.status IS 'removed' OR (a.status <> 'active' AND a.id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM fleet_plan_steps s WHERE s.agent_id = a.id AND s.phase = 'core' AND s.op = 'agents.offboard' AND s.state IN ('done', 'reported')
           AND s.updated_at >= COALESCE((SELECT MAX(e.at) FROM fleet_lifecycle_events e WHERE e.subject_kind = 'agent' AND e.subject_id = a.id AND e.kind = 'transition' AND e.to_state = 'leaving'), a.lifecycle_at)))))
       GROUP BY i.subject_kind, i.subject_id, i.target ORDER BY i.target`,
    )
    .all(JSON.stringify([...back]));
  for (const r of rows) {
    const key = `${String(r.kind)}:${String(r.id)}`;
    const seen = out.get(key);
    out.set(key, { stores: [...(seen?.stores ?? []), nameOf(String(r.target))], newest: Math.max(seen?.newest ?? 0, Number(r.newest)) });
  }
  return out;
}

/** Rows that name nobody Governance has, or a card that is gone and not on its way out, by store. */
function orphansByStore(db: Db): string[] {
  return db
    .prepare(
      `SELECT DISTINCT i.target FROM fleet_access_items i
       LEFT JOIN fleet_agents a ON i.subject_kind = 'agent' AND a.id = i.subject_id
       LEFT JOIN fleet_people p ON i.subject_kind = 'person' AND p.id = i.subject_id
       WHERE i.subject_kind <> 'unlinked' AND (
         (i.subject_kind = 'agent' AND (a.id IS NULL OR (a.status = 'removed' AND a.lifecycle NOT IN ('leaving', 'archived'))))
         OR (i.subject_kind = 'person' AND p.id IS NULL))
       ORDER BY i.target`,
    )
    .all()
    .map((r) => String(r.target));
}

interface Accepted {
  reason: string;
  until: string;
  at: number;
}

const accepted = (db: Db, now: number): Map<string, Accepted> =>
  new Map(
    db
      .prepare("SELECT code, subject_kind, subject_id, reason, until, at FROM fleet_exceptions WHERE until > ?")
      .all(now)
      .map((r) => [`${String(r.code)}:${String(r.subject_kind)}:${String(r.subject_id)}`, { reason: String(r.reason), until: iso(Number(r.until)), at: Number(r.at) }] as const),
  );

/**
 * An acceptance covers what the owner saw. A new lifecycle change after it, or a store that lists a new item after it, is news: the
 * difference shows again, not under an old "Accepted".
 */
function acceptanceOf(ok: ReadonlyMap<string, Accepted>, leave: ReturnType<typeof accessAfterLeave>, finding: Finding, s: Pick<FindingSubject, "kind" | "id" | "at">): Accepted | null {
  const a = ok.get(`${finding.code}:${s.kind}:${s.id}`);
  if (!a) return null;
  if (s.at !== null && Date.parse(s.at) > a.at) return null;
  if (finding.code === ACCESS_AFTER_LEAVE.code && (leave.get(`${s.kind}:${s.id}`)?.newest ?? 0) > a.at) return null;
  // a finding that knows since when it holds (a broken "Cannot hold both" rule): a clash newer than the acceptance is news
  if ((stampOf(finding) ?? 0) > a.at) return null;
  return a;
}

export interface FindingSubject {
  kind: SubjectKind;
  id: string;
  name: string;
  at: string | null;
  findings: readonly Finding[];
}

/** What could not be read and why. Portal's own list counts: no consent or a cut list is a stated limit too. */
export function unreadOf(db: Db, portal: { read: true } | { read: false; text: string }): FindingsListOutput["unread"] {
  const out = readStates(db)
    .filter((s) => s.state === "not_read" || s.state === "refused" || s.state === "waiting")
    .map((s) => ({ product: s.target, name: nameOf(s.target), text: s.text ?? "This app could not be read." }));
  return portal.read ? out : [{ product: "core", name: "Portal", text: portal.text }, ...out];
}

const shown = (a: Accepted | null): { reason: string; until: string } | null => (a ? { reason: a.reason, until: a.until } : null);

export function findingsList(db: Db, subjects: readonly FindingSubject[], portal: Parameters<typeof unreadOf>[1], now: number, back: ReadonlySet<string> = new Set()): FindingsListOutput {
  const leave = accessAfterLeave(db, back);
  const ok = accepted(db, now);
  const items: FindingsListOutput["items"] = [];
  for (const s of subjects) {
    for (const f of s.findings) {
      items.push({
        code: f.code,
        text: f.text,
        subject: { kind: s.kind, id: s.id, name: s.name },
        productName: f.code === ACCESS_AFTER_LEAVE.code ? (leave.get(`${s.kind}:${s.id}`)?.stores.join(", ") ?? null) : null,
        since: SINCE_THE_CHANGE.has(f.code) ? s.at : null,
        exception: shown(acceptanceOf(ok, leave, f, s)),
      });
    }
  }
  const unlinked = unlinkedCount(db);
  if (unlinked > 0) items.push({ code: "unlinked_account", text: unlinked === 1 ? "1 account has no person. Check it in Connect." : `${unlinked} accounts have no person. Check them in Connect.`, subject: null, productName: TARGET_NAMES.connect, since: null, exception: null });
  for (const target of orphansByStore(db)) items.push({ code: ORPHAN.code, text: ORPHAN.text, subject: null, productName: nameOf(target), since: null, exception: null });
  // "Name an owner" first (§4). The sort is stable, so the rest keep their order.
  items.sort((a, b) => Number(b.code === "no_owner") - Number(a.code === "no_owner"));
  const last = lastSweepAt(db);
  return { lastSweepAt: last === null ? null : iso(last), storesRead: readStates(db).filter((s) => s.state === "read").length, unread: unreadOf(db, portal), items: items.slice(0, FINDINGS_MAX) };
}

/** Differences an owner has not accepted, for the Summary. */
export function openDifferences(db: Db, subjects: readonly Pick<FindingSubject, "kind" | "id" | "at" | "findings">[], now: number, back: ReadonlySet<string> = new Set()): number {
  const ok = accepted(db, now);
  const leave = accessAfterLeave(db, back);
  const own = subjects.reduce((n, s) => n + s.findings.filter((f) => !acceptanceOf(ok, leave, f, s)).length, 0);
  return own + (unlinkedCount(db) > 0 ? 1 : 0) + orphansByStore(db).length;
}

export function setException(db: Db, input: ExceptionSetInput, subject: FindingSubject | null, actor: string, now: number): ExceptionSetOutput {
  if (!subject) return fail(input.kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
  const reason = Array.from(cleanText(input.reason)).slice(0, 200).join("");
  if (reason === "") return fail("reason_required", "Say why this is acceptable.", 400);
  const until = Date.parse(input.until);
  if (!Number.isFinite(until) || until <= now) return fail("until_invalid", "Choose a date in the future.", 400);
  if (until > now + EXCEPTION_MAX_MS) return fail("until_invalid", "Choose a date within one year.", 400);
  const finding = subject.findings.find((f) => f.code === input.code);
  if (!finding) return fail("finding_gone", "This difference is no longer there. Open the list again.", 409);
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO fleet_exceptions (code, subject_kind, subject_id, reason, until, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (code, subject_kind, subject_id) DO UPDATE SET reason = excluded.reason, until = excluded.until, by_id = excluded.by_id, at = excluded.at`,
    ).run(input.code, input.kind, input.id, reason, until, actor, now);
    appendEvent(db, { subject: { kind: input.kind, id: input.id, name: subject.name }, kind: "changed", actor: { kind: "owner", id: actor }, note: `Accepted until ${iso(until).slice(0, 10)}: ${finding.text} Why: ${reason}`.slice(0, 500), at: now });
    return { exception: { code: input.code, reason, until: iso(until) } };
  });
}
