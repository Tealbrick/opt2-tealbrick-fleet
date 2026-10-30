// How the runner reads and ends access in a store: `tb.access/1` and Fleet's failure map (DESIGN-C380 §3). One answer type per call, so the runner has
// one branch per row of that map, and "could not read" can never become "nothing there".
import { type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type AccessEnv, presence, readPage, sharedPacer } from "../access/client.ts";
import { type AccessItem, type AccessTarget, LIST_LIMITS, type ListSubject, onlyAsked } from "../access/items.ts";
import { cleanText } from "../text.ts";

export type { AccessItem, ListSubject };
export type ListAnswer =
  | { kind: "ok"; items: AccessItem[]; notShown: string[] }
  | { kind: "not_installed" }
  | { kind: "not_read"; code: string }
  | { kind: "refused"; code: string; reason: string }
  | { kind: "held" }
  | { kind: "wait"; afterMs: number };
export interface RevokeIn {
  v: 1;
  plan: string;
  attempt: number;
  subject: { kind: "agent" | "person"; id: string };
  items: { id: string; digest: string }[];
}
export interface RevokeResult {
  id: string;
  outcome: "revoked" | "already_gone" | "changed" | "not_revocable" | "failed";
  code?: string;
  detail?: string;
}
export type RevokeAnswer =
  | { kind: "ok"; results: RevokeResult[]; receiptId: string | null }
  | { kind: "held"; holdId: string }
  /** Rules or the owner said no: only "Try again" asks again */
  | { kind: "refused"; code: string; reason: string }
  /** the SDK refused this key for a different input: a bug here. Surfaced */
  | { kind: "conflict"; code: string }
  /** the call may have run: only a fresh list tells */
  | { kind: "unknown"; code: string; afterMs: number | null };

export interface AccessPort {
  list(product: AccessTarget, subjects: ListSubject[], signal?: AbortSignal): Promise<ListAnswer>;
  revoke(product: AccessTarget, input: RevokeIn, key: string): Promise<RevokeAnswer>;
}

/** Connect ends at most 5 per call (ACCESS "Batch"), the others 10. */
export const revokeBatchMax = (product: string): number => (product === "connect" ? 5 : 10);
const PAGE_CAP = 50;
/** The SDK gives an op 30 s; past that the outcome is not known. */
const REVOKE_TIMEOUT_MS = 35_000;
const OUTCOMES: readonly string[] = ["revoked", "already_gone", "changed", "not_revocable", "failed"];

/** The answer, checked by hand as the schema does. One bad row and the whole answer is no answer: the call may have run, so only a fresh list tells. */
export function parseRevoke(raw: unknown, input: RevokeIn): RevokeResult[] | null {
  const r = raw as { v?: unknown; results?: unknown } | null;
  if (r?.v !== 1 || !Array.isArray(r.results)) return null;
  const asked = new Set(input.items.map((i) => i.id));
  const out: RevokeResult[] = [];
  for (const row of r.results as { id?: unknown; outcome?: unknown; code?: unknown; detail?: unknown }[]) {
    if (typeof row?.id !== "string" || !asked.has(row.id) || typeof row.outcome !== "string" || !OUTCOMES.includes(row.outcome)) return null;
    out.push({
      id: row.id,
      outcome: row.outcome as RevokeResult["outcome"],
      ...(typeof row.code === "string" ? { code: cleanText(row.code).slice(0, 64) } : {}),
      ...(typeof row.detail === "string" ? { detail: cleanText(row.detail).slice(0, 200) } : {}),
    });
  }
  return out;
}

/** The port over B9b's one client: its pacing, its failure map, its checks of a page. */
export function clientPort(env: AccessEnv): AccessPort {
  return {
    async list(product, subjects, signal) {
      const here = presence(env, product);
      if (here === "not_installed") return { kind: "not_installed" };
      if (here !== "present") return { kind: "not_read", code: here };
      const items: AccessItem[] = [];
      const notShown = new Set<string>();
      // The contract takes 32 subjects per call. One sweep of pages per chunk.
      for (let at = 0; at < subjects.length; at += LIST_LIMITS.subjects) {
        const chunk = subjects.slice(at, at + LIST_LIMITS.subjects);
        let cursor: string | undefined;
        let ended = false;
        // A lying store cannot answer `nextCursor` for ever: a read that does not end is not a read.
        for (let page = 0; page < PAGE_CAP && !ended; page++) {
          if (signal?.aborted) return { kind: "not_read", code: "aborted" };
          const a = await readPage(env, product, { v: 1, subjects: chunk, ...(cursor ? { cursor } : {}) });
          if (!a.ok) {
            if (a.state === "refused") return { kind: "refused", code: a.code, reason: a.text };
            if (a.state === "waiting") return { kind: "held" };
            if (a.state === "not_installed") return { kind: "not_installed" };
            return a.waitMs > 0 ? { kind: "wait", afterMs: a.waitMs } : { kind: "not_read", code: a.code };
          }
          items.push(...onlyAsked(a.page.items, chunk));
          for (const n of a.page.notShown) notShown.add(n.kind);
          if (a.page.nextCursor === null) ended = true;
          else cursor = a.page.nextCursor;
        }
        if (!ended) return { kind: "not_read", code: "too_many_pages" };
      }
      return { kind: "ok", items, notShown: [...notShown] };
    },
    async revoke(product, input, key) {
      let out: { status: string; output?: unknown; holdId?: string; receiptId?: string };
      try {
        out = await (env.pacer ?? sharedPacer).run(() => env.callApp<unknown>(product, "access_revoke", input as unknown as Json, { idempotencyKey: key }), REVOKE_TIMEOUT_MS);
      } catch (e) {
        if (!(e instanceof TbError)) return { kind: "unknown", code: "no_answer", afterMs: null };
        if (e.code === "hook_denied" || e.code === "hold_denied") return { kind: "refused", code: e.code, reason: cleanText(e.message).slice(0, 200) };
        if (e.code === "idempotency_conflict") return { kind: "conflict", code: e.code };
        const d = (e as unknown as { details?: { retryAfterMs?: unknown } }).details;
        return { kind: "unknown", code: e.code, afterMs: typeof d?.retryAfterMs === "number" ? d.retryAfterMs : e.httpStatus === 429 ? 60_000 : null };
      }
      if (out.status === "held") return { kind: "held", holdId: String(out.holdId) };
      const results = out.status === "ok" ? parseRevoke(out.output, input) : null;
      if (!results) return { kind: "unknown", code: "bad_answer", afterMs: null };
      return { kind: "ok", results, receiptId: typeof out.receiptId === "string" ? out.receiptId : null };
    },
  };
}
