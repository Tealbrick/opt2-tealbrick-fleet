// The one client of tb.access/1 (spec 0.1.89, ACCESS.md "Fleet's failure map"): 1 call per second, 2 at a time, jitter, every answer
// mapped to one read state. "Not installed" is a plain fact; "could not be read" is never shown as zero. A refused or held read backs
// off for 15 minutes, in the database, so neither a restart nor a page view makes a new hold.
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { cleanText } from "../text.ts";
import { type AccessTarget, BadAnswer, type ListIn, type ListPage, type NotShown, parsePage } from "./items.ts";

export type ReadStateName = "read" | "not_installed" | "not_read" | "refused" | "waiting";

export const CALL_GAP_MS = 1000;
export const CALL_JITTER_MS = 200;
export const CALLS_AT_ONCE = 2;
export const CALL_TIMEOUT_MS = 10_000;
export const BACKOFF_MS = 15 * 60_000;
/** The SDK (0.1.43) drops the Retry-After header of a 429, so the fixed wait applies until a TbError carries `details.retryAfterMs`. */
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 5 * 60_000;

class TimedOut extends Error {}

/** FIFO. The slot of a call that timed out frees at the timeout: one hanging store does not stop the others. */
export class Pacer {
  #nextAt = 0;
  #active = 0;
  #queue: (() => void)[] = [];
  readonly #gapMs: number;
  readonly #jitterMs: number;
  constructor(gapMs = CALL_GAP_MS, jitterMs = CALL_JITTER_MS) {
    this.#gapMs = gapMs;
    this.#jitterMs = jitterMs;
  }
  #drain(): void {
    while (this.#active < CALLS_AT_ONCE && this.#queue.length > 0) {
      this.#active++;
      this.#queue.shift()?.();
    }
  }
  async #turn(): Promise<void> {
    await new Promise<void>((go) => {
      this.#queue.push(go);
      this.#drain();
    });
    const now = Date.now();
    const at = Math.max(now, this.#nextAt);
    this.#nextAt = at + this.#gapMs + Math.random() * this.#jitterMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  /** `timeoutMs` counts the wait for a turn too. */
  async run<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    const free = () => {
      if (held) {
        held = false;
        this.#active--;
        this.#drain();
      }
    };
    let late = false;
    const work = this.#turn().then(() => {
      held = true;
      if (late) {
        free();
        throw new TimedOut();
      }
      return fn();
    });
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, no) => {
          timer = setTimeout(() => {
            late = true;
            no(new TimedOut());
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      free();
      work.catch(() => {});
    }
  }
}

export const sharedPacer = new Pacer();

/** What the client needs from a context; op, job and start contexts all have it. */
export interface AccessEnv {
  callApp: OpContext["callApp"];
  companionTargets(): string[];
  bridgeCaps(): readonly string[];
  topology(): { instances: readonly (readonly unknown[])[] } | null;
  pacer?: Pacer;
  /** products in this version's manifest `companions` */
  declared: ReadonlySet<string>;
}

/**
 * Before any call. Absent from the targets or from the manifest = `not_installed`, with two exceptions, because the words must be true:
 * the owner's own picture lists the app (installed, this version or grant cannot read it), or there is no current workspace copy at all.
 */
export function presence(env: AccessEnv, target: AccessTarget): "present" | "not_installed" | "not_read" {
  const inTargets = env.companionTargets().includes(target);
  if (inTargets && env.declared.has(target)) return "present";
  let listed = false;
  try {
    listed = env.topology()?.instances.some((i) => i[1] === target) ?? false;
  } catch {
    listed = false;
  }
  if (inTargets || listed) return "not_read";
  return env.bridgeCaps().length === 0 ? "not_read" : "not_installed";
}

export type ReadAnswer = { ok: true; page: ListPage } | { ok: false; state: Exclude<ReadStateName, "read">; code: string; text: string; backoffMs: number; waitMs: number };

const stop = (state: "not_read" | "refused" | "waiting" | "not_installed", code: string, text: string, backoffMs = 0, waitMs = 0): ReadAnswer => ({ ok: false, state, code, text, backoffMs, waitMs });

const NOT_READ_TEXT: Readonly<Record<string, string>> = {
  timeout: "The app did not answer in time.",
  bad_answer: "The app gave an answer Governance cannot use.",
  unknown_tool: "This version of the app cannot report this list.",
  companion_undeclared: "This version of Governance does not read this app yet.",
  no_grant: "Governance has no permission to read this app.",
  no_access: "The app did not accept Governance as the caller.",
  caller_unverified: "The app did not accept Governance as the caller.",
  paused: "Governance is paused.",
};
export const notInstalledText = "This app is not installed.";
export const notPresentText = "Governance cannot read this app at the moment.";

/** The failure map. Everything not named here is `not_read`, never zero. */
export function classify(e: unknown): ReadAnswer {
  if (e instanceof TimedOut) return stop("not_read", "timeout", NOT_READ_TEXT.timeout as string);
  if (e instanceof BadAnswer) return stop("not_read", "bad_answer", NOT_READ_TEXT.bad_answer as string);
  if (!(e instanceof TbError)) return stop("not_read", "error", "The app could not answer.");
  if (e.code === "hook_denied" || e.code === "hold_denied") return stop("refused", e.code, cleanText(e.message).slice(0, 200) || "Rules & Approvals refused this read.", BACKOFF_MS);
  if (e.httpStatus === 429) {
    const asked = (e.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
    return stop("not_read", "rate_limited", "The app asked Governance to wait.", 0, typeof asked === "number" && asked > 0 ? Math.min(asked, MAX_WAIT_MS) : DEFAULT_WAIT_MS);
  }
  return stop("not_read", e.code, NOT_READ_TEXT[e.code] ?? "The app could not answer.");
}

/** One `access_list` call. Never throws. */
export async function readPage(env: AccessEnv, target: AccessTarget, input: ListIn, timeoutMs = CALL_TIMEOUT_MS): Promise<ReadAnswer> {
  try {
    const r = await (env.pacer ?? sharedPacer).run(() => env.callApp<unknown>(target, "access_list", input as unknown as Json), timeoutMs);
    if (r.status === "held") return stop("waiting", "held", "A person must approve this read in Rules & Approvals.", BACKOFF_MS);
    if (r.status !== "ok") return stop("not_read", "bad_answer", NOT_READ_TEXT.bad_answer as string);
    return { ok: true, page: parsePage(target, r.output, input.sweepId) };
  } catch (e) {
    return classify(e);
  }
}

export interface ReadStateRow {
  target: string;
  state: ReadStateName;
  code: string | null;
  text: string | null;
  readAt: number | null;
  triedAt: number;
  backoffUntil: number;
  notShown: NotShown[];
}

const toRow = (r: Record<string, unknown>): ReadStateRow => ({
  target: String(r.target),
  state: r.state as ReadStateName,
  code: r.code === null ? null : String(r.code),
  text: r.text === null ? null : String(r.text),
  readAt: r.read_at === null ? null : Number(r.read_at),
  triedAt: Number(r.tried_at),
  backoffUntil: Number(r.backoff_until),
  notShown: JSON.parse(String(r.not_shown_json)) as NotShown[],
});

export const readStates = (db: Db): ReadStateRow[] => db.prepare("SELECT * FROM fleet_read_state ORDER BY target").all().map(toRow);
export function readStateOf(db: Db, target: AccessTarget): ReadStateRow | null {
  const r = db.prepare("SELECT * FROM fleet_read_state WHERE target = ?").get(target);
  return r ? toRow(r) : null;
}

/** A full read: the state, its time and what the app cannot list. */
export function noteRead(db: Db, target: AccessTarget, notShown: readonly NotShown[], now: number): void {
  db.prepare(
    `INSERT INTO fleet_read_state (target, state, code, text, read_at, tried_at, backoff_until, not_shown_json) VALUES (?, 'read', NULL, NULL, ?, ?, 0, ?)
     ON CONFLICT (target) DO UPDATE SET state = 'read', code = NULL, text = NULL, read_at = excluded.read_at, tried_at = excluded.tried_at, backoff_until = 0, not_shown_json = excluded.not_shown_json`,
  ).run(target, now, now, JSON.stringify(notShown));
}

/** A read that did not finish. `read_at` and `not_shown_json` stay: they belong to the last full read. */
export function noteStop(db: Db, target: AccessTarget, a: { state: Exclude<ReadStateName, "read">; code: string; text: string; backoffMs?: number }, now: number): void {
  db.prepare(
    `INSERT INTO fleet_read_state (target, state, code, text, read_at, tried_at, backoff_until, not_shown_json) VALUES (?, ?, ?, ?, NULL, ?, ?, '[]')
     ON CONFLICT (target) DO UPDATE SET state = excluded.state, code = excluded.code, text = excluded.text, tried_at = excluded.tried_at, backoff_until = excluded.backoff_until`,
  ).run(target, a.state, a.code, a.text, now, now + (a.backoffMs ?? 0));
}

/** In a backoff: the stored answer, with no call. A manual check may repeat a refused read, never a held one. */
export function inBackoff(db: Db, target: AccessTarget, now: number, manual = false): ReadStateRow | null {
  const s = readStateOf(db, target);
  if (!s || s.backoffUntil <= now) return null;
  return manual && s.state !== "waiting" ? null : s;
}
