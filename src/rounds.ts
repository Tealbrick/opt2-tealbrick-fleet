// Review rounds (C380 T2-b, DESIGN-C380 §7). A round asks the owner for one review of each person and agent in a list, and counts the answers.
// The review is the existing one (src/reviews.ts): a round adds no second way to set trust. The link table `fleet_campaign_items` holds the round
// id, because a closed review row cannot be updated (migration 0003). A verdict may also ask to remove access an app reports. That goes through the
// plan path (src/plans/plan.ts, the runner), which is the only apply path: a round never calls an app and never calls Core. The owner's confirm in
// the verdict is the approval for what an app can end by itself. A verdict plan has no Core step: an entry that is stopped, or whose owner is leaving, has its own stop
// plan on its page, and a round refuses to make a second one.
import { createHash } from "node:crypto";
import { canonicalize, ulid } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type AccessTarget, TARGET_NAMES } from "./access/items.ts";
import { appendEvent } from "./lifecycle/events.ts";
import { fail } from "./meta.ts";
import { checkPlan, createPlan, OPEN_SQL, openPlansOf } from "./plans/plan.ts";
import { planView } from "./plans/view.ts";
import { dismissReview, ownerRequest, recordReview, snapshotOf, subjectOf } from "./reviews.ts";
import { cleanText } from "./text.ts";

export const ROUND_MAX_ITEMS = 200;
/** Open plans a round may have at one time. Core takes at most 10 open requests per app; the same number keeps a batch of verdicts from filling it. */
export const ROUND_OPEN_PLANS = 10;
export const MAX_TICKS = 50;
const DAY_MS = 86_400_000;
const WHY = "Review round.";
/** Rows of access an entry shows in a round. Past it the entry says how many are not shown, and none of those can be ticked. */
export const ACCESS_SHOWN = 200;

export type Ref = { kind: "agent" | "person"; id: string };
export type Tick = { product: AccessTarget; id: string; digest: string };
type Row = Record<string, unknown>;
const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const n = (v: unknown): number => Number(v ?? 0);

// ── who is in a round ───────────────────────────────────────────────────────────────────────────────────────────

/** New and active agents, and active people. A stopped or closed entry is not asked about: its access shows as a difference instead. */
function pick(db: Db, scope: string, chosen: readonly Ref[] | undefined): Ref[] {
  const agents = () => db.prepare("SELECT id FROM fleet_agents WHERE status <> 'removed' AND lifecycle IN ('proposed', 'active') ORDER BY name COLLATE NOCASE, id").all().map((r) => ({ kind: "agent" as const, id: String(r.id) }));
  const people = () => db.prepare("SELECT id FROM fleet_people WHERE kind = 'person' AND lifecycle = 'active' ORDER BY name COLLATE NOCASE, id").all().map((r) => ({ kind: "person" as const, id: String(r.id) }));
  if (scope === "agents") return agents();
  if (scope === "people") return people();
  if (scope === "everyone") return [...agents(), ...people()];
  if (scope === "chosen") {
    const seen = new Set<string>();
    return (chosen ?? []).filter((r) => {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return fail("input_invalid", "Choose agents, people, everyone or a list.", 400);
}

export interface CreateInput {
  title: string;
  scope: "agents" | "people" | "everyone" | "chosen";
  subjects?: readonly Ref[] | undefined;
  dueDays?: number | undefined;
}

export function createRound(db: Db, owner: string, input: CreateInput, now = Date.now()): { id: string; added: number; skipped: number } {
  const title = Array.from(cleanText(input.title)).slice(0, 120).join("").trim();
  if (title === "") fail("title_required", "Give the round a name.", 400);
  if (input.scope === "chosen" && !input.subjects?.length) fail("input_invalid", "Choose who is in the round.", 400);
  const subjects = pick(db, input.scope, input.subjects);
  return db.transaction(() => {
    const id = `rnd_${ulid(now)}`;
    db.prepare("INSERT INTO fleet_rounds (id, title, scope, created_by, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, title, input.scope, owner, now, input.dueDays === undefined ? null : now + input.dueDays * DAY_MS);
    const inOpenRound = db.prepare("SELECT 1 FROM fleet_campaign_items c JOIN fleet_rounds o ON o.id = c.round_id WHERE c.subject_kind = ? AND c.subject_id = ? AND o.closed_at IS NULL");
    const link = db.prepare("INSERT INTO fleet_campaign_items (round_id, review_id, subject_kind, subject_id, subject_name, added_at) VALUES (?, ?, ?, ?, ?, ?)");
    let added = 0;
    let skipped = 0;
    for (const s of subjects) {
      // One open round per entry: its request would be counted twice otherwise.
      const taken = inOpenRound.get(s.kind, s.id) !== undefined;
      if (!taken && added >= ROUND_MAX_ITEMS) fail("round_too_big", `A round holds at most ${ROUND_MAX_ITEMS} entries. Choose fewer.`, 409);
      const req = taken ? null : ownerRequest(db, owner, s.kind, s.id, WHY, now);
      if (!req) {
        skipped++;
        continue;
      }
      link.run(id, req.id, s.kind, s.id, req.name, now);
      added++;
    }
    if (added === 0) fail("nothing_to_review", "Nobody can be added: the list is empty, or each entry is in an open round.", 409);
    appendEvent(db, { subject: { kind: "workspace", id: "", name: "Governance" }, kind: "changed", actor: { kind: "owner", id: owner }, note: `Review round started: ${id}. ${added} entries.`, at: now });
    return { id, added, skipped };
  });
}

// ── what the owner sees ─────────────────────────────────────────────────────────────────────────────────────────

export interface Counts {
  total: number;
  open: number;
  trusted: number;
  limited: number;
  blocked: number;
  dismissed: number;
  removalQueued: number;
  removalPlanned: number;
}

/** Counts by round id: the rows of the link table read through the review each one points at. */
export function countsOf(db: Db, round: string): Counts {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(r.status = 'requested') AS open,
              SUM(r.status = 'done' AND r.verdict = 'trusted') AS trusted,
              SUM(r.status = 'done' AND r.verdict = 'limited') AS limited,
              SUM(r.status = 'done' AND r.verdict = 'blocked') AS blocked,
              SUM(r.status = 'dismissed') AS dismissed,
              SUM(c.removal = 'queued') AS queued,
              SUM(c.removal = 'planned') AS planned
       FROM fleet_campaign_items c JOIN fleet_reviews r ON r.id = c.review_id WHERE c.round_id = ?`,
    )
    .get(round);
  return { total: n(r?.total), open: n(r?.open), trusted: n(r?.trusted), limited: n(r?.limited), blocked: n(r?.blocked), dismissed: n(r?.dismissed), removalQueued: n(r?.queued), removalPlanned: n(r?.planned) };
}

export function summaryOf(db: Db, r: Row, now: number) {
  const closed = r.closed_at !== null;
  return {
    id: String(r.id),
    title: String(r.title),
    scope: String(r.scope),
    createdAt: iso(r.created_at) as string,
    dueAt: iso(r.due_at),
    closedAt: iso(r.closed_at),
    state: closed ? ("closed" as const) : ("open" as const),
    overdue: !closed && r.due_at !== null && Number(r.due_at) < now,
    counts: countsOf(db, String(r.id)),
  };
}

export const roundRow = (db: Db, id: string): Row | undefined => db.prepare("SELECT * FROM fleet_rounds WHERE id = ?").get(id);

export function listRounds(db: Db, now: number, limit = 50) {
  return db.prepare("SELECT * FROM fleet_rounds ORDER BY created_at DESC, id DESC LIMIT ?").all(limit).map((r) => summaryOf(db, r, now));
}

export interface AccessRow {
  product: string;
  productName: string;
  id: string;
  kind: string;
  label: string;
  level: string;
  /** held_by: the entry holds it. about: others can reach the entry's things. */
  direction: string;
  state: string;
  revocable: boolean;
  digest: string;
}

/** What the stores report this entry holds now, from the shadow copy. A clean list proves only that the app reports nothing. */
export function accessOf(db: Db, kind: string, id: string): AccessRow[] {
  return db
    .prepare("SELECT target, item_id, kind, label, level, direction, state, revocable, digest FROM fleet_access_items WHERE subject_kind = ? AND subject_id = ? ORDER BY target, item_id")
    .all(kind, id)
    .map((r) => ({ product: String(r.target), productName: TARGET_NAMES[r.target as AccessTarget] ?? String(r.target), id: String(r.item_id), kind: String(r.kind), label: String(r.label), level: String(r.level), direction: String(r.direction), state: String(r.state), revocable: Number(r.revocable) === 1, digest: String(r.digest) }));
}

/** The picture the owner decides on: the identities of what is held. A change of state alone does not move it (the item digest leaves state out). */
export const accessDigestOf = (rows: readonly AccessRow[]): string => `sha256:${createHash("sha256").update(canonicalize(rows.map((r) => [r.product, r.id, r.digest]) as unknown as Json)).digest("hex")}`;

const STATUS: Record<string, "open" | "trusted" | "limited" | "blocked" | "dismissed"> = { requested: "open", dismissed: "dismissed" };

function itemOf(db: Db, c: Row, r: Row, now: number) {
  const rows = accessOf(db, String(c.subject_kind), String(c.subject_id));
  const open = r.status === "requested";
  const s = open ? subjectOf(db, c.subject_kind as "agent" | "person", String(c.subject_id)) : null;
  const plan = c.plan_id === null ? null : db.prepare("SELECT state FROM fleet_plans WHERE id = ?").get(String(c.plan_id));
  // what the plan says: only a proved step is a removal; the owner reads the plan's own words
  const seen = plan ? planView(db, String(c.plan_id)) : null;
  const wanted = c.wanted_json === null ? [] : (JSON.parse(String(c.wanted_json)) as unknown[]);
  return {
    review: String(c.review_id),
    subject: { kind: String(c.subject_kind), id: String(c.subject_id), name: String(c.subject_name) },
    status: STATUS[String(r.status)] ?? (String(r.verdict) as "trusted" | "limited" | "blocked"),
    reason: r.reason === "" || r.reason === null ? null : String(r.reason),
    decidedAt: iso(r.decided_at),
    snapshotDigest: s ? snapshotOf(db, s, now).digest : null,
    accessDigest: accessDigestOf(rows),
    decidedIn: open || r.status === "dismissed" ? null : c.seen_digest === null ? ("elsewhere" as const) : ("round" as const),
    access: rows.slice(0, ACCESS_SHOWN),
    accessCount: rows.length,
    removal: c.removal === null ? null : { state: String(c.removal), note: c.removal_note === null ? null : String(c.removal_note), plan: c.plan_id === null ? null : String(c.plan_id), planState: plan ? String(plan.state) : null, count: wanted.length, headline: seen ? seen.headline : null, proved: seen?.counts.proved ?? 0, manual: seen?.counts.manual ?? 0, open: seen?.counts.open ?? 0 },
  };
}

export function roundDetail(db: Db, id: string, now: number) {
  const round = roundRow(db, id) ?? fail("round_not_found", "No such round.", 404);
  const rows = db
    .prepare("SELECT c.*, r.status AS r_status, r.verdict AS r_verdict, r.reason AS r_reason, r.decided_at AS r_decided FROM fleet_campaign_items c JOIN fleet_reviews r ON r.id = c.review_id WHERE c.round_id = ? ORDER BY c.subject_name COLLATE NOCASE, c.subject_id")
    .all(id);
  const items = rows.map((c) => itemOf(db, c, { status: c.r_status, verdict: c.r_verdict, reason: c.r_reason, decided_at: c.r_decided }, now));
  return { ...summaryOf(db, round, now), items };
}

// ── a verdict, and the removal it may ask for ───────────────────────────────────────────────────────────────────

/** Open plans that a round made. Other plans do not take a place from a round. */
const openPlanCount = (db: Db): number => n(db.prepare(`SELECT COUNT(*) AS n FROM fleet_plans WHERE state IN (${OPEN_SQL}) AND group_id IN (SELECT plan_id FROM fleet_campaign_items WHERE plan_id IS NOT NULL)`).get()?.n);

/** A plan from the ticks, by the plan path. Queued instead when the round already has its open plans or the entry has one open. */
function schedule(db: Db, c: Row, ticks: readonly Tick[], owner: string, now: number): "planned" | "queued" {
  const kind = c.subject_kind as "agent" | "person";
  const id = String(c.subject_id);
  if (openPlanCount(db) >= ROUND_OPEN_PLANS || openPlansOf(db, kind, id).length > 0) {
    db.prepare("UPDATE fleet_campaign_items SET removal = 'queued', removal_note = ?, wanted_json = ? WHERE round_id = ? AND review_id = ?").run(
      openPlansOf(db, kind, id).length > 0 ? "Another plan for this entry is open. This waits for it." : "Waiting for a free place. Send it again when the open plans are done.",
      JSON.stringify(ticks),
      c.round_id,
      c.review_id,
    );
    return "queued";
  }
  const made = createPlan(db, { kind, id, items: ticks, actor: { kind: "owner", id: owner } }, now);
  db.prepare("UPDATE fleet_campaign_items SET removal = 'planned', removal_note = NULL, wanted_json = ?, plan_id = ? WHERE round_id = ? AND review_id = ?").run(JSON.stringify(ticks), made.ids[0], c.round_id, c.review_id);
  return "planned";
}

export interface DecideInput {
  round: string;
  subject: Ref;
  verdict: "trusted" | "limited" | "blocked";
  reason: string;
  snapshotDigest: string;
  accessDigest: string;
  remove?: readonly Tick[] | undefined;
}

/**
 * One verdict in a round, in one transaction: the review (the existing record, with its stale check), the removal ticks (checked against the rows the
 * owner saw), and the plan or its place in the queue. A guard that refuses leaves nothing behind. Nothing here calls an app or Core.
 */
export function decide(db: Db, reviewer: string, input: DecideInput, now = Date.now()): { item: ReturnType<typeof itemOf>; plan: string | null } {
  return db.transaction(() => {
    const round = roundRow(db, input.round) ?? fail("round_not_found", "No such round.", 404);
    if (round.closed_at !== null) fail("round_closed", "This round is closed.", 409);
    const c = db.prepare("SELECT * FROM fleet_campaign_items WHERE round_id = ? AND subject_kind = ? AND subject_id = ?").get(input.round, input.subject.kind, input.subject.id) ?? fail("not_in_round", "This entry is not in this round.", 404);
    const rev = db.prepare("SELECT status FROM fleet_reviews WHERE id = ?").get(String(c.review_id));
    if (rev?.status !== "requested") fail("already_decided", "This entry was decided already.", 409);
    const rows = accessOf(db, input.subject.kind, input.subject.id);
    if (accessDigestOf(rows) !== input.accessDigest) fail("access_stale", "The access of this entry changed since you looked. Open the round again.", 409);
    const ticks = input.remove ?? [];
    if (ticks.length > MAX_TICKS) fail("input_invalid", `Remove at most ${MAX_TICKS} at once.`, 400);
    const seen = new Set<string>();
    const shown = rows.slice(0, ACCESS_SHOWN);
    for (const t of ticks) {
      const key = `${t.product}:${t.id}`;
      const row = shown.find((r) => r.product === t.product && r.id === t.id);
      if (seen.has(key) || row?.digest !== t.digest) fail("access_stale", "The access of this entry changed since you looked. Open the round again.", 409);
      if (!row?.revocable) fail("not_removable", "This app cannot end this access from here.", 409);
      seen.add(key);
    }
    // The plan guards run first, so a refused plan does not leave a verdict without its removal.
    if (ticks.length > 0 && checkPlan(db, { kind: input.subject.kind, id: input.subject.id, items: ticks, actor: { kind: "owner", id: reviewer } }).steps.length > 0) fail("plan_needs_portal", "This entry is stopped, or its owner is leaving. Make its stop plan on its own page. A review does not ask Portal for anything.", 409);
    recordReview(db, reviewer, { subject: { kind: input.subject.kind, id: input.subject.id }, verdict: input.verdict, reason: input.reason, snapshotDigest: input.snapshotDigest, request: String(c.review_id) }, now);
    db.prepare("UPDATE fleet_campaign_items SET seen_count = ?, seen_digest = ? WHERE round_id = ? AND review_id = ?").run(rows.length, input.accessDigest, input.round, String(c.review_id));
    const placed = ticks.length > 0 ? schedule(db, c, ticks, reviewer, now) : null;
    appendEvent(db, {
      subject: { kind: input.subject.kind, id: input.subject.id, name: String(c.subject_name) },
      kind: "changed",
      actor: { kind: "owner", id: reviewer },
      note: `Review round ${input.round}: ${input.verdict}.${placed === null ? "" : placed === "planned" ? ` ${ticks.length} access rows to remove, plan made.` : ` ${ticks.length} access rows to remove, waiting for a free place.`}`,
      at: now,
    });
    const fresh = db.prepare("SELECT * FROM fleet_campaign_items WHERE round_id = ? AND review_id = ?").get(input.round, String(c.review_id)) as Row;
    const after = db.prepare("SELECT status, verdict, reason, decided_at FROM fleet_reviews WHERE id = ?").get(String(c.review_id)) as Row;
    return { item: itemOf(db, fresh, after, now), plan: fresh.plan_id === null ? null : String(fresh.plan_id) };
  });
}

/** Makes the plans of queued removals, in the order the entries were added, while places are free. A plan that cannot be made any more is dropped with its reason. */
export function sendQueued(db: Db, owner: string, roundId: string, now = Date.now()): { planned: number; queued: number } {
  return db.transaction(() => {
    const round = roundRow(db, roundId) ?? fail("round_not_found", "No such round.", 404);
    if (round.closed_at !== null) fail("round_closed", "This round is closed.", 409);
    let planned = 0;
    for (const c of db.prepare("SELECT * FROM fleet_campaign_items WHERE round_id = ? AND removal = 'queued' ORDER BY added_at, review_id").all(roundId)) {
      if (openPlanCount(db) >= ROUND_OPEN_PLANS) break;
      const kind = c.subject_kind as "agent" | "person";
      if (openPlansOf(db, kind, String(c.subject_id)).length > 0) continue;
      const ticks = JSON.parse(String(c.wanted_json ?? "[]")) as Tick[];
      try {
        // The entry may have been stopped since the verdict: a plan with a Portal step is not a round's to make.
        if (checkPlan(db, { kind, id: String(c.subject_id), items: ticks, actor: { kind: "owner", id: owner } }).steps.length > 0) throw new TbError("plan_needs_portal", "needs its own stop plan", 409);
        const made = createPlan(db, { kind, id: String(c.subject_id), items: ticks, actor: { kind: "owner", id: owner } }, now);
        db.prepare("UPDATE fleet_campaign_items SET removal = 'planned', removal_note = NULL, plan_id = ? WHERE round_id = ? AND review_id = ?").run(made.ids[0], roundId, String(c.review_id));
        planned++;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== "nothing_to_stop" && code !== "subject_closed" && code !== "agent_not_found" && code !== "person_not_found" && code !== "plan_needs_portal") throw e;
        db.prepare("UPDATE fleet_campaign_items SET removal = 'dropped', removal_note = ? WHERE round_id = ? AND review_id = ?").run("This entry can no longer be changed here. Nothing was removed.", roundId, String(c.review_id));
      }
    }
    return { planned, queued: n(db.prepare("SELECT COUNT(*) AS n FROM fleet_campaign_items WHERE round_id = ? AND removal = 'queued'").get(roundId)?.n) };
  });
}

/** Ends a round. Entries nobody decided are dismissed with a plain reason, and queued removals are dropped: nothing waits in the dark. */
export function closeRound(db: Db, owner: string, roundId: string, now = Date.now()): void {
  db.transaction(() => {
    const round = roundRow(db, roundId) ?? fail("round_not_found", "No such round.", 404);
    if (round.closed_at !== null) fail("round_closed", "This round is closed.", 409);
    for (const c of db.prepare("SELECT c.review_id FROM fleet_campaign_items c JOIN fleet_reviews r ON r.id = c.review_id WHERE c.round_id = ? AND r.status = 'requested'").all(roundId)) dismissReview(db, owner, String(c.review_id), "Review round closed.", now);
    db.prepare("UPDATE fleet_campaign_items SET removal = 'dropped', removal_note = 'The round was closed before this was sent. Nothing was removed.' WHERE round_id = ? AND removal = 'queued'").run(roundId);
    db.prepare("UPDATE fleet_rounds SET closed_at = ?, closed_by = ? WHERE id = ?").run(now, owner, roundId);
    appendEvent(db, { subject: { kind: "workspace", id: "", name: "Governance" }, kind: "changed", actor: { kind: "owner", id: owner }, note: `Review round closed: ${roundId}.`, at: now });
  });
}
