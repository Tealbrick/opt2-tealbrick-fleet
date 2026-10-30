// The reader side of tb.access/1 (spec 0.1.89, docs/ACCESS.md): one page of `access_list`, checked by hand, and the shadow copy
// `fleet_access_items`. An app can hide items in its own store and can claim things; it cannot report for another target, because the
// target stored is the product Governance called and the digest is computed again with that product. The copy is never authority.
import { digest, normalizeHandle } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { AGENT_ID_PATTERN, HANDLE_PATTERN } from "../feed.ts";
import { cleanText } from "../text.ts";

export const ACCESS_TARGETS = ["connect", "knowledge", "kanban", "evolution"] as const;
export type AccessTarget = (typeof ACCESS_TARGETS)[number];
export const TARGET_NAMES: Readonly<Record<AccessTarget, string>> = { connect: "Connect", knowledge: "Knowledge", kanban: "Task Board", evolution: "Evolving Workflows" };

/** The closed list per target (ACCESS_KINDS in the spec package). A kind from another target's list is a wrong answer. */
export const TARGET_KINDS: Readonly<Record<AccessTarget, readonly string[]>> = {
  connect: ["account_as_itself", "account_as_me", "buzz_identity", "scheduled_post", "first_contacts", "channel_sender"],
  knowledge: ["agent_area", "person_area", "team_grant"],
  kanban: ["assignment", "own_project"],
  evolution: ["routine", "workflow_agent_step", "schedule_of_workflow"],
};

export const LIST_LIMITS = { subjects: 32, handles: 16, limit: 200, labelChars: 120, reasonChars: 200, notShown: 32 } as const;

export type ItemSubject = { kind: "agent" | "person"; id: string } | { kind: "unlinked" };
export type ListSubject = { kind: "agent"; id: string } | { kind: "person"; id: string; handles: string[] } | { kind: "unlinked" } | { kind: "all" };
export interface ListIn {
  v: 1;
  subjects: ListSubject[];
  cursor?: string;
  limit?: number;
  sweepId?: string;
}
export interface AccessItem {
  id: string;
  kind: string;
  subject: ItemSubject;
  resource: string;
  direction: "held_by" | "about";
  level: "read" | "write" | "use" | "info";
  label: string;
  state: "active" | "paused" | "scheduled" | "dormant";
  revocable: boolean;
  since: string | null;
  digest: string;
}
export interface NotShown {
  kind: string;
  reason: string;
}
export interface ListPage {
  asOf: string;
  items: AccessItem[];
  nextCursor: string | null;
  notShown: NotShown[];
}

/** One answer Governance cannot use. The whole page is refused: a bad row must not read as "this store reports less". */
export class BadAnswer extends Error {}

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const ITEM_ID = /^[a-z][a-z_]*:[!-~]+$/;
const DIRECTIONS = ["held_by", "about"];
const LEVELS = ["read", "write", "use", "info"];
const STATES = ["active", "paused", "scheduled", "dormant"];

const bad = (why: string): never => {
  throw new BadAnswer(why);
};
const chars = (s: string, max: number): string => Array.from(s).slice(0, max).join("");
const text = (v: unknown, max: number, why: string, min = 1): string => {
  if (typeof v !== "string" || v.length < min || Array.from(v).length > max) bad(why);
  return v as string;
};

/** A string from the list, or a bad answer. `String(x)` would let `["active"]` through and SQLite would refuse it later. */
const oneOf = (v: unknown, list: readonly string[], why: string): string => (typeof v === "string" && list.includes(v) ? v : bad(why));

function parseSubject(v: unknown): ItemSubject {
  const s = v as { kind?: unknown; id?: unknown } | null;
  if (s?.kind === "unlinked") return { kind: "unlinked" };
  if (s?.kind === "agent" && typeof s.id === "string" && AGENT_ID_PATTERN.test(s.id)) return { kind: "agent", id: s.id };
  if (s?.kind === "person" && typeof s.id === "string" && s.id.length >= 1 && s.id.length <= 64) return { kind: "person", id: s.id };
  return bad("subject");
}

/** `sha256:` + hex of the JCS of {v, target, id, kind, subject, resource, level}: state, since, label, revocable and direction are not in it. */
export const itemDigest = (target: string, i: Pick<AccessItem, "id" | "kind" | "subject" | "resource" | "level">): string => digest({ v: 1, target, id: i.id, kind: i.kind, subject: i.subject, resource: i.resource, level: i.level } as unknown as Json);

function parseItem(target: AccessTarget, v: unknown): AccessItem {
  const r = (v ?? {}) as Record<string, unknown>;
  const id = text(r.id, 128, "id", 3);
  if (!ITEM_ID.test(id)) bad("id");
  const kind = oneOf(r.kind, TARGET_KINDS[target], "kind");
  if (!id.startsWith(`${kind}:`)) bad("kind");
  const subject = parseSubject(r.subject);
  const resource = text(r.resource, 128, "resource");
  const direction = oneOf(r.direction, DIRECTIONS, "direction") as AccessItem["direction"];
  const level = oneOf(r.level, LEVELS, "level") as AccessItem["level"];
  const state = oneOf(r.state, STATES, "state") as AccessItem["state"];
  if (typeof r.revocable !== "boolean") bad("revocable");
  if (r.since !== undefined && (typeof r.since !== "string" || !ISO.test(r.since))) bad("since");
  if (r.digest !== itemDigest(target, { id, kind, subject, resource, level })) bad("digest");
  const label = chars(cleanText(text(r.label, LIST_LIMITS.labelChars, "label")), LIST_LIMITS.labelChars);
  return { id, kind, subject, resource, direction, level, label: label === "" ? "Unnamed" : label, state, revocable: r.revocable as boolean, since: (r.since as string | undefined) ?? null, digest: r.digest as string };
}

/** The checks of `access.list_out.1.schema.json`, by hand (a test runs the spec's fixtures through both), plus digest and kind per target. */
export function parsePage(target: AccessTarget, raw: unknown, sweepId?: string): ListPage {
  const r = raw as { v?: unknown; asOf?: unknown; sweepId?: unknown; items?: unknown; nextCursor?: unknown; notShown?: unknown; complete?: unknown } | null;
  if (r?.v !== 1 || typeof r.asOf !== "string" || !ISO.test(r.asOf) || !Number.isFinite(Date.parse(r.asOf))) return bad("head");
  if (!Array.isArray(r.items) || r.items.length > LIST_LIMITS.limit || !Array.isArray(r.notShown) || r.notShown.length > LIST_LIMITS.notShown) return bad("lists");
  if (sweepId !== undefined && r.sweepId !== undefined && r.sweepId !== sweepId) return bad("sweepId");
  const nextCursor = r.nextCursor === null ? null : text(r.nextCursor, 512, "cursor");
  const notShown = r.notShown.map((n: { kind?: unknown; reason?: unknown } | null) => ({ kind: chars(cleanText(text(n?.kind, 64, "notShown")), 64), reason: chars(cleanText(text(n?.reason, LIST_LIMITS.reasonChars, "notShown")), LIST_LIMITS.reasonChars) }));
  if (typeof r.complete !== "boolean" || r.complete !== (nextCursor === null && notShown.length === 0)) return bad("complete");
  return { asOf: r.asOf, items: r.items.map((i) => parseItem(target, i)), nextCursor, notShown };
}

/** "Items whose subject was not asked for are dropped." Under `all` every subject was asked for. */
export function onlyAsked(items: readonly AccessItem[], asked: readonly ListSubject[]): AccessItem[] {
  if (asked.some((s) => s.kind === "all")) return [...items];
  const ids = new Set(asked.flatMap((s) => (s.kind === "agent" || s.kind === "person" ? [`${s.kind}:${s.id}`] : [])));
  const unlinked = asked.some((s) => s.kind === "unlinked");
  return items.filter((i) => (i.subject.kind === "unlinked" ? unlinked : ids.has(`${i.subject.kind}:${i.subject.id}`)));
}

/** A person as a list subject: canonical handles only (the input schema refuses anything else and would fail the whole call). */
export function personSubject(db: Db, id: string): ListSubject {
  const handles = db
    .prepare("SELECT handle FROM fleet_handles WHERE person_id = ? ORDER BY handle")
    .all(id)
    .map((r) => String(r.handle))
    .filter((h) => HANDLE_PATTERN.test(h) && normalizeHandle(h) === h)
    .slice(0, LIST_LIMITS.handles);
  return { kind: "person", id, handles };
}

/** One page in the transaction of the caller. No await: digests and text are ready before it starts. */
export function storeItems(db: Db, target: AccessTarget, items: readonly AccessItem[], sweepId: string | null, now: number): void {
  const up = db.prepare(
    `INSERT INTO fleet_access_items (target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, since, digest, first_seen, last_seen, last_sweep)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (target, item_id) DO UPDATE SET kind = excluded.kind, subject_kind = excluded.subject_kind, subject_id = excluded.subject_id, resource = excluded.resource, direction = excluded.direction, level = excluded.level, label = excluded.label, state = excluded.state, revocable = excluded.revocable, since = excluded.since, digest = excluded.digest, last_seen = excluded.last_seen, last_sweep = excluded.last_sweep`,
  );
  for (const i of items) up.run(target, i.id, i.kind, i.subject.kind, i.subject.kind === "unlinked" ? null : i.subject.id, i.resource, i.direction, i.level, i.label, i.state, i.revocable ? 1 : 0, i.since, i.digest, now, now, sweepId);
}

export type ShadowRow = AccessItem & { firstSeen: number; lastSeen: number };

const toShadow = (r: Record<string, unknown>): ShadowRow => ({
  id: String(r.item_id),
  kind: String(r.kind),
  subject: r.subject_kind === "unlinked" ? { kind: "unlinked" } : { kind: r.subject_kind as "agent" | "person", id: String(r.subject_id) },
  resource: String(r.resource),
  direction: r.direction as AccessItem["direction"],
  level: r.level as AccessItem["level"],
  label: String(r.label),
  state: r.state as AccessItem["state"],
  revocable: Number(r.revocable) === 1,
  since: r.since === null ? null : String(r.since),
  digest: String(r.digest),
  firstSeen: Number(r.first_seen),
  lastSeen: Number(r.last_seen),
});

export const shadowOf = (db: Db, target: AccessTarget, subjects: readonly { kind: "agent" | "person"; id: string }[]): ShadowRow[] =>
  subjects.flatMap((s) => db.prepare("SELECT * FROM fleet_access_items WHERE target = ? AND subject_kind = ? AND subject_id = ? ORDER BY item_id").all(target, s.kind, s.id).map(toShadow));

export const unlinkedCount = (db: Db): number => Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_access_items WHERE target = 'connect' AND subject_kind = 'unlinked' AND kind IN ('account_as_me', 'account_as_itself')").get()?.n ?? 0);
