// The change log of what each store listed (migration 0012, C380 T2-b). The shadow copy `fleet_access_items` holds the rows as they are now
// and lets an ended row go; this keeps the rows for the access record: an item appeared, changed or ended at a sweep. Written in the same
// transaction as the shadow copy, so the two never disagree. Append-only by trigger. Owner side only; never authority.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessItem } from "./items.ts";

type Row = Record<string, unknown>;
export type Change = "appeared" | "changed" | "ended";

type Insert = (change: Change, sweepId: string, at: number, target: string, itemId: string, columns: Row) => void;

/** The writer of one transaction: its statements are prepared once, not once per row. */
export function historyWriter(db: Db): Insert {
  const insert = db.prepare(
    `INSERT INTO fleet_access_history (sweep_id, at, change, target, item_id, kind, subject_kind, subject_id, resource, direction, level, label, state, revocable, since, digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return (change, sweepId, at, target, itemId, columns) => {
    insert.run(sweepId, at, change, target, itemId, ...(fromRow(columns) as never[]));
  };
}

/** A stored row (shadow copy or history) as the columns the log keeps, in the order of INSERT after `change`, `target`, `item_id`. */
const fromRow = (r: Row): unknown[] => [r.kind, r.subject_kind, r.subject_id ?? null, r.resource, r.direction, r.level, r.label, r.state, r.revocable, r.since ?? null, r.digest];

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

/**
 * Writes `appeared` or `changed` for each listed item, before the shadow copy takes it. Quiet when nothing changed. `since` alone is no change in the log:
 * the shadow copy takes the store's newer date, and a record built from the log shows no `since`.
 */
export function listedNoter(db: Db, target: string, sweepId: string | null, at: number): (i: AccessItem) => void {
  const get = db.prepare("SELECT * FROM fleet_access_items WHERE target = ? AND item_id = ?");
  const write = historyWriter(db);
  return (i) => {
    const before = get.get(target, i.id);
    const now = columnsOf(i);
    if (!before) write("appeared", sweepId ?? "", at, target, i.id, now);
    else if (differs(before, now)) write("changed", sweepId ?? "", at, target, i.id, now);
  };
}

/** The rows of one target are gone: each is kept here with what it was last. Call it before the delete. */
export function endedWriter(db: Db, sweepId: string, at: number, target: string): (row: Row) => void {
  const write = historyWriter(db);
  return (row) => write("ended", sweepId, at, target, String(row.item_id), row);
}

/**
 * What each store answered when this sweep ended: a copy of the read states, and how far the log had gone. Called in the transaction that finishes the sweep.
 * A store that could not be read in this sweep may still have pages in the log: the list of a sweep is the Governance copy as the sweep left it.
 * A finish that runs again (a restart after the commit) finds the copy there and writes nothing: the first answer stands. Returns the watermark, or null then.
 */
export function noteSweepStores(db: Db, sweepId: string): number | null {
  if (db.prepare("SELECT 1 FROM fleet_sweep_stores WHERE sweep_id = ? LIMIT 1").get(sweepId)) return null;
  db.prepare("INSERT INTO fleet_sweep_stores (sweep_id, target, state, code, text, read_at, not_shown_json) SELECT ?, target, state, code, text, read_at, not_shown_json FROM fleet_read_state").run(sweepId);
  return Number(db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM fleet_access_history").get()?.seq ?? 0);
}
