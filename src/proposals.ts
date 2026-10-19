// Contact-rule proposals (C166, DESIGN §3.3, §5 "rule-draft injection", C88). Governance DRAFTS a rule from one of four
// fixed templates and sends it to Rules & Approvals as a DRAFT. It never decides: the owner approves or rejects the draft
// in Rules (Drafts page), and Governance only follows `draft_status`.
//
// What keeps this safe:
// - Only a PERSON op starts a proposal (`assertOwner`). No agent op, no hook and no timer calls `rule_draft_submit`; the
//   timer only calls `draft_status` (read). The two Rules operations Governance may call are the only two the companion
//   lists in the manifest (`RULES_OPS`), and `callRules` refuses any other name.
// - The parameters are ONE canonical agent id that is in Governance's directory, or ONE canonical handle. There is no free
//   text parameter. The `text` is a fixed English sentence plus the agent's name (or the handle); a name passes through
//   `cleanText` and is clipped. Review reasons, request text and anything else an agent wrote never reach `text`.
// - The payload is exactly `{text, rules}`. There is no source, product or name field: Rules records the VERIFIED product
//   of the calling app itself (the app cannot set it).
// - The proposal row is written first, as `failed` / `interrupted` (the truth if the process dies in the call), and its id
//   is the idempotency key of the Rules call: a retry never makes a second draft. `sent` means Rules answered a draft id,
//   and only that. A refusal, a hold or a timeout is stored with the exact error code.
import { normalizeHandle, ulid } from "@opt2-tealbrick/manifest";
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { fail } from "./store.ts";
import { cleanText } from "./text.ts";

export const TEMPLATES = ["hold_outward_for_agent", "deny_outward_for_agent", "hold_on_behalf_of_sender", "deny_on_behalf_of_sender"] as const;
export type Template = (typeof TEMPLATES)[number];
/** The only two Rules operations Governance calls (the companion in the manifest lists exactly these). */
export const RULES_OPS = ["rule_draft_submit", "draft_status"] as const;
type RulesOp = (typeof RULES_OPS)[number];
export type CallApp = OpContext["callApp"];

export type Params = { agent: string } | { handle: string };
export type RulesStatus = "pending" | "approved" | "rejected" | "gone" | "unknown";

/** A rule in the shape of `RuleSpec` in Rules' manifest (`$defs` of `rule_draft_submit.input`). */
export interface RuleSpec {
  title: string;
  description: string;
  active: true;
  priority: number;
  match: { agents: string[]; effects: ["outward"] } | { onBehalfOf: { ids: string[] } };
  outcome: { decision: "hold" | "deny"; reason: string };
}
export interface Payload {
  text: string;
  rules: RuleSpec[];
}

/** Where the draft goes in the owner's order: the owner can move it in Rules. The first matching rule decides there. */
export const RULE_PRIORITY = 100;
const NAME_MAX = 60;
const CALL_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 10_000;
const POLL_BATCH = 25;
/** `proposals_list` refreshes with this many calls at once and for at most this long (the op has a 30 s limit). */
export const LIST_POLL: PollBudget = { concurrency: 5, budgetMs: 5_000 };
const AGENT_ID = /^agt_[A-Za-z0-9]+$/;

const isAgentTemplate = (t: Template) => t.endsWith("_outward_for_agent");
const decisionOf = (t: Template): "hold" | "deny" => (t.startsWith("hold_") ? "hold" : "deny");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── building (pure) ─────────────────────────────────────────────────────────────────────────────────────────────

/** The draft for a template and ONE subject. `name` is the agent's directory name (untrusted text: cleaned and clipped here). */
export function buildPayload(template: Template, subject: { agent: string; name: string } | { handle: string }): Payload {
  const hold = decisionOf(template) === "hold";
  if ("agent" in subject) {
    const name = clip(cleanText(subject.name), NAME_MAX) || subject.agent;
    const label = `${name} (${subject.agent})`;
    return {
      text: hold ? `Hold every outward action of the agent ${label} until I approve it.` : `Refuse every outward action of the agent ${label}.`,
      rules: [
        {
          title: clip(hold ? `Hold outward actions of ${name}` : `Deny outward actions of ${name}`, 120),
          description: "Proposed by Governance. It applies to every action of this agent that reaches outside the workspace (sends a message, an email, a post).",
          active: true,
          priority: RULE_PRIORITY,
          match: { agents: [subject.agent], effects: ["outward"] },
          outcome: { decision: hold ? "hold" : "deny", reason: hold ? "Governance proposal: outward actions of this agent wait for the owner." : "Governance proposal: this agent may not act outside the workspace." },
        },
      ],
    };
  }
  const handle = subject.handle;
  return {
    text: hold ? `Hold every action an agent takes on behalf of the sender ${handle} until I approve it.` : `Refuse every action an agent takes on behalf of the sender ${handle}.`,
    rules: [
      {
        title: clip(hold ? `Hold actions for sender ${handle}` : `Deny actions for sender ${handle}`, 120),
        description: "Proposed by Governance. It applies when an agent acts for a message from this sender. The sender is only a claim that the agent passes on and is not verified, so this rule can add a hold or a refusal and never grants anything.",
        active: true,
        priority: RULE_PRIORITY,
        match: { onBehalfOf: { ids: [handle] } },
        outcome: { decision: hold ? "hold" : "deny", reason: hold ? "Governance proposal: actions for this sender wait for the owner." : "Governance proposal: this sender may not use your agents." },
      },
    ],
  };
}

/** The canonical parameters, or a 400/404 with a plain code. The agent must be in the directory; the handle is canonicalized by the shared `normalizeHandle`. */
export function parseParams(db: Db, template: Template, params: Record<string, unknown>): { params: Params; subject: { agent: string; name: string } | { handle: string } } {
  if (!(TEMPLATES as readonly string[]).includes(template)) fail("template_invalid", "unknown template", 400);
  const keys = Object.keys(params);
  const want = isAgentTemplate(template) ? "agent" : "handle";
  if (keys.length !== 1 || keys[0] !== want) fail("params_invalid", `this template takes exactly one parameter: ${want}`, 400);
  const raw = params[want];
  if (typeof raw !== "string") fail("params_invalid", `${want} must be a string`, 400);
  if (want === "agent") {
    const id = String(raw);
    if (id.length > 64 || !AGENT_ID.test(id)) fail("params_invalid", "not an agent id", 400);
    const a = db.prepare("SELECT id, name FROM fleet_agents WHERE id = ? AND status <> 'removed'").get(id);
    if (!a) fail("agent_not_found", "no workspace agent with this id", 404);
    return { params: { agent: id }, subject: { agent: id, name: String(a?.name) } };
  }
  const handle = normalizeHandle(String(raw)) ?? fail("handle_invalid", "not a buzz, slack or telegram handle", 400);
  return { params: { handle }, subject: { handle } };
}

// ── the Rules calls ─────────────────────────────────────────────────────────────────────────────────────────────

/** The one gate to Rules: only the two operations the companion declares. */
export function callRules(callApp: CallApp, op: RulesOp, input: Json, key: string | undefined, timeoutMs: number): ReturnType<CallApp> {
  if (!(RULES_OPS as readonly string[]).includes(op)) throw new TbError("op_not_allowed", "Governance calls only rule_draft_submit and draft_status in Rules", 500);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TbError("timeout", "Rules did not answer in time", 504)), timeoutMs);
    timer.unref();
  });
  return Promise.race([callApp("rules", op, input, key ? { idempotencyKey: key } : undefined), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Rules ANSWERED with a refusal, so no draft exists (S3-2): a 4xx from the call, except 408 (timeout) and 409 (the same
 * idempotency key may still be in flight, so a draft may exist). A transport error, a timeout, a 5xx or a hold is not final.
 */
export const isFinalRefusal = (e: unknown): boolean => {
  const s = e instanceof TbError ? e.httpStatus : (e as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof s === "number" && s >= 400 && s < 500 && s !== 408 && s !== 409 && codeOf(e) !== "timeout";
};

/** The exact code of a failure (never the upstream text). */
const codeOf = (e: unknown): string => {
  const c = e instanceof TbError ? e.code : (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[a-z0-9_.:-]{1,60}$/i.test(c) ? c : "transport_error";
};

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const iso = (ms: unknown) => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown) => (ms === null || ms === undefined ? null : iso(ms));

export interface Proposal {
  id: string;
  template: Template;
  params: Params;
  text: string;
  review: string | null;
  rulesDraftId: string | null;
  status: "sent" | "held" | "failed";
  error: string | null;
  rulesStatus: RulesStatus | null;
  decidedAt: string | null;
  createdAt: string;
}
const toProposal = (r: Row): Proposal => ({
  id: String(r.id),
  template: r.template as Template,
  params: JSON.parse(String(r.params_json)) as Params,
  text: String(r.text),
  review: r.review_id === null ? null : String(r.review_id),
  rulesDraftId: r.rules_draft_id === null ? null : String(r.rules_draft_id),
  status: r.status as Proposal["status"],
  error: r.error === null ? null : String(r.error),
  rulesStatus: (r.rules_status as RulesStatus | null) ?? null,
  decidedAt: isoOrNull(r.rules_decided_at),
  createdAt: iso(r.created_at),
});
const getRow = (db: Db, id: string): Row => db.prepare("SELECT * FROM fleet_proposals WHERE id = ?").get(id) as Row;

// ── send ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SendInput {
  template: Template;
  params: Record<string, unknown>;
  review?: string;
}

/**
 * Drafts the rule and sends it. Returns the proposal (`sent`, `held` or `failed`) and `duplicate: true` when the same
 * template and parameters already wait in Rules (no second draft). The same template and parameters after a failure with no
 * clear answer, or after a hold, RETRY the same proposal: same id, so the same idempotency key, so Rules never holds two
 * drafts. After a FINAL refusal (Rules answered no; `error_final`) a new proposal is built from the current directory, so a
 * permanent failure never blocks the owner (S3-2); the failed row stays in the list.
 */
export async function sendProposal(db: Db, callApp: CallApp, by: string, input: SendInput, now = Date.now(), timeoutMs = CALL_TIMEOUT_MS): Promise<{ proposal: Proposal; duplicate: boolean }> {
  const { params, subject } = parseParams(db, input.template, input.params);
  if (input.review !== undefined && !db.prepare("SELECT 1 FROM fleet_reviews WHERE id = ? AND status = 'done'").get(input.review)) fail("review_not_found", "no recorded review with this id", 404);
  const payload = buildPayload(input.template, subject);
  const paramsJson = JSON.stringify(params);

  // select + insert are one synchronous step: two tabs cannot both create a row
  const { id, duplicate } = db.transaction(() => {
    const open = db
      .prepare(
        "SELECT id, status FROM fleet_proposals WHERE template = ? AND params_json = ? AND ((status <> 'sent' AND error_final = 0) OR rules_status IN ('pending', 'unknown')) ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(input.template, paramsJson);
    if (open) return { id: String(open.id), duplicate: open.status === "sent" };
    const fresh = `prp_${ulid(now)}`;
    db.prepare(
      `INSERT INTO fleet_proposals (id, template, params_json, text, rules_json, status, error, review_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'failed', 'interrupted', ?, ?, ?, ?)`,
    ).run(fresh, input.template, paramsJson, payload.text, JSON.stringify(payload.rules), input.review ?? null, by, now, now);
    return { id: fresh, duplicate: false };
  });
  if (duplicate) return { proposal: toProposal(getRow(db, id)), duplicate: true };

  // what is sent is what is stored (a retry sends the first text, whatever the agent is called now)
  const row = getRow(db, id);
  const sending: Payload = { text: String(row.text), rules: JSON.parse(String(row.rules_json)) as RuleSpec[] };
  await attempt(db, callApp, id, sending, timeoutMs);
  return { proposal: toProposal(getRow(db, id)), duplicate: false };
}

/** One call to `rule_draft_submit` and ONE write of the outcome. The payload has exactly the keys `text` and `rules`. */
async function attempt(db: Db, callApp: CallApp, id: string, payload: Payload, timeoutMs: number): Promise<void> {
  const write = (status: "sent" | "held" | "failed", f: { error?: string; draftId?: string; final?: boolean }) => {
    const now = Date.now();
    db.prepare(
      `UPDATE fleet_proposals SET status = ?, error = ?, error_final = ?, rules_draft_id = ?, rules_status = ?, rules_checked_at = ?, updated_at = ? WHERE id = ? AND status <> 'sent'`,
    ).run(status, status === "sent" ? null : (f.error ?? "error"), f.final === true ? 1 : 0, f.draftId ?? null, status === "sent" ? "pending" : null, status === "sent" ? now : null, now, id);
  };
  try {
    const r = await callRules(callApp, "rule_draft_submit", { text: payload.text, rules: payload.rules as unknown as Json }, id, timeoutMs);
    if (r.status === "held") return write("held", { error: "held" });
    const out = r.output as { draftId?: unknown; status?: unknown } | null;
    if (!out || typeof out.draftId !== "string" || out.draftId.length < 1 || out.draftId.length > 64 || out.status !== "pending") return write("failed", { error: "bad_answer" });
    write("sent", { draftId: out.draftId });
  } catch (e) {
    write("failed", { error: codeOf(e), final: isFinalRefusal(e) });
  }
}

// ── status from Rules (never an approval) ───────────────────────────────────────────────────────────────────────

/** How `pollStatuses` spends its time. The default is one call at a time with no overall limit (the 60 s timer). */
export interface PollBudget {
  /** calls in flight at once, after the first one has shown that Rules answers */
  concurrency?: number;
  /** after this many ms the function returns; drafts not asked in time keep their last stored status */
  budgetMs?: number;
}

/**
 * Asks Rules about sent drafts that are not decided (`draft_status`, read). A decided draft is final. An answer that does
 * not come leaves the draft `unknown`, never `approved`. Stops at the first transport failure (no 25 timeouts in a row):
 * the first draft is asked alone, the rest only if Rules answered it. With `budget`, the rest run in parallel and the whole
 * refresh ends at `budgetMs`: a draft that was ASKED and got no answer by then is `unknown` (N1: a hanging Rules is not
 * shown as `pending`); a draft not asked yet keeps its stored status; an answer that comes later is dropped.
 * Called by `proposals_list` and by the 60 s timer; never by a hook; it can only call `draft_status`.
 */
export async function pollStatuses(db: Db, callApp: CallApp, now = Date.now(), timeoutMs = POLL_TIMEOUT_MS, budget: PollBudget = {}): Promise<number> {
  const open = db
    .prepare("SELECT id, rules_draft_id FROM fleet_proposals WHERE status = 'sent' AND rules_status IN ('pending', 'unknown') ORDER BY COALESCE(rules_checked_at, 0), id LIMIT ?")
    .all(POLL_BATCH);
  const set = db.prepare("UPDATE fleet_proposals SET rules_status = ?, rules_decided_at = ?, rules_checked_at = ?, updated_at = ? WHERE id = ? AND rules_status IN ('pending', 'unknown')");
  let changed = 0;
  let halted = false; // Rules did not answer: ask no further draft
  let expired = false; // the budget is spent: write nothing more
  let at = 0;
  const asked = new Set<string>(); // in flight: asked, no answer yet
  const one = async (p: (typeof open)[number]): Promise<void> => {
    asked.add(String(p.id));
    try {
      const r = await callRules(callApp, "draft_status", { draftId: String(p.rules_draft_id) }, undefined, timeoutMs);
      if (expired) return;
      const out = r.status === "ok" ? (r.output as { status?: unknown; decidedAt?: unknown }) : null;
      const status = out?.status;
      if (status === "pending" || status === "approved" || status === "rejected") {
        const decided = typeof out?.decidedAt === "string" && !Number.isNaN(Date.parse(out.decidedAt)) ? Date.parse(out.decidedAt) : status === "pending" ? null : now;
        changed += set.run(status, decided, now, now, p.id).changes > 0 && status !== "pending" ? 1 : 0;
      } else {
        set.run("unknown", null, now, now, p.id);
        halted = true;
      }
    } catch (e) {
      if (expired) return;
      // Rules no longer knows the draft: say so. Any other failure: unknown, and stop (Rules or the bridge is not answering).
      const gone = codeOf(e) === "not_found";
      set.run(gone ? "gone" : "unknown", null, now, now, p.id);
      if (!gone) halted = true;
    } finally {
      asked.delete(String(p.id));
    }
  };
  const lane = async (): Promise<void> => {
    while (!halted && !expired && at < open.length) await one(open[at++] as (typeof open)[number]);
  };
  const work = async (): Promise<void> => {
    if (open[0]) await one(open[at++] as (typeof open)[number]); // one call alone first: a Rules that is down costs one timeout, not one per lane
    await Promise.all(Array.from({ length: Math.max(1, budget.concurrency ?? 1) }, lane));
  };
  if (budget.budgetMs === undefined) {
    await work();
  } else {
    let timer: NodeJS.Timeout | undefined;
    const spent = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget.budgetMs);
    });
    try {
      await Promise.race([work(), spent]);
    } finally {
      expired = true;
      clearTimeout(timer);
      for (const id of asked) set.run("unknown", null, now, now, id); // asked, no answer inside the budget (N1)
    }
  }
  return changed;
}

/** The 60 s timer (C85): refresh the status of sent drafts. It calls `draft_status` only. Returns the stop function. */
export function startProposalTimer(db: Db, callApp: CallApp, log: { warn(msg: string, f?: Record<string, never>): void }, everyMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollStatuses(db, callApp);
    } catch (e) {
      log.warn("proposal status poll failed");
      void e;
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), everyMs);
  t.unref();
  return () => clearInterval(t);
}

// ── list ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function listProposals(db: Db, q: { cursor?: string; limit?: number }): { proposals: Proposal[]; nextCursor: string | null } {
  const limit = Math.min(q.limit ?? 50, 200);
  const rows = db.prepare(`SELECT * FROM fleet_proposals ${q.cursor ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`).all(...[...(q.cursor ? [q.cursor] : []), limit + 1]);
  const page = rows.slice(0, limit);
  return { proposals: page.map(toProposal), nextCursor: rows.length > limit ? String(page[page.length - 1]?.id) : null };
}

/** Only the owner (a person) starts or reads proposals. An agent or an app gets `no_access`. */
export function assertOwner(caller: { type: string }): void {
  if (caller.type !== "person") throw new TbError("no_access", "contact rules are for the owner only", 403);
}
