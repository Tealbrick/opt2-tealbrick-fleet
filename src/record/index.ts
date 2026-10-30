// The access record (C380 T2-b, DESIGN-C380 §7, §15 D7, D8): one file for a reader outside this app, built from the evidence tables only. It lists, for a period,
// what each store listed in every sweep (with the rows that ended), the open differences and accepted ones, time to stop as the app or the slice showed it, the
// stores that were not read, verdicts, plans with their outcomes copied, and who approved. It states its limits in the file: our own apps report this data, and it
// claims nothing about any law or standard. Built in pages with the event loop free between them. It changes nothing; the op that offers it writes one event.
import { createHash } from "node:crypto";
import { canonicalize } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { readStates } from "../access/client.ts";
import { type AccessTarget, TARGET_NAMES } from "../access/items.ts";
import { verifyChain } from "../lifecycle/events.ts";
import { fail } from "../meta.ts";
import { approversIn, eventsIn, exceptionsIn, plansIn, roundsIn, timeToStop, verdictsIn } from "./sections.ts";
import { namesOf, sweepLists, sweepsIn } from "./sweeps.ts";
import { CONTENTS, HEADER, limitsOf, manyApprovers, NO_APPROVER, ONE_APPROVER, RECORD_FORMAT } from "./words.ts";

export const MAX_DAYS = 366;
export const DEFAULT_DAYS = 90;
export const MAX_SWEEPS = 120;
export const MAX_ROWS = 20_000;
export const MAX_BYTES = 8_000_000;
const DAY_MS = 86_400_000;
const tick = () => new Promise<void>((res) => setImmediate(res));

export interface RecordInput {
  from?: string | undefined;
  to?: string | undefined;
}
export interface RecordFacts {
  /** the open differences and what could not be read, as findings_list answers them */
  findings: { lastSweepAt: string | null; storesRead: number; unread: { product: string; name: string; text: string }[]; items: unknown[] };
  version: string;
  now?: number | undefined;
  maxSweeps?: number | undefined;
  maxRows?: number | undefined;
}

export function periodOf(input: RecordInput, now: number): { from: number; to: number } {
  const bad = () => fail("period_invalid", "Choose a start and an end. The end is after the start, and the period is at most one year.", 400);
  const to = input.to === undefined ? now : Date.parse(input.to);
  const from = input.from === undefined ? to - DEFAULT_DAYS * DAY_MS : Date.parse(input.from);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAX_DAYS * DAY_MS) bad();
  return { from, to };
}

export const digestOfRecord = (record: Record<string, unknown>): string => {
  const copy = { ...record, integrity: { ...(record.integrity as object), digest: null } };
  return `sha256:${createHash("sha256").update(canonicalize(copy as unknown as Json)).digest("hex")}`;
};

export async function buildRecord(db: Db, input: RecordInput, facts: RecordFacts) {
  const now = facts.now ?? Date.now();
  const { from, to } = periodOf(input, now);
  const names = namesOf(db);
  const since = Number(db.prepare("SELECT value FROM fleet_record_meta WHERE key = 'record_since'").get()?.value ?? Number.NaN);
  const knownFrom = Number.isFinite(since) ? since : null;
  const { sweeps, notFinished } = sweepsIn(db, from, to, facts.maxSweeps ?? MAX_SWEEPS);
  const lists = await sweepLists(db, sweeps, knownFrom, names, facts.maxRows ?? MAX_ROWS);
  await tick();
  const events = eventsIn(db, from, to, names);
  const verdicts = verdictsIn(db, from, to, names);
  const exceptions = exceptionsIn(db, from, to, names);
  const rounds = roundsIn(db, from, to, now);
  await tick();
  const plans = plansIn(db, from, to, names);
  const stops = timeToStop(db, from, to, names);
  await tick();
  const approvers = approversIn({ verdicts, plans, exceptions, events, rounds });
  const approverLine = approvers.length === 0 ? NO_APPROVER : approvers.length === 1 ? ONE_APPROVER : manyApprovers(approvers.length);
  const unknownSweeps = lists.filter((l) => !l.listKept).length;
  const withStores = lists.filter((l) => l.stores.length > 0);
  const missed = (product: string) => withStores.filter((l) => !l.stores.find((s) => s.product === product)?.readThisSweep).length;
  const chain = verifyChain(db);
  const record = {
    format: RECORD_FORMAT,
    app: { product: "fleet", version: facts.version },
    generatedAt: new Date(now).toISOString(),
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    header: HEADER,
    limits: limitsOf({ since: knownFrom, unknownSweeps, approverLine }),
    contents: CONTENTS,
    approvers: { count: approvers.length, ids: approvers, line: approverLine },
    sweeps: { count: lists.length, notFinished, lists },
    findings: { note: "The differences open when this file was made.", lastSweepAt: facts.findings.lastSweepAt, items: facts.findings.items },
    exceptions,
    timeToStop: stops,
    appsNotRead: {
      now: facts.findings.unread,
      stores: readStates(db).map((s) => ({ product: s.target, store: TARGET_NAMES[s.target as AccessTarget] ?? s.target, state: s.state, text: s.text, lastReadAt: s.readAt === null ? null : new Date(s.readAt).toISOString(), cannotList: s.notShown, sweepsNotReadInPeriod: missed(s.target) })),
    },
    verdicts,
    rounds,
    plans,
    events,
    integrity: { chain: chain.ok ? { ok: true as const, rows: chain.rows } : { ok: false as const, brokenAt: chain.brokenAt }, digest: null as string | null, how: "Set integrity.digest to null, write the file in canonical JSON (RFC 8785) and take the SHA-256. The same digest is in the event 'Access record made' at the time of the export." },
  };
  record.integrity.digest = digestOfRecord(record);
  if (JSON.stringify(record).length > MAX_BYTES) fail("record_too_big", "This period gives a file that is too large. Choose a shorter period.", 409);
  return { record, digest: record.integrity.digest };
}
