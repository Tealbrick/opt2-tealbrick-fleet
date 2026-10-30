// The rail to Core (C380, DESIGN-C380 §5, spec 0.1.89 CORE "stop drafts", BRIDGE §8.8) and the proof of a Core step. The app only asks: the owner
// approves in Portal. No answer here is invented, and an answer this file cannot read is `wait`, never a step done.
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { DecodedTopology } from "../topology-slice.ts";
import type { CoreOp } from "./plan.ts";

// LOCAL COPY of spec 0.1.89 (bridge.ts, sdk.ts): the pinned SDK may be older. Drop this block when the pin carries `ctx.ownerDrafts`.
export type OwnerDraftState = "open" | "submitted" | "applying" | "applied" | "failed" | "rejected" | "expired";
export interface OwnerDraftStatus {
  draftId: string;
  state: OwnerDraftState;
  reviewUrl: string;
}
export interface OwnerDraftGetResult extends OwnerDraftStatus {
  digest: string;
  expiresAt: string | null;
  steps: { n: number; opId: string; agt: string; status: "pending" | "ok" | "failed" | "skipped"; output?: unknown; error?: { code: string; message: string } }[];
  receiptId: string | null;
}
export interface OwnerDraftRequestBody {
  key: string;
  title: string;
  planDigest: string;
  expiresInSec: number;
  steps: { opId: CoreOp; agt: string }[];
}
export interface OwnerDraftsApi {
  request(body: OwnerDraftRequestBody): Promise<OwnerDraftStatus>;
  get(key: string): Promise<OwnerDraftGetResult>;
  withdraw(key: string): Promise<OwnerDraftStatus>;
}

export type RailAnswer<T> =
  | { kind: "ok"; value: T }
  /** the rail is not there: an older bridge or Core, a standalone workspace, the flag off. Portal link mode stays. */
  | { kind: "off"; code: string }
  /** the owner has not allowed `topology`: the D1 gate */
  | { kind: "consent" }
  | { kind: "full"; afterMs: number | null }
  /** no answer, or one that says "later". What happened is not known: nothing is claimed */
  | { kind: "wait"; code: string; afterMs: number | null }
  | { kind: "unknown_key" }
  | { kind: "draft_state"; reason: string | null }
  /** a request Core can never take: a bug here, or a card that is gone */
  | { kind: "refused"; code: string; message: string };

const detailsOf = (e: TbError): Record<string, unknown> => ((e as unknown as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
const OFF_CODES = new Set(["bridge_cap_missing", "owner_drafts_unsupported"]);
const WAIT_CODES = new Set(["portal_unavailable", "temporarily_unavailable", "config_expired", "no_bridge", "app_not_running", "paused", "conflict"]);

/** Every refusal of CORE v0.1.89 and BRIDGE §8.8 has its one meaning here. */
export function railAnswerOf(e: unknown): RailAnswer<never> {
  if (!(e instanceof TbError)) return { kind: "wait", code: "no_answer", afterMs: null };
  const d = detailsOf(e);
  const afterMs = typeof d.retryAfterMs === "number" ? d.retryAfterMs : null;
  // A stale slice shows no caps. That says nothing about the bridge, and a draft may be open: try again, do not fall back.
  if (e.code === "bridge_cap_missing" && d.reason !== undefined) return { kind: "wait", code: String(d.reason), afterMs };
  if (OFF_CODES.has(e.code)) return { kind: "off", code: e.code };
  if (e.httpStatus === 404 && e.code === "not_found") {
    if (d.pointer === undefined) return { kind: "off", code: "rail_off" };
    return d.pointer === "/key" ? { kind: "unknown_key" } : { kind: "refused", code: "agent_not_in_workspace", message: "Portal does not list one of these agents." };
  }
  if (e.httpStatus === 403 && d.reason === "topology_consent") return { kind: "consent" };
  if (e.code === "owner_drafts_full") return { kind: "full", afterMs };
  if (e.code === "draft_state") return { kind: "draft_state", reason: typeof d.reason === "string" ? d.reason : null };
  if (e.httpStatus === 429 || e.httpStatus >= 500 || WAIT_CODES.has(e.code)) return { kind: "wait", code: e.code, afterMs };
  return { kind: "refused", code: e.code, message: e.message.slice(0, 200) };
}

export async function askRail<T>(fn: () => Promise<T>): Promise<RailAnswer<T>> {
  try {
    return { kind: "ok", value: await fn() };
  } catch (e) {
    return railAnswerOf(e);
  }
}

const KNOWN_STATES: readonly string[] = ["open", "submitted", "applying", "applied", "failed", "rejected", "expired"];
/** A body with another shape is no answer: a plan never moves on a body it cannot read. */
export function readableDraft(v: unknown): v is OwnerDraftGetResult {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r.draftId !== "string" || typeof r.digest !== "string" || !KNOWN_STATES.includes(String(r.state)) || !Array.isArray(r.steps)) return false;
  return r.steps.every((s: { opId?: unknown; agt?: unknown; status?: unknown } | null) => typeof s?.opId === "string" && typeof s.agt === "string" && typeof s.status === "string");
}

/** What the slice this app holds shows. `paused` counts an agent the slice does not list as stopped: the card is gone. No slice: false. */
export interface SliceView {
  paused(agent: string): boolean;
  topology(): DecodedTopology | null;
  /** null when the SDK has no such read */
  revision(): number | null;
}

export interface Proof {
  state: "done" | "reported" | "not_provable" | "pending_bridge" | "pending";
  detail: string | null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * §5.7: the proof of one Core step. Paused comes from `agents[].status`. Removed comes from Core's step output, and it counts as seen only when the slice agrees:
 * a slice revision at or above the step's `configRevision`, or a whole topology that shows nothing left. A cut list proves nothing (S2-5).
 * `output` undefined = Portal link mode: Core said nothing, so only the slice speaks.
 */
export function proveCoreStep(op: string, agent: string, output: Record<string, unknown> | undefined, view: SliceView): Proof {
  const said = output !== undefined;
  const waiting: Proof = said ? { state: "pending_bridge", detail: null } : { state: "pending", detail: null };
  const paused = view.paused(agent);
  if (op === "agents.pause") return paused ? { state: "done", detail: null } : waiting;
  if (op === "agents.offboard" && !paused) return waiting;
  const rev = view.revision();
  const cfg = said ? num(output.configRevision) : null;
  if (rev !== null && cfg !== null && rev >= cfg) return { state: "done", detail: null };
  const top = view.topology();
  if (!top || top.truncated) {
    if (!said) return { state: "not_provable", detail: "Governance cannot see this. Check it in Portal." };
    const n = op === "agents.offboard" ? num(output.removedEdges) : null;
    const k = num(output.revokedConnections);
    return { state: "reported", detail: `Core says removed ${n !== null ? `${n} app access and ` : ""}${k ?? 0} connections. Governance cannot see this.` };
  }
  const keys = top.connections.some((c) => c.agt === agent && c.status === "active");
  const edges = op === "agents.offboard" && top.edges.some((e) => e.agent === agent);
  return keys || edges ? waiting : { state: "done", detail: null };
}
