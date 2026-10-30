// The change log of what each store listed (migration 0012, C380 T2-b). The shadow copy `fleet_access_items` holds the rows as they are now
// and lets an ended row go; this keeps the rows for the access record: an item appeared, changed or ended at a sweep. Written in the same
// transaction as the shadow copy, so the two never disagree. Append-only by trigger. Owner side only; never authority.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessItem } from "./items.ts";

type Row = Record<string, unknown>;
export type Change = "appeared" | "changed" | "ended";

const INSERT = `INSERT INTO fleet_access_history (sweep_id, at, change, target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, since, digest)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** A stored row (shadow copy or history) as the columns the log keeps, in the order of INSERT after `change`, `target`, `item_id`. */
const fromRow = (r: Row): unknown[] => [r.kind, r.subject_kind, r.subject_id ?? null, r.resource, r.direction, r.level, r.label, r.state, r.revocable, r.since ?? null, r.digest];

export function logItem(db: Db, change: Change, sweepId: string, at: number, target: string, itemId: string, columns: Row): void {
  db.prepare(INSERT).run(sweepId, at, change, target, itemId, ...(fromRow(columns) as never[]));
}

/** What `storeItems` writes, as the columns of the shadow copy. */
export const columnsOf = (i: AccessItem): Row => ({
  kind: i.kind,
  subject_kind: i.subject.kind,
  subject_id: i.subject.kind === "unlinked" ? null : i.subject.id,
  resource: i.resource,
  direction: i.direction,
  level: i.level,
  label: i.label,
  state: i.state,
  revocable: i.revocable ? 1 : 0,
  since: i.since,
  digest: i.digest,
});

const SAME: readonly string[] = ["kind", "subject_kind", "subject_id", "resource", "direction", "level", "label", "state", "revocable", "digest"];
/** True when the row the store lists now is not the row the shadow copy holds. `since` alone is no change: it is the store's own date. */
export const differs = (before: Row, now: Row): boolean => SAME.some((k) => (before[k] ?? null) !== (now[k] ?? null));

/** Writes `appeared` or `changed` for one listed item, before the shadow copy takes it. Quiet when nothing changed. */
export function noteListed(db: Db, target: string, i: AccessItem, sweepId: string | null, at: number): void {
  const before = db.prepare("SELECT * FROM fleet_access_items WHERE target = ? AND item_id = ?").get(target, i.id);
  const now = columnsOf(i);
  if (!before) logItem(db, "appeared", sweepId ?? "", at, target, i.id, now);
  else if (differs(before, now)) logItem(db, "changed", sweepId ?? "", at, target, i.id, now);
}

/** The rows of one target are gone: each is kept here with what it was last. Call it before the delete. */
export function noteEnded(db: Db, sweepId: string, at: number, target: string, row: Row): void {
  logItem(db, "ended", sweepId, at, target, String(row.item_id), row);
}

/** What each store answered when this sweep ended: a copy of the read states. Called in the transaction that finishes the sweep. */
export function noteSweepStores(db: Db, sweepId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO fleet_sweep_stores (sweep_id, target, state, code, text, read_at, not_shown_json) SELECT ?, target, state, code, text, read_at, not_shown_json FROM fleet_read_state",
  ).run(sweepId);
}
