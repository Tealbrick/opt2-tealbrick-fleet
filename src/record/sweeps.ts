// The list of every sweep in a period (C380 T2-b): what each store listed, the rows that ended, and which stores were read. Rebuilt from the
// change log (src/access/history.ts) in one pass, in pages, so the app answers other calls between pages. The shadow copy is not read: it
// holds the rows as they are now and lets an ended row go.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { type AccessTarget, TARGET_NAMES } from "../access/items.ts";
import { fail } from "../meta.ts";

type Row = Record<string, unknown>;
const PAGE = 2000;
const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const nameOf = (target: string): string => TARGET_NAMES[target as AccessTarget] ?? target;
const tick = () => new Promise<void>((res) => setImmediate(res));

export interface SweepItem {
  product: string;
  store: string;
  id: string;
  kind: string;
  subject: { kind: string; id: string; name: string | null } | { kind: "unlinked" };
  level: string;
  direction: string;
  state: string;
  label: string;
  revocable: boolean;
}
export interface EndedItem extends SweepItem {
  endedAt: string;
}
export interface SweepStore {
  product: string;
  store: string;
  /** read: a full read in this sweep. Else the state the store was in when the sweep ended. */
  state: string;
  readThisSweep: boolean;
  readAt: string | null;
  code: string | null;
  text: string | null;
  cannotList: { kind: string; reason: string }[];
}
export interface SweepList {
  id: string;
  startedAt: string;
  finishedAt: string;
  startedBy: string;
  calls: number;
  storesRead: number;
  /** false: the sweep is before the change log began. Its list was not kept. */
  listKept: boolean;
  stores: SweepStore[];
  items: SweepItem[] | null;
  /** rows this sweep saw end: kept with what they last were */
  ended: EndedItem[];
  counts: { appeared: number; changed: number; ended: number };
}

export interface Names {
  agents: Map<string, string>;
  people: Map<string, string>;
}
export function namesOf(db: Db): Names {
  return {
    agents: new Map(db.prepare("SELECT id, name FROM fleet_agents").all().map((r) => [String(r.id), String(r.name)])),
    people: new Map(db.prepare("SELECT id, name FROM fleet_people").all().map((r) => [String(r.id), String(r.name)])),
  };
}

function itemOf(r: Row, names: Names): SweepItem {
  const product = String(r.target);
  const kind = String(r.subject_kind);
  const id = r.subject_id === null ? "" : String(r.subject_id);
  return {
    product,
    store: nameOf(product),
    id: String(r.item_id),
    kind: String(r.kind),
    subject: kind === "unlinked" ? { kind: "unlinked" } : { kind, id, name: (kind === "agent" ? names.agents : names.people).get(id) ?? null },
    level: String(r.level),
    direction: String(r.direction),
    state: String(r.state),
    label: String(r.label),
    revocable: Number(r.revocable) === 1,
  };
}

const storesOf = (db: Db, sweep: Row): SweepStore[] =>
  db
    .prepare("SELECT * FROM fleet_sweep_stores WHERE sweep_id = ? ORDER BY target")
    .all(String(sweep.id))
    .map((r) => ({
      product: String(r.target),
      store: nameOf(String(r.target)),
      state: String(r.state),
      readThisSweep: r.state === "read" && r.read_at !== null && Number(r.read_at) >= Number(sweep.started_at),
      readAt: iso(r.read_at),
      code: r.code === null ? null : String(r.code),
      text: r.text === null ? null : String(r.text),
      cannotList: JSON.parse(String(r.not_shown_json ?? "[]")) as { kind: string; reason: string }[],
    }));

/** The sweeps that finished in [from, to], oldest first. Past `max` the period is too long for one file. */
export function sweepsIn(db: Db, from: number, to: number, max: number): { sweeps: Row[]; notFinished: number } {
  const sweeps = db.prepare("SELECT * FROM fleet_sweeps WHERE finished_at IS NOT NULL AND finished_at >= ? AND finished_at <= ? ORDER BY finished_at, id LIMIT ?").all(from, to, max + 1);
  if (sweeps.length > max) fail("record_too_big", "This period has too many sweeps for one file. Choose a shorter period.", 409);
  const open = db.prepare("SELECT COUNT(*) AS n FROM fleet_sweeps WHERE finished_at IS NULL AND started_at >= ? AND started_at <= ?").get(from, to);
  return { sweeps, notFinished: Number(open?.n ?? 0) };
}

/**
 * One pass over the change log. The state is the last row of each item; a sweep takes the state up to its `history_seq`, the last log row it had when it ended, so
 * no clock decides which rows belong to which sweep. Rows of a sweep carry its id, so the rows that ended in it are listed beside the list. A sweep with no
 * watermark, or one that began before the log did, has no list. `maxRows` bounds the file: past it the period is too long. The list of a sweep is the Governance
 * copy as the sweep left it: for a store marked not read it can hold the pages that were read before it failed.
 */
export async function sweepLists(db: Db, sweeps: readonly Row[], since: number | null, names: Names, maxRows: number): Promise<SweepList[]> {
  const out: SweepList[] = [];
  const marks = sweeps.map((s) => (s.history_seq === null || s.history_seq === undefined ? null : Number(s.history_seq)));
  const last = Math.max(0, ...marks.map((m) => m ?? 0));
  const state = new Map<string, Row>();
  const endedBy = new Map<string, Row[]>();
  const countsBy = new Map<string, { appeared: number; changed: number; ended: number }>();
  let next = 0;
  let rows = 0;
  const emit = (sweep: Row, kept: boolean) => {
    const items = kept ? [...state.values()].sort((a, b) => String(a.target).localeCompare(String(b.target)) || String(a.item_id).localeCompare(String(b.item_id))).map((r) => itemOf(r, names)) : null;
    const ended = kept ? (endedBy.get(String(sweep.id)) ?? []).map((r) => ({ ...itemOf(r, names), endedAt: iso(r.at) as string })) : [];
    rows += (items?.length ?? 0) + ended.length;
    if (rows > maxRows) fail("record_too_big", "This period has too many rows for one file. Choose a shorter period.", 409);
    out.push({
      id: String(sweep.id),
      startedAt: iso(sweep.started_at) as string,
      finishedAt: iso(sweep.finished_at) as string,
      startedBy: String(sweep.started_by),
      calls: Number(sweep.calls),
      storesRead: Number(sweep.stores_read),
      listKept: kept,
      stores: storesOf(db, sweep),
      items,
      ended,
      counts: countsBy.get(String(sweep.id)) ?? { appeared: 0, changed: 0, ended: 0 },
    });
  };
  const keptOf = (i: number): boolean => marks[i] !== null && since !== null && Number(sweeps[i]?.started_at) >= since;
  /** A sweep with no watermark is before the log: it has no list and no rows to apply. */
  const skipUnknown = () => {
    while (next < sweeps.length && marks[next] === null) emit(sweeps[next++] as Row, false);
  };
  skipUnknown();
  let after = 0;
  for (;;) {
    const page = db.prepare("SELECT * FROM fleet_access_history WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?").all(after, last, PAGE);
    for (const r of page) {
      while (next < sweeps.length && Number(r.seq) > (marks[next] as number)) {
        emit(sweeps[next] as Row, keptOf(next));
        next++;
        skipUnknown();
      }
      const key = `${String(r.target)}\u0000${String(r.item_id)}`;
      const c = countsBy.get(String(r.sweep_id)) ?? { appeared: 0, changed: 0, ended: 0 };
      if (r.change === "ended") {
        state.delete(key);
        const list = endedBy.get(String(r.sweep_id)) ?? [];
        list.push(r);
        endedBy.set(String(r.sweep_id), list);
        c.ended++;
      } else {
        state.set(key, r);
        c[r.change === "appeared" ? "appeared" : "changed"]++;
      }
      countsBy.set(String(r.sweep_id), c);
      after = Number(r.seq);
    }
    if (page.length < PAGE) break;
    await tick();
  }
  while (next < sweeps.length) {
    emit(sweeps[next] as Row, keptOf(next));
    next++;
    skipUnknown();
  }
  return out;
}
