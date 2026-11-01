// What Governance can say about the early stop (C380, DESIGN-C380 §9, S2-9). It reads Rules `floor_status` and says only what that shows.
// Fleet cannot read the hook switch, so it never claims to. "Rules has this change" needs feedRevision >= the revision of the change.
import { TbError } from "@opt2-tealbrick/miniapp-sdk";

export type FloorState = "confirmed" | "not_confirmed" | "not_installed" | "older" | "not_read";
export interface FloorView {
  state: FloorState;
  text: string;
  version: string | null;
  feedRevision: number | null;
  entries: number | null;
  lastGateAt: string | null;
  gateNote: string | null;
  /** N2-2: stops Rules keeps that this directory no longer lists */
  rulesHolds?: string | null;
}
export interface FloorStatus {
  version: string;
  /** null: Rules has not read a full feed yet */
  feedRevision: number | null;
  entries: number;
  lastGateAt: string | null;
  /** N2-2, Rules 0.7.0-dev.3: stops Rules keeps after a Governance that went back. Absent on an older Rules */
  unlisted?: number;
}

export const FLOOR_TEXT = {
  confirmed: "Rules has this change.",
  not_confirmed: "Not confirmed: nothing may stop until you approve in Portal.",
  not_installed: "Rules & Approvals adds an early stop. It is not installed, or it needs an update.",
  older: "Rules & Approvals is installed, but this version has no early stop. Update it.",
  not_read: "Rules & Approvals could not be read. Nothing may stop until you approve in Portal.",
} as const;
/** N2-4: whether the list of who is refused holds now, in words for the owner. */
export const FLOOR_READ_TEXT = {
  reads: "Rules & Approvals reads this list, so these entries are refused now if its hook is on.",
  not_installed: "Rules & Approvals is not installed, so nothing here is refused yet.",
  older: "This version of Rules & Approvals does not read this list, so nothing here is refused yet. Update Rules & Approvals when you have read it.",
  not_read: "Rules & Approvals could not be read, so Governance cannot say if these entries are refused now.",
} as const;

/** A gate this old, while agents run, is worth a line. */
export const GATE_STALE_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 3_000;

const empty = (state: FloorState): FloorView => ({ state, text: FLOOR_TEXT[state], version: null, feedRevision: null, entries: null, lastGateAt: null, gateNote: null });

/** Pure: the words for what was read. `rev` is the feed revision of the change the page is about. */
export function floorView(read: FloorStatus | Exclude<FloorState, "confirmed" | "not_confirmed">, rev: number, now: number, agentsRun: boolean): FloorView {
  if (typeof read === "string") return empty(read);
  const state: FloorState = read.feedRevision !== null && read.feedRevision >= rev ? "confirmed" : "not_confirmed";
  const gateMs = read.lastGateAt === null ? Number.NaN : Date.parse(read.lastGateAt);
  const gateNote = !agentsRun ? null : read.lastGateAt === null ? "Rules has not checked a call yet." : Number.isFinite(gateMs) && gateMs + GATE_STALE_MS < now ? `Rules has not checked a call since ${new Date(gateMs).toISOString()}.` : null;
  const rulesHolds = typeof read.unlisted === "number" && read.unlisted > 0 ? `Rules still holds ${read.unlisted === 1 ? "1 entry" : `${read.unlisted} entries`} Governance does not list. They still refuse calls. Clear them on the Rules page.` : null;
  return { state, text: FLOOR_TEXT[state], version: read.version, feedRevision: read.feedRevision, entries: read.entries, lastGateAt: read.lastGateAt, gateNote, rulesHolds };
}

const isStatus = (o: unknown): o is FloorStatus => {
  const r = o as Record<string, unknown> | null;
  return !!r && typeof r.version === "string" && (r.feedRevision === null || Number.isInteger(r.feedRevision)) && Number.isInteger(r.entries) && (r.lastGateAt === null || typeof r.lastGateAt === "string");
};

const OLDER_CODES = new Set(["unknown_tool", "unknown_op"]);

export interface FloorContext {
  companionTargets(): string[];
  callApp<T>(product: string, op: string, input: never): Promise<{ status: string; output?: T }>;
}

/** Reads Rules, with its own timeout. Never throws: an answer it cannot use is `not_read`, never "nothing stops". */
export async function readFloorStatus(ctx: FloorContext): Promise<FloorStatus | "not_installed" | "older" | "not_read"> {
  if (!ctx.companionTargets().includes("rules")) return "not_installed";
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      ctx.callApp<FloorStatus>("rules", "floor_status", {} as never),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TbError("timeout", "Rules did not answer", 504)), READ_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return answer.status === "ok" && isStatus(answer.output) ? answer.output : "not_read";
  } catch (e) {
    return e instanceof TbError && OLDER_CODES.has(e.code) ? "older" : "not_read";
  } finally {
    clearTimeout(timer);
  }
}
