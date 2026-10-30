// The record of every state change (migration 0008, append-only by trigger). Each row carries the hash of the row before it, so
// an edit of an old row breaks the chain. It proves no more than that: the app owns the file, and a restore drops later rows
// (a `restored` row says so). Owner side only: no agent op and no feed reads this table.
import { createHash } from "node:crypto";
import { canonicalize, ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";

export const GENESIS = "genesis";
export const SNAPSHOT_MAX = 8192;

type Row = Record<string, unknown>;

export interface NewEvent {
  subject: { kind: string; id: string; name: string };
  kind: "transition" | "moved" | "migrated" | "restored" | "changed";
  from?: string | null;
  to?: string | null;
  actor: { kind: "owner" | "system"; id: string | null };
  reason?: string | null;
  note?: string | null;
  snapshot?: Json;
  plan?: { id: string; draftId: string | null; receiptId: string | null };
  at: number;
}

const FIELDS = ["id", "subject_kind", "subject_id", "subject_name", "kind", "from_state", "to_state", "actor_kind", "actor_id", "reason", "note", "plan_id", "draft_id", "receipt_id", "snapshot_json", "snapshot_digest", "prev_hash", "at"] as const;

/** The hash of a stored row: sha256 over the canonical form of all its fields except `seq`. */
export function eventHash(r: Row): string {
  const doc: Record<string, Json> = {};
  for (const f of FIELDS) doc[f] = (r[f] ?? null) as Json;
  return createHash("sha256").update(canonicalize(doc as Json)).digest("hex");
}

export function digestOf(v: Json): string {
  return createHash("sha256").update(canonicalize(v)).digest("hex");
}

/** Adds one row at the end of the chain. Call it inside the transaction of the change it records. */
export function appendEvent(db: Db, e: NewEvent): string {
  const last = db.prepare("SELECT * FROM fleet_lifecycle_events ORDER BY seq DESC LIMIT 1").get();
  const prev = last ? eventHash(last) : GENESIS;
  const id = `lev_${ulid(e.at)}`;
  const snapshot = e.snapshot === undefined ? null : JSON.stringify(e.snapshot);
  db.prepare(
    `INSERT INTO fleet_lifecycle_events (id, subject_kind, subject_id, subject_name, kind, from_state, to_state, actor_kind, actor_id, reason, note, plan_id, draft_id, receipt_id, snapshot_json, snapshot_digest, prev_hash, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, e.subject.kind, e.subject.id, e.subject.name, e.kind, e.from ?? null, e.to ?? null, e.actor.kind, e.actor.id, e.reason ?? null, e.note ?? null, e.plan?.id ?? null, e.plan?.draftId ?? null, e.plan?.receiptId ?? null, snapshot, e.snapshot === undefined ? null : digestOf(e.snapshot), prev, e.at);
  return id;
}

type ChainResult = { ok: true; rows: number } | { ok: false; brokenAt: number };
/** A row of the migration has no `prev_hash`; every later row must name the hash of the row before it. */
const linked = (r: Row, before: Row | null): boolean => (r.prev_hash === null ? r.kind === "migrated" : r.prev_hash === (before ? eventHash(before) : GENESIS));

/** Walks the chain. */
export function verifyChain(db: Db): ChainResult {
  let before: Row | null = null;
  let rows = 0;
  for (const r of db.prepare("SELECT * FROM fleet_lifecycle_events ORDER BY seq").all()) {
    rows++;
    if (!linked(r, before)) return { ok: false, brokenAt: Number(r.seq) };
    before = r;
  }
  return { ok: true, rows };
}

/** The same walk in pages, with the event loop free between them: a long history must not hold a request for the hook that stops agents. */
export async function verifyChainPaged(db: Db, page = 500): Promise<ChainResult> {
  let before: Row | null = null;
  let rows = 0;
  let after = 0;
  for (;;) {
    const batch = db.prepare("SELECT * FROM fleet_lifecycle_events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, page);
    for (const r of batch) {
      rows++;
      if (!linked(r, before)) return { ok: false, brokenAt: Number(r.seq) };
      before = r;
      after = Number(r.seq);
    }
    if (batch.length < page) return { ok: true, rows };
    await new Promise<void>((res) => setImmediate(res));
  }
}

export interface EventView {
  id: string;
  kind: string;
  from: string | null;
  to: string | null;
  actor: "owner" | "system";
  reason: string | null;
  note: string | null;
  at: string;
}

/** The newest rows of one subject, newest first. */
export function subjectEvents(db: Db, kind: string, id: string, limit = 100): EventView[] {
  return db
    .prepare("SELECT id, kind, from_state, to_state, actor_kind, reason, note, at FROM fleet_lifecycle_events WHERE subject_kind = ? AND subject_id = ? ORDER BY seq DESC LIMIT ?")
    .all(kind, id, limit)
    .map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      from: r.from_state === null ? null : String(r.from_state),
      to: r.to_state === null ? null : String(r.to_state),
      actor: r.actor_kind === "owner" ? "owner" : "system",
      reason: r.reason === null ? null : String(r.reason),
      note: r.note === null ? null : String(r.note),
      at: new Date(Number(r.at)).toISOString(),
    }));
}

/** The snapshot kept with the last transition to `leaving` of this subject, if any. */
export function lastLeavingSnapshot(db: Db, kind: string, id: string): Record<string, unknown> | null {
  const r = db.prepare("SELECT snapshot_json FROM fleet_lifecycle_events WHERE subject_kind = ? AND subject_id = ? AND to_state = 'leaving' AND snapshot_json IS NOT NULL ORDER BY seq DESC LIMIT 1").get(kind, id);
  return r ? (JSON.parse(String(r.snapshot_json)) as Record<string, unknown>) : null;
}

/** Stops (T3, T5, a start date in the future) since `since` (ms). The one count behind the cap and the "stopped today" banner. */
export function stopsSince(db: Db, since: number): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_lifecycle_events WHERE kind IN ('transition', 'changed') AND to_state IN ('suspended', 'leaving', 'not_started') AND at > ?").get(since)?.n ?? 0);
}

/**
 * A restore brings back an older file and drops later rows. The SDK marks the archive in tb_meta (`restore_applied`). When that mark
 * is new, this writes one `restored` row at boot, so the record says that rows can be missing.
 */
export function noteRestore(db: Db, now: number): boolean {
  let mark: unknown;
  try {
    mark = db.prepare("SELECT value FROM tb_meta WHERE key = 'restore_applied'").get()?.value;
  } catch {
    return false; // no such table in this SDK: nothing to say
  }
  if (typeof mark !== "string" || mark === "") return false;
  const seen = db.prepare("SELECT value FROM fleet_settings WHERE key = 'restore_seen'").get()?.value;
  if (seen === mark) return false;
  return db.transaction(() => {
    db.prepare("INSERT INTO fleet_settings (key, value) VALUES ('restore_seen', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(mark as string);
    appendEvent(db, { subject: { kind: "workspace", id: "", name: "Governance" }, kind: "restored", actor: { kind: "system", id: null }, note: "Data was restored from a backup. Rows after that backup are not in this record.", at: now });
    return true;
  });
}
