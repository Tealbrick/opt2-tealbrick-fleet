// Fakes at the two outer edges of the plan runner, and nothing inside it. FakeCore follows spec 0.1.89 CORE "stop drafts" and core#76's owner-drafts.ts rule by rule:
// keys, replace, expiry in the apply lock, stuck apply. FakeStore follows the SDK's idempotency (ops.ts claimIdempotency) and tb.access/1: digests from its own rows,
// the S2-6 bind on its OWN copy of the slice. Both keep what a process crash would keep, so a restart test sees what a real restart sees.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessItem } from "../src/access/items.ts";
import type { OwnerDraftGetResult, OwnerDraftRequestBody, OwnerDraftState, OwnerDraftStatus, OwnerDraftsApi, SliceView } from "../src/plans/core-rail.ts";
import type { DecodedTopology } from "../src/topology-slice.ts";

const REVOKE_IN = JSON.parse(readFileSync(new URL("./contracts/access.revoke_in.1.schema.json", import.meta.url), "utf8"));
const LIST_IN = JSON.parse(readFileSync(new URL("./contracts/access.list_in.1.schema.json", import.meta.url), "utf8"));
const REVOKE_OUT = JSON.parse(readFileSync(new URL("./contracts/access.revoke_out.1.schema.json", import.meta.url), "utf8"));
/** The fake refuses what the spec refuses: bytes of spec-v0.1.89. A wrong shape from the runner fails a test here, not on qa1. */
function mustFit(schema: never, v: unknown, what: string): void {
  const r = validateAgainstSchema(schema, v as Json);
  if (!r.ok) throw new Error(`${what} does not fit the contract: ${JSON.stringify(r.errors).slice(0, 400)}`);
}

const sha = (v: unknown): string => `sha256:${createHash("sha256").update(canonicalize(v as Json)).digest("hex")}`;

interface Draft {
  id: string;
  key: string | null;
  steps: { opId: string; agt: string }[];
  digest: string;
  state: "submitted" | "applying" | "applied" | "failed" | "rejected";
  expiresAt: number;
  appliedSince: number | null;
  status: { status: "pending" | "ok" | "failed"; output?: unknown; error?: { code: string; message: string } }[];
  receiptId: string | null;
  replaces: string | null;
  title: string;
  planDigest: string;
}
export interface CoreData {
  rev: number;
  deliveredRev: number;
  agents: Record<string, { status: "active" | "paused"; offboarded: boolean; edges: number; keys: number }>;
  delivered: Record<string, { status: "active" | "paused"; edges: number; keys: number }>;
  drafts: Draft[];
  seq: number;
  requests: number;
}

export class FakeCore implements OwnerDraftsApi {
  data: CoreData = { rev: 1, deliveredRev: 1, agents: {}, delivered: {}, drafts: [], seq: 0, requests: 0 };
  now: () => number;
  /** rail switches */
  flag = true;
  consent = true;
  down = false;
  topologyOn = true;
  truncated = false;
  /** the draft is stored, and the answer is lost */
  loseNextAnswer = false;
  failStep: string | null = null;
  failAgent: string | null = null;
  /** what a future SDK read of slice.rev would answer */
  revisionRead: number | null = null;
  /** the next body of get lies about its steps */
  lieGet: "digest" | "steps" | null = null;
  /** called at named points; a test's child process dies there */
  crashPoint: (name: string) => void = () => {};
  save: () => void = () => {};

  constructor(now: () => number) {
    this.now = now;
  }
  addAgent(id: string, edges = 2, keys = 1): void {
    this.data.agents[id] = { status: "active", offboarded: false, edges, keys };
    this.deliver();
  }
  /** Core's slice reaches the app. Until then the app's copy is the old one. */
  deliver(): void {
    this.data.deliveredRev = this.data.rev;
    this.data.delivered = Object.fromEntries(Object.entries(this.data.agents).map(([k, a]) => [k, { status: a.status, edges: a.edges, keys: a.keys }]));
    this.save();
  }
  /** The owner's own Portal action, outside any draft. */
  pauseInPortal(agt: string): void {
    const a = this.data.agents[agt] as CoreData["agents"][string];
    a.status = "paused";
    this.data.rev++;
    this.save();
  }
  resumeInPortal(agt: string): void {
    const a = this.data.agents[agt] as CoreData["agents"][string];
    if (a.offboarded) throw new TbError("agent_offboarded", "offboarded", 409);
    a.status = "active";
    this.data.rev++;
    this.save();
  }
  private guard(): void {
    if (this.down) throw new TbError("portal_unavailable", "Portal did not answer", 503);
    if (!this.flag) throw new TbError("not_found", "not found", 404);
  }
  private state(d: Draft): OwnerDraftState {
    // core drafts.ts expiredAt: open, submitted and failed run out; a stop that was applied or is applying does not.
    return d.state !== "applied" && d.state !== "applying" && d.state !== "rejected" && this.now() >= d.expiresAt ? "expired" : d.state;
  }
  private status(d: Draft): OwnerDraftStatus {
    return { draftId: d.id, state: this.state(d), reviewUrl: `https://portal.test/drafts/${d.id}` };
  }
  byKey(key: string): Draft {
    const d = this.data.drafts.find((x) => x.key === key);
    if (!d) throw new TbError("not_found", "no such key", 404, { pointer: "/key" });
    return d;
  }
  async request(b: OwnerDraftRequestBody): Promise<OwnerDraftStatus> {
    this.guard();
    if (!this.consent) throw new TbError("forbidden", "no consent", 403, { reason: "topology_consent" });
    if (!/^pln_[A-Za-z0-9._:-]{1,124}$/.test(b.key)) throw new TbError("validation_failed", "key", 400, { pointer: "/key" });
    if (b.steps.length < 1 || b.steps.length > 100) throw new TbError("validation_failed", "steps", 400, { pointer: "/steps" });
    if (b.title.length > 120) throw new TbError("validation_failed", "title", 400, { pointer: "/title" });
    if (b.expiresInSec < 60 || b.expiresInSec > 86400) throw new TbError("validation_failed", "expires", 400, { pointer: "/expiresInSec" });
    for (const [i, s] of b.steps.entries()) {
      if (!["agents.pause", "agents.offboard", "agents.rotate"].includes(s.opId)) throw new TbError("draft_op_not_draftable", "op", 400, { pointer: `/steps/${i}/opId` });
      if (!this.data.agents[s.agt]) throw new TbError("not_found", "agent", 404, { pointer: `/steps/${i}/agt` });
    }
    const digest = sha(b.steps);
    const prev = this.data.drafts.find((x) => x.key === b.key);
    if (prev && prev.digest === digest) return this.answer(this.status(prev));
    if (prev && ["applying", "applied"].includes(prev.state)) throw new TbError("draft_state", "ran", 409);
    let replaces: string | null = null;
    if (prev) {
      if (prev.state === "submitted" && this.now() < prev.expiresAt) {
        replaces = prev.id;
        prev.state = "rejected";
      }
      prev.key = null;
    }
    const open = this.data.drafts.filter((d) => d.state === "submitted" && this.now() < d.expiresAt).length;
    if (open >= 10) throw new TbError("owner_drafts_full", "full", 409, { openMax: 10 });
    this.data.requests++;
    const d: Draft = { id: `drf_${++this.data.seq}`, key: b.key, steps: b.steps.map((s) => ({ opId: s.opId, agt: s.agt })), digest, state: "submitted", expiresAt: this.now() + b.expiresInSec * 1000, appliedSince: null, status: b.steps.map(() => ({ status: "pending" })), receiptId: null, replaces, title: b.title, planDigest: b.planDigest };
    this.data.drafts.push(d);
    this.save();
    this.crashPoint("core_request_stored");
    return this.answer(this.status(d));
  }
  private answer<T>(v: T): T {
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new TbError("portal_unavailable", "no answer", 503);
    }
    return v;
  }
  async get(key: string): Promise<OwnerDraftGetResult> {
    this.guard();
    const d = this.byKey(key);
    if (d.state === "applying" && d.appliedSince !== null && this.now() - d.appliedSince > 120_000) d.state = "failed";
    const body: OwnerDraftGetResult = { ...this.status(d), digest: d.digest, expiresAt: new Date(d.expiresAt).toISOString(), steps: d.steps.map((s, n) => ({ n, opId: s.opId, agt: s.agt, status: (d.status[n] as Draft["status"][number]).status, ...((d.status[n] as Draft["status"][number]).output !== undefined ? { output: (d.status[n] as Draft["status"][number]).output } : {}), ...((d.status[n] as Draft["status"][number]).error ? { error: (d.status[n] as Draft["status"][number]).error as { code: string; message: string } } : {}) })), receiptId: d.receiptId };
    if (this.lieGet === "digest") body.digest = sha("other");
    if (this.lieGet === "steps") body.steps = body.steps.map((s) => ({ ...s, agt: "agt_someone_else" }));
    return this.answer(body);
  }
  async withdraw(key: string): Promise<OwnerDraftStatus> {
    this.guard();
    const d = this.byKey(key);
    if (["applying", "applied"].includes(d.state)) throw new TbError("draft_state", "applied", 409);
    d.state = "rejected";
    this.save();
    return this.status(d);
  }
  /** The owner clicks Approve in Portal. Core's rule: expiry inside the apply lock; steps run in order, the first failure stops. */
  apply(key: string, opts: { stopMidWay?: boolean } = {}): void {
    const d = this.byKey(key);
    if (this.state(d) === "expired") throw new TbError("draft_state", "expired", 409, { reason: "expired" });
    if (!["submitted", "failed"].includes(d.state)) throw new TbError("draft_state", "state", 409);
    d.state = "applying";
    d.appliedSince = this.now();
    this.save();
    if (opts.stopMidWay) return; // Core restarted here: `applying` stays until the sweep
    // Core: "An app's stop steps do not depend on each other: one agent that fails never leaves the others running". keptStatus: a re-apply skips what ran.
    let failed = false;
    for (const [n, s] of d.steps.entries()) {
      const st = d.status[n] as Draft["status"][number];
      if (st.status === "ok") continue;
      if (this.failStep === s.opId || this.failAgent === s.agt) {
        st.status = "failed";
        st.error = { code: "agent_offboarded", message: "This agent was removed." };
        failed = true;
        continue;
      }
      delete st.error;
      const a = this.data.agents[s.agt] as CoreData["agents"][string];
      this.data.rev++;
      if (s.opId === "agents.pause") {
        a.status = "paused";
        st.output = { id: s.agt, paused: true, configRevision: this.data.rev };
      } else if (s.opId === "agents.offboard") {
        st.output = { agt: s.agt, paused: true, removedEdges: a.edges, revokedConnections: a.keys, revokedCodes: 0, offboardedAt: new Date(this.now()).toISOString(), configRevision: this.data.rev };
        a.status = "paused";
        a.edges = 0;
        a.keys = 0;
        a.offboarded = true;
      } else {
        st.output = { agt: s.agt, revokedConnections: a.keys, revokedCodes: 0, configRevision: this.data.rev };
        a.keys = 0;
      }
      st.status = "ok";
    }
    d.state = failed ? "failed" : "applied";
    if (!failed) d.receiptId = `rcp_${d.id}`;
    this.save();
  }
  reject(key: string): void {
    this.byKey(key).state = "rejected";
    this.save();
  }
  open(): Draft[] {
    return this.data.drafts.filter((d) => d.state === "submitted" && this.now() < d.expiresAt);
  }
  /** What Fleet's slice shows: the delivered copy, never Core's live rows. */
  view(): SliceView {
    return {
      paused: (a) => {
        const d = this.data.delivered[a];
        return !d || d.status === "paused";
      },
      revision: () => this.revisionRead,
      topology: (): DecodedTopology | null => {
        if (!this.topologyOn) return null;
        const edges: DecodedTopology["edges"] = [];
        const connections: DecodedTopology["connections"] = [];
        for (const [agent, d] of Object.entries(this.data.delivered)) {
          for (let i = 0; i < d.edges; i++) edges.push({ agent, ins: `ins_${i}`, product: `p${i}`, crud: ["read"], mode: "free", held: [] });
          for (let i = 0; i < d.keys; i++) connections.push({ con: `con_${agent}_${i}`, agt: agent, method: "key", status: "active" });
        }
        return { instances: [], edges: this.truncated ? [] : edges, companions: [], connections: this.truncated ? [] : connections, ...(this.truncated ? { truncated: true as const } : {}) };
      },
    };
  }
}

export interface StoreRow {
  id: string;
  kind: string;
  subject: AccessItem["subject"];
  resource: string;
  level: AccessItem["level"];
  label: string;
  direction?: AccessItem["direction"];
  revocable?: boolean;
  /** a routine: paused by a revoke, the row stays. Other kinds are removed. */
  paused?: boolean;
}
export interface StoreData {
  rows: StoreRow[];
  /** the store's own copy of the slice */
  agentStatus: Record<string, "active" | "paused">;
  idem: Record<string, { digest: string; kind: "result" | "unknown" | "held"; output?: unknown; holdId?: string }>;
  holds: Record<string, "held" | "approved" | "denied">;
  /** each revoke call that reached the handler, and each item it ended: "no double action" is counted here */
  handled: string[];
  ended: string[];
  lists: number;
}

export class FakeStore {
  data: StoreData = { rows: [], agentStatus: {}, idem: {}, holds: {}, handled: [], ended: [], lists: 0 };
  /** one injected answer per call, first in, first out */
  listScript: (() => void)[] = [];
  revokeScript: { kind: "deny" | "hold" | "lie" | "fail_item" | "crash_before" | "crash_after" | "lose_answer" | "throw" | "handler_throw"; code?: string; status?: number; details?: Record<string, unknown> }[] = [];
  notShown: { kind: string; reason: string }[] = [{ kind: "held_calls", reason: "Calls that wait are kept outside." }];
  crashPoint: (name: string) => void = () => {};
  save: () => void = () => {};
  readonly product: string;
  constructor(product: string) {
    this.product = product;
  }
  add(row: StoreRow): StoreRow {
    this.data.rows.push(row);
    return row;
  }
  digestOf(r: StoreRow): string {
    return sha({ v: 1, target: this.product, id: r.id, kind: r.kind, subject: r.subject, resource: r.resource, level: r.level });
  }
  /** The store's own slice copy catches up. */
  sees(agt: string, status: "active" | "paused"): void {
    this.data.agentStatus[agt] = status;
  }
  private item(r: StoreRow): AccessItem {
    const agentPaused = r.subject.kind === "agent" && this.data.agentStatus[r.subject.id] === "paused";
    return { id: r.id, kind: r.kind, subject: r.subject, resource: r.resource, direction: r.direction ?? "held_by", level: r.level, label: r.label, state: r.paused !== undefined ? (r.paused ? "paused" : "scheduled") : agentPaused ? "paused" : "active", revocable: r.revocable ?? true, since: null, digest: this.digestOf(r) };
  }
  list(input: { subjects: { kind: string; id?: string; handles?: string[] }[]; cursor?: string }): { status: "ok"; output: unknown } {
    mustFit(LIST_IN as never, input, "access_list input");
    this.data.lists++;
    const script = this.listScript.shift();
    if (script) script();
    const rows = this.data.rows.filter((r) => input.subjects.some((s) => r.subject.kind !== "unlinked" && s.kind === r.subject.kind && s.id === r.subject.id));
    const start = input.cursor ? Number(input.cursor) : 0;
    const page = rows.slice(start, start + 2).map((r) => {
      const { since: _since, ...wire } = this.item(r);
      return wire;
    });
    const next = start + 2 < rows.length ? String(start + 2) : null;
    return { status: "ok", output: { v: 1, asOf: new Date(0).toISOString(), items: page, nextCursor: next, notShown: this.notShown, complete: next === null && this.notShown.length === 0 } };
  }
  /** SDK order: hook, then the idempotency claim, then the handler. */
  revoke(input: { plan: string; attempt: number; subject: { kind: string; id: string }; items: { id: string; digest: string }[] }, key: string): { status: "ok" | "held"; output?: unknown; holdId?: string; expiresAt?: string } {
    mustFit(REVOKE_IN as never, input, "access_revoke input");
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error(`key ${key}`);
    const inj = this.revokeScript[0];
    if (inj?.kind === "deny") {
      this.revokeScript.shift();
      throw new TbError("hook_denied", "Refused by a rule of the owner", 403);
    }
    if (inj?.kind === "throw") {
      this.revokeScript.shift();
      throw new TbError(inj.code ?? "app_error", "injected", inj.status ?? 500, inj.details);
    }
    const inputDigest = sha(input);
    const row = this.data.idem[key];
    if (row) {
      if (row.digest !== inputDigest) throw new TbError("idempotency_conflict", "other input", 409);
      if (row.kind === "result") return { status: "ok", output: row.output };
      if (row.kind === "unknown") throw new TbError("idempotency_outcome_unknown", "stopped mid-run", 409);
      const h = this.data.holds[String(row.holdId)];
      if (h === "held") return { status: "held", holdId: String(row.holdId), expiresAt: new Date(0).toISOString() };
      if (h === "denied") throw new TbError("hold_denied", "the owner denied this call", 403);
      delete this.data.idem[key]; // approved: the retry takes the key over and runs
    }
    if (inj?.kind === "hold") {
      this.revokeScript.shift();
      const holdId = `hld_${Object.keys(this.data.holds).length + 1}`;
      this.data.holds[holdId] = "held";
      this.data.idem[key] = { digest: inputDigest, kind: "held", holdId };
      this.save();
      return { status: "held", holdId, expiresAt: new Date(0).toISOString() };
    }
    this.data.idem[key] = { digest: inputDigest, kind: "unknown" };
    this.save();
    this.data.handled.push(key);
    if (inj?.kind === "handler_throw") {
      // SDK: a handler that throws frees the key. `unknown` is only for a process that died.
      this.revokeScript.shift();
      delete this.data.idem[key];
      throw new TbError(inj.code ?? "app_error", "the handler failed", inj.status ?? 500);
    }
    if (inj?.kind === "crash_before") {
      this.revokeScript.shift();
      this.save();
      this.crashPoint("store_before_effect");
      throw new TbError("temporarily_unavailable", "the store stopped", 503);
    }
    const results = input.items.map((want) => {
      const r = this.data.rows.find((x) => x.id === want.id);
      if (!r) return { id: want.id, outcome: "already_gone" as const };
      if (this.digestOf(r) !== want.digest) return { id: want.id, outcome: "changed" as const };
      if (r.revocable === false) return { id: want.id, outcome: "not_revocable" as const, code: "not_revocable" };
      if (r.subject.kind === "unlinked") return { id: want.id, outcome: "not_revocable" as const };
      if (r.subject.kind === "agent" && this.data.agentStatus[r.subject.id] !== "paused") return { id: want.id, outcome: "not_revocable" as const, code: "agent_running" };
      if (inj?.kind === "fail_item") return { id: want.id, outcome: "failed" as const, code: inj.code ?? "provider_error", detail: "The provider did not answer." };
      if (inj?.kind === "lie") return { id: want.id, outcome: "revoked" as const };
      this.data.ended.push(want.id);
      if (r.paused !== undefined) r.paused = true;
      else this.data.rows = this.data.rows.filter((x) => x.id !== want.id);
      return { id: want.id, outcome: "revoked" as const };
    });
    if (inj && ["fail_item", "lie", "crash_after", "lose_answer"].includes(inj.kind)) this.revokeScript.shift();
    this.save();
    if (inj?.kind === "crash_after") {
      this.crashPoint("store_after_effect");
      throw new TbError("temporarily_unavailable", "the store stopped", 503);
    }
    const output = { v: 1, asOf: new Date(0).toISOString(), results };
    mustFit(REVOKE_OUT as never, output, "access_revoke output");
    this.data.idem[key] = { digest: inputDigest, kind: "result", output };
    this.save();
    if (inj?.kind === "lose_answer") throw new TbError("temporarily_unavailable", "no answer", 503);
    this.crashPoint("store_answered");
    return { status: "ok", output };
  }
}

/** ctx.callApp over the fakes, with the SDK's own refusals before the network. */
export function callAppOver(stores: Record<string, FakeStore>, inbox?: { asks: { key: string; title: string; context: string }[]; down?: boolean }): (product: string, op: string, input: never, opts?: { idempotencyKey?: string }) => Promise<never> {
  return (async (product: string, op: string, input: unknown, opts?: { idempotencyKey?: string }) => {
    if (product === "inbox") {
      if (!inbox) throw new TbError("no_grant", "no grant", 403);
      if (inbox.down) throw new TbError("temporarily_unavailable", "down", 503);
      const i = input as { title: string; context: string };
      if (!inbox.asks.some((a) => a.key === opts?.idempotencyKey)) inbox.asks.push({ key: String(opts?.idempotencyKey), title: i.title, context: i.context });
      return { status: "ok", output: { itemId: "itm_1", status: "open", expiresAt: new Date(0).toISOString() } };
    }
    const store = stores[product];
    if (!store) throw new TbError("no_grant", "no grant", 403);
    if (op === "access_list") return store.list(input as never);
    if (op === "access_revoke") return store.revoke(input as never, String(opts?.idempotencyKey));
    throw new TbError("unknown_tool", op, 404);
  }) as never;
}
