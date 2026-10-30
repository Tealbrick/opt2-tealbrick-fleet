// The plan runner (C380, DESIGN-C380 §5): one tick of one plan. It asks Core for the owner's approval, reads Core back, and ends access in each store.
// Rules of this file:
// - Nothing is done until proved by its owner: a Core step by the slice, a store item by a fresh list. A store's "revoked" is only `claimed`.
// - No check-then-write across an await: each write after a call is a compare-and-set, and it loses to whoever moved the row first.
// - Attempt and key are persisted before the call. A new attempt comes only after a fresh list, with the items still open. A held step keeps its key.
// - Everything lives in the tables, so a tick that dies anywhere is resumed by the next tick, in this process or the next one.
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessTarget } from "../access/items.ts";
import { LIST_LIMITS, personSubject, storeItems } from "../access/items.ts";
import { lastSweepAt } from "../access/sweep.ts";
import { HANDLE_PATTERN } from "../feed.ts";
import { loadSubject } from "../lifecycle/transitions.ts";
import { type AccessItem, type AccessPort, type ListSubject, revokeBatchMax } from "./access-port.ts";
import { type AlertPort, alertOnce, retryPendingAlerts } from "./alerts.ts";
import { askRail, type OwnerDraftGetResult, type OwnerDraftsApi, proveCoreStep, readableDraft, type SliceView } from "./core-rail.ts";
import { addStep, type CoreOp, getPlan, movePlan, moveStep, notePlan, OPEN_SQL, type Row, recordPlan, stepsOf, type Tick } from "./plan.ts";
import { APPLYING_STUCK_MS, DRAFT_TITLE, ENDS_BY_PAUSE, FAST_WINDOW_MS, HOLD_RECHECK_MS, isFinalStep, isOpenPlan, LIST_BACKOFF_MS, MANY_PLANS, MAX_TRIES, POLL_FAST_MS, POLL_SLOW_MS, stateFromSteps, stuckStep, TICK_LEASE_MS } from "./steps.ts";

export interface PlanCtx {
  db: Db;
  rail: OwnerDraftsApi | null;
  access: AccessPort;
  slice: SliceView;
  alerts: AlertPort;
  now(): number;
  /** Set when 3 or more plans are open: one full read serves them all, and the ticks read a store only when that decides a step. */
  sweep?: (() => void) | undefined;
  /** Starts one full read of the stores; a running one is enough. */
  startSweep?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
  warn(msg: string, fields?: Record<string, string>): void;
}

const CORE_STEP_OPEN: readonly string[] = ["pending", "pending_bridge", "failed"];
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The subject moved after the owner confirmed: no app step (§5 "Stale"). */
function moved(db: Db, p: Row): boolean {
  const s = loadSubject(db, p.subject_kind as "person" | "agent", String(p.subject_id));
  return !s || s.rev !== Number(p.lifecycle_rev);
}

export function cancelUnsent(db: Db, id: string, now: number): void {
  for (const s of stepsOf(db, id)) {
    if (s.phase === "read") continue;
    if (s.state === "pending" || s.state === "not_revocable") moveStep(db, s, "cancelled", {}, now);
  }
}

/** A plan that ended runs nothing more: its steps must not read as waiting for anyone. */
function endPlan(pc: PlanCtx, id: string, from: string, to: string, fields: Record<string, string | number | null>, now: number): boolean {
  const moved = movePlan(pc.db, id, from, to, fields, now);
  if (moved) cancelUnsent(pc.db, id, now);
  return moved;
}

// ── Core ────────────────────────────────────────────────────────────────────

function toLinkMode(pc: PlanCtx, p: Row, code: string): void {
  const now = pc.now();
  // Core stored nothing under this key: no draft to read or take back.
  notePlan(pc.db, String(p.id), String(p.state), { rail: "portal_link", rail_code: code, draft_key: null }, now);
  movePlan(pc.db, String(p.id), "preparing", "waiting", {}, now);
}

async function askForDraft(pc: PlanCtx, p: Row, steps: readonly Row[]): Promise<void> {
  const id = String(p.id);
  const rail = pc.rail;
  if (!rail) return toLinkMode(pc, p, "no_sdk");
  const now = pc.now();
  // Persisted before the call. The same key with the same steps answers the same draft, so a lost answer loses nothing.
  let key = str(p.draft_key);
  if (key === null) {
    const attempt = Number(p.draft_attempt) + 1;
    key = `${id}:${attempt}`;
    if (!notePlan(pc.db, id, "preparing", { draft_key: key, draft_attempt: attempt, issued_at: now }, now)) return;
  }
  const part = Number(p.parts) > 1 ? ` (part ${Number(p.part)} of ${Number(p.parts)})` : "";
  const answer = await askRail(() =>
    rail.request({
      key: key as string,
      title: `${DRAFT_TITLE}${part}`,
      planDigest: String(p.plan_digest),
      expiresInSec: Number(p.expires_in_sec),
      steps: steps.filter((s) => s.phase === "core").map((s) => ({ opId: s.op as CoreOp, agt: String(s.agent_id) })),
    }),
  );
  const at = pc.now();
  switch (answer.kind) {
    case "ok":
      // The owner cancelled while this call ran: no draft may stay open in Portal with no plan behind it.
      if (getPlan(pc.db, id)?.draft_key !== key || !movePlan(pc.db, id, "preparing", "waiting", { draft_id: answer.value.draftId, draft_state: answer.value.state, review_url: answer.value.reviewUrl, code: null, detail: null }, at)) await askRail(() => rail.withdraw(key as string));
      return;
    case "off":
      return toLinkMode(pc, p, answer.code);
    case "consent":
      return toLinkMode(pc, p, "topology_consent");
    case "full":
      notePlan(pc.db, id, "preparing", { code: "owner_drafts_full" }, at);
      return;
    case "wait":
      // The owner cancelled while this call ran, and its answer was lost: the draft may stand in Portal with no plan behind it.
      if (!notePlan(pc.db, id, "preparing", { code: answer.code }, at)) await askRail(() => rail.withdraw(key as string));
      return;
    case "draft_state":
      endPlan(pc, id, "preparing", "failed", { code: "draft_state" }, at);
      return;
    case "unknown_key":
    case "refused":
      endPlan(pc, id, "preparing", "failed", { code: answer.kind === "refused" ? answer.code : "unknown_key", detail: answer.kind === "refused" ? answer.message : null }, at);
      return;
  }
}

/** The answer must be about exactly the steps we sent. Anything else stops the plan: nothing is proved by another draft. */
function sameSteps(get: OwnerDraftGetResult, steps: readonly Row[]): boolean {
  const core = steps.filter((s) => s.phase === "core");
  if (get.steps.length !== core.length) return false;
  const want = new Set(core.map((s) => `${String(s.op)} ${String(s.agent_id)}`));
  return get.steps.every((g) => want.has(`${g.opId} ${g.agt}`));
}

function applyCoreSteps(pc: PlanCtx, get: OwnerDraftGetResult, steps: readonly Row[]): void {
  const now = pc.now();
  for (const g of get.steps) {
    const s = steps.find((x) => x.phase === "core" && x.op === g.opId && x.agent_id === g.agt);
    if (!s || !CORE_STEP_OPEN.includes(String(s.state))) continue;
    if (g.status === "ok") {
      const output = (g.output !== null && typeof g.output === "object" ? g.output : {}) as Record<string, unknown>;
      const proof = proveCoreStep(String(s.op), String(s.agent_id), output, pc.slice);
      const cfg = typeof output.configRevision === "number" ? output.configRevision : null;
      const state = proof.state === "pending" ? "pending_bridge" : proof.state;
      // A new key may pair on the agent before the slice shows the old one gone. Past the window, Core's word stays what it is: said, not seen.
      const late = s.op === "agents.rotate" && state === "pending_bridge" && s.state === "pending_bridge" && now - Number(s.updated_at) > FAST_WINDOW_MS;
      if (late) moveStep(pc.db, s, "reported", { detail: `Core says removed ${Number(output.revokedConnections ?? 0)} connections. The agent may have a new key already, so Governance cannot tell.` }, now);
      else if (s.state !== state || s.code !== null) moveStep(pc.db, s, state, { output_json: JSON.stringify(output).slice(0, 2000), config_revision: cfg, detail: proof.detail, code: null, tries: 0 }, now);
    } else if (g.status === "failed") {
      // Only the owner re-applies a failed draft: the job does not retry it.
      moveStep(pc.db, s, "failed", { code: (g.error?.code ?? "core_failed").slice(0, 64), detail: (g.error?.message ?? "").slice(0, 200), tries: MAX_TRIES }, now);
    } else if (s.state === "failed") {
      moveStep(pc.db, s, "pending", { code: null, detail: null, tries: 0 }, now);
    }
  }
}

/** Reads the draft and moves the plan to what Core says. No readable answer moves nothing. */
async function syncDraft(pc: PlanCtx, p: Row, steps: readonly Row[]): Promise<void> {
  const id = String(p.id);
  const rail = pc.rail;
  if (!rail || p.draft_key === null) return;
  const key = String(p.draft_key);
  const answer = await askRail(() => rail.get(key));
  const now = pc.now();
  const state = String(p.state);
  if (answer.kind === "off") {
    if (p.rail !== "portal_link") notePlan(pc.db, id, state, { rail: "portal_link", rail_code: answer.code }, now);
    return;
  }
  if (answer.kind === "unknown_key") {
    // After a restore of Core, or a key Core never stored. The owner cannot approve what Core does not hold. A draft we saw applied stays applied: the slice proves the rest.
    if (isAppliedHere(p)) notePlan(pc.db, id, state, { rail: "portal_link", rail_code: "unknown_key" }, now);
    else endPlan(pc, id, state, "lost", { code: "unknown_key" }, now);
    return;
  }
  if (answer.kind !== "ok" || !readableDraft(answer.value)) {
    notePlan(pc.db, id, state, { code: answer.kind === "ok" ? "bad_answer" : answer.kind === "wait" ? answer.code : answer.kind }, now);
    return;
  }
  const get = answer.value;
  if ((p.core_digest !== null && p.core_digest !== get.digest) || !sameSteps(get, steps)) {
    endPlan(pc, id, state, "failed", { code: "core_mismatch", detail: "Portal answered about other steps. Nothing more runs. Open Portal and check." }, now);
    return;
  }
  // Applied after all: the note about a cancel that did not reach Portal has said what it could.
  const fields = { ...(get.state === "applied" ? { close_note: null } : {}), draft_id: get.draftId, draft_state: get.state, review_url: get.reviewUrl, core_digest: get.digest, expires_at: get.expiresAt ? Date.parse(get.expiresAt) : null, code: null, rail: "draft", rail_code: null };
  switch (get.state) {
    case "open":
    case "submitted":
      movePlan(pc.db, id, state, "waiting", { ...fields, applying_since: null }, now);
      return;
    case "applying":
      movePlan(pc.db, id, state, "applying", { ...fields, applying_since: p.applying_since === null ? now : Number(p.applying_since) }, now);
      return;
    case "applied":
      if (movePlan(pc.db, id, state, "running", { ...fields, applying_since: null, applied_at: p.applied_at === null ? now : Number(p.applied_at), ...(get.receiptId ? { receipt_id: get.receiptId } : {}) }, now) && p.draft_state !== "applied") recordPlan(pc.db, id, "The owner approved this in Portal, and Core applied it.", now);
      applyCoreSteps(pc, get, steps);
      return;
    case "failed":
      // S2-11: Core moved a stuck apply to failed, or a step failed. The owner re-applies; the steps that ran stay.
      movePlan(pc.db, id, state, "partial", { ...fields, applying_since: null, code: "core_failed" }, now);
      applyCoreSteps(pc, get, steps);
      return;
    case "rejected":
    case "expired": {
      // A draft that failed part-way can end like this. What Core did stays on the record, and the page does not say "nothing was applied".
      applyCoreSteps(pc, get, steps);
      const partly = get.steps.some((g) => g.status === "ok");
      endPlan(pc, id, state, get.state, { ...fields, code: partly ? "partly_applied" : null }, now);
      return;
    }
  }
}

/** Core's own answer, kept: `applied` with Core's digest is the only thing that opens the steps that wait for it. */
export const isAppliedHere = (p: Row): boolean => p.draft_state === "applied" && p.core_digest !== null;

/** Portal link mode: Core says nothing, so the slice alone moves a step. */
function proveFromSlice(pc: PlanCtx, steps: readonly Row[]): void {
  const now = pc.now();
  for (const s of steps) {
    if (s.phase !== "core" || isFinalStep(String(s.state))) continue;
    const proof = proveCoreStep(String(s.op), String(s.agent_id), undefined, pc.slice);
    if (proof.state !== s.state) moveStep(pc.db, s, proof.state, { detail: proof.detail }, now);
  }
  // A pause in Portal is not an approval to end what the agent holds, when Governance cannot see that the owner removed its access: someone acts by hand.
  const unseen = new Set(stepsOf(pc.db, String(steps[0]?.plan_id)).filter((s) => s.phase === "core" && s.state === "not_provable").map((s) => String(s.agent_id)));
  for (const s of steps) if (s.phase === "after" && s.state === "pending" && unseen.has(String(s.agent_id))) moveStep(pc.db, s, "manual", { code: "not_approved" }, now);
}

// ── Stores ──────────────────────────────────────────────────────────────────

const coreAgents = (steps: readonly Row[]): string[] => [...new Set(steps.filter((s) => s.phase === "core").map((s) => String(s.agent_id)))];

/** A person with more handles than one subject may carry is asked about in several: a handle left out would keep its bar off. */
function personSubjects(db: Db, id: string): ListSubject[] {
  const all = db.prepare("SELECT handle FROM fleet_handles WHERE person_id = ? ORDER BY handle").all(id).map((r) => String(r.handle)).filter((h) => HANDLE_PATTERN.test(h) && normalizeHandle(h) === h);
  if (all.length <= LIST_LIMITS.handles) return [personSubject(db, id)];
  const out: ListSubject[] = [];
  for (let i = 0; i < all.length; i += LIST_LIMITS.handles) out.push({ kind: "person", id, handles: all.slice(i, i + LIST_LIMITS.handles) });
  return out;
}

function subjectsOf(db: Db, p: Row, steps: readonly Row[]): ListSubject[] {
  const out: ListSubject[] = coreAgents(steps).map((id) => ({ kind: "agent", id }));
  if (p.subject_kind === "person" && Number(p.part) === 1) out.push(...personSubjects(db, String(p.subject_id)));
  if (p.subject_kind === "agent" && !out.some((s) => s.kind === "agent" && s.id === p.subject_id)) out.push({ kind: "agent", id: String(p.subject_id) });
  return out;
}

const parseTicks = (p: Row): Tick[] | null => (typeof p.wanted_json === "string" ? (JSON.parse(p.wanted_json) as Tick[]) : null);

/** §2 "Agent's things": what a stop ends unless the owner ticked otherwise. A suspension keeps accounts; `about` is off by default. */
function endsByDefault(purpose: string, item: AccessItem): boolean {
  if (item.direction === "about") return false;
  if (purpose === "leave" || purpose === "bar") return true;
  if (purpose === "suspend") return item.kind === "routine" || item.kind === "scheduled_post";
  return false;
}

/** Turns what a store lists into steps, once per item. The port already dropped items of someone we did not ask about. */
function absorb(pc: PlanCtx, p: Row, target: string, items: readonly AccessItem[]): void {
  const db = pc.db;
  const now = pc.now();
  const id = String(p.id);
  const ticks = parseTicks(p);
  db.transaction(() => {
    // Closed during the list: no new step.
    if (!isOpenPlan(String(getPlan(db, id)?.state))) return;
    let n = Number(db.prepare("SELECT COALESCE(MAX(n), -1) + 1 AS n FROM fleet_plan_steps WHERE plan_id = ?").get(id)?.n);
    for (const item of items) {
      if (item.subject.kind === "unlinked" || (p.purpose === "bar" && item.kind !== "channel_sender")) continue;
      const { kind: subjectKind, id: subjectId } = item.subject;
      if (db.prepare("SELECT 1 FROM fleet_plan_steps WHERE plan_id = ? AND target = ? AND item_id = ?").get(id, target, item.id)) continue;
      const tick = ticks?.find((t) => t.product === target && t.id === item.id);
      const wanted = ticks ? tick !== undefined : endsByDefault(String(p.purpose), item);
      const phase = subjectKind === "person" || p.rail === "none" ? "now" : "after";
      const ref = { id: item.id, kind: item.kind, digest: item.digest, label: item.label };
      let state = "pending";
      let code: string | null = null;
      if (!item.revocable) state = item.level === "info" ? "listed" : "manual";
      // The owner confirmed nothing in a plan the system opened: what needs a confirm waits for a plan he makes. Only what stands on his approval in Portal runs.
      else if (!wanted || (phase === "now" && p.trigger_kind === "system")) state = "listed";
      else if (tick?.digest !== undefined && tick.digest !== item.digest) {
        state = "changed";
        code = "changed_since_preview";
      }
      addStep(db, id, n++, { phase, target, op: "access_revoke", agent: subjectKind === "agent" ? subjectId : null, subject: { kind: subjectKind, id: subjectId }, item: ref, state, code }, now);
    }
  });
}

/** A fresh list decides each open step. Absent proves the end, unless this version cannot list that kind. */
function prove(pc: PlanCtx, steps: readonly Row[], items: readonly AccessItem[], notShown: readonly string[]): void {
  const now = pc.now();
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const s of steps) {
    const it = byId.get(String(s.item_id));
    if (!it) {
      if (notShown.includes(String(s.item_kind))) {
        if (s.state === "claimed") moveStep(pc.db, s, "reported", { detail: "The app says this ended. This version cannot list it." }, now);
        continue;
      }
      if (moveStep(pc.db, s, "done", { code: s.state === "pending" ? "already_gone" : null, detail: null }, now)) pc.db.prepare("DELETE FROM fleet_access_items WHERE target = ? AND item_id = ?").run(String(s.target), String(s.item_id));
      continue;
    }
    if (it.digest !== s.item_digest) {
      moveStep(pc.db, s, "changed", { code: "changed" }, now);
      continue;
    }
    if (ENDS_BY_PAUSE.includes(it.kind) && it.state === "paused") {
      moveStep(pc.db, s, "done", { code: s.state === "pending" ? "already_gone" : null, detail: null }, now);
      continue;
    }
    if (s.state === "claimed") moveStep(pc.db, s, "failed", { code: "still_listed", detail: "The app says this ended, but it still lists it." }, now);
    else if (s.state === "sending") moveStep(pc.db, s, "failed", { code: s.code === null ? "outcome_unknown" : String(s.code) }, now);
    else if (!it.revocable && s.state !== "failed") moveStep(pc.db, s, "manual", {}, now);
  }
}

const sendable = (s: Row, now: number): boolean => (s.state === "pending" || s.state === "not_revocable" || s.state === "failed") && !stuckStep(s as never) && Number(s.retry_at) <= now;

/** Persist first, in one transaction: `sending`, attempt, key. A step that moved meanwhile cancels this batch. */
function claimBatch(pc: PlanCtx, p: Row, target: string, batch: readonly Row[], now: number): { key: string; attempt: number } | null {
  const db = pc.db;
  const attempt = Math.max(...batch.map((s) => Number(s.attempt))) + 1;
  const num = Number(db.prepare("SELECT COALESCE(MAX(batch), 0) + 1 AS b FROM fleet_plan_steps WHERE plan_id = ? AND target = ?").get(String(p.id), target)?.b);
  const key = `${String(p.id)}:${target}:${num}:${attempt}`;
  try {
    db.transaction(() => {
      for (const s of batch) {
        const ok = db.prepare("UPDATE fleet_plan_steps SET state = 'sending', attempt = ?, batch = ?, key = ?, tries = tries + 1, code = NULL, detail = NULL, updated_at = ? WHERE id = ? AND state = ? AND attempt = ?").run(attempt, num, key, now, String(s.id), String(s.state), Number(s.attempt));
        if (ok.changes !== 1) throw new Error("batch_moved");
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "batch_moved") return null;
    throw e;
  }
  return { key, attempt };
}

async function sendBatch(pc: PlanCtx, p: Row, target: string, rows: readonly Row[], key: string, attempt: number, from: "sending" | "waiting" = "sending"): Promise<void> {
  const first = rows[0] as Row;
  const answer = await pc.access.revoke(target as AccessTarget, { v: 1, plan: String(p.id), attempt, subject: { kind: first.subject_kind as "agent" | "person", id: String(first.subject_id) }, items: rows.map((s) => ({ id: String(s.item_id), digest: String(s.item_digest) })) }, key);
  const now = pc.now();
  // Compare-and-set on what was claimed: a step an op moved during the call stays as the op left it.
  const cur = (s: Row): Row => ({ id: s.id, state: from, attempt });
  switch (answer.kind) {
    case "held":
      for (const s of rows) moveStep(pc.db, cur(s), "waiting", { hold_id: answer.holdId, retry_at: now + HOLD_RECHECK_MS, code: null }, now);
      return;
    case "refused":
      for (const s of rows) moveStep(pc.db, cur(s), "refused", { code: answer.code, detail: answer.reason }, now);
      return;
    case "conflict":
      for (const s of rows) moveStep(pc.db, cur(s), "failed", { code: answer.code }, now);
      return;
    case "unknown":
      // The call may have run. `sending` stays: the next fresh list tells, and only then a new attempt.
      for (const s of rows) pc.db.prepare("UPDATE fleet_plan_steps SET code = ?, retry_at = ?, updated_at = ? WHERE id = ? AND state = ? AND attempt = ?").run(answer.code, answer.afterMs === null ? (from === "waiting" ? now + HOLD_RECHECK_MS : 0) : now + answer.afterMs, now, String(s.id), from, attempt);
      return;
    case "ok": {
      const byId = new Map(answer.results.map((r) => [r.id, r]));
      for (const s of rows) {
        const r = byId.get(String(s.item_id));
        if (!r) moveStep(pc.db, cur(s), "failed", { code: "no_result" }, now);
        else if (r.outcome === "revoked" || r.outcome === "already_gone") moveStep(pc.db, cur(s), "claimed", { code: r.outcome === "already_gone" ? "already_gone" : null, output_json: answer.receiptId ? JSON.stringify({ receiptId: answer.receiptId }) : null }, now);
        else if (r.outcome === "changed") moveStep(pc.db, cur(s), "changed", { code: r.code ?? "changed", detail: r.detail ?? null }, now);
        else if (r.outcome === "not_revocable") {
          // agent_running: the store waits for the agent to stop. With no Core step nothing will stop it, so someone acts by hand.
          if (r.code === "agent_running" && p.rail !== "none") moveStep(pc.db, cur(s), "not_revocable", { code: r.code }, now);
          else moveStep(pc.db, cur(s), "manual", { code: r.code ?? "not_revocable", detail: r.detail ?? null }, now);
        } else moveStep(pc.db, cur(s), "failed", { code: r.code ?? "failed", detail: r.detail ?? null }, now);
      }
      return;
    }
  }
}

function openToSend(pc: PlanCtx, p: Row, steps: readonly Row[], phases: readonly string[], target: string): Row[] {
  const now = pc.now();
  const core = steps.filter((s) => s.phase === "core");
  const approved = isAppliedHere(p);
  return steps.filter((s) => {
    if (s.target !== target || !phases.includes(String(s.phase)) || s.op !== "access_revoke" || !sendable(s, now)) return false;
    if (s.phase !== "after") return true;
    // Only for an agent the slice shows stopped. The store's own check is the second line. With no draft applied, only what the slice proved counts.
    const own = core.filter((c) => c.agent_id === s.agent_id);
    return own.length > 0 && own.every((c) => (approved ? isFinalStep(String(c.state)) : c.state === "done"));
  });
}

/** One store, one tick: list, prove, send what is still open, list again. */
async function runTarget(pc: PlanCtx, p: Row, target: string, phases: readonly string[]): Promise<void> {
  const id = String(p.id);
  const db = pc.db;
  const load = () => stepsOf(db, id);
  const steps = load();
  const read = steps.find((s) => s.phase === "read" && s.target === target) as Row;
  const live = steps.filter((s) => s.target === target && s.op === "access_revoke" && !isFinalStep(String(s.state)) && !stuckStep(s as never));
  const now = pc.now();
  // A held step keeps its key: ask again with the same key and input. Never a new hold.
  const held = live.filter((s) => s.state === "waiting");
  for (const key of new Set(held.filter((s) => Number(s.retry_at) <= now).map((s) => String(s.key)))) {
    const fresh = getPlan(db, id);
    if (!fresh || !isOpenPlan(String(fresh.state)) || moved(db, fresh)) return;
    // It stays `waiting` during the call: a crash here changes nothing, and the key is not lost to a new attempt.
    await sendBatch(pc, p, target, held.filter((s) => s.key === key), key, Number((held.find((s) => s.key === key) as Row).attempt), "waiting");
  }
  // A list costs a Decisions row in Rules: only when it can decide something now. While a step waits for the owner there is nothing to read.
  const after = stepsOf(db, id);
  // Once when Core applied: what an agent gained while the draft waited is part of this stop. The read step's `batch` keeps that this was done.
  const firstAfterCore = phases.includes("after") && Number(read.batch) === 0;
  // §4: while a plan is open each tick reads its stores again (every 60 s for 30 min, then every 15), so Differences and the person's page move with it. With 3 or more open plans one sweep does that.
  const needsList = pc.sweep === undefined ? true : firstAfterCore || !isFinalStep(String(read.state)) || openToSend(pc, p, after, phases, target).length > 0 || after.some((s) => s.target === target && (s.state === "sending" || s.state === "claimed"));
  if (!needsList || Number(read.retry_at) > now) return;
  for (let pass = 0; pass < 2; pass++) {
    const asked = subjectsOf(db, p, steps);
    if (asked.length === 0) return;
    const answer = await pc.access.list(target as AccessTarget, asked, pc.signal);
    const at = pc.now();
    const cur = stepsOf(db, id).find((s) => s.phase === "read" && s.target === target) as Row;
    if (answer.kind === "not_installed") {
      moveStep(db, cur, "not_installed", {}, at);
      for (const s of stepsOf(db, id)) if (s.target === target && s.op === "access_revoke" && !isFinalStep(String(s.state))) moveStep(db, s, "not_installed", {}, at);
      return;
    }
    if (answer.kind !== "ok") {
      const state = answer.kind === "refused" ? "refused" : answer.kind === "held" ? "waiting" : "not_read";
      const code = answer.kind === "not_read" || answer.kind === "refused" ? answer.code : answer.kind;
      const detail = answer.kind === "refused" ? answer.reason : null;
      const backoff = answer.kind === "refused" || answer.kind === "held" ? LIST_BACKOFF_MS : answer.kind === "wait" ? answer.afterMs : 0;
      // Also from `done`: a store that stops answering is "Could not be read" again, and the plan cannot read as finished.
      moveStep(db, cur, state, { code, detail, retry_at: at + backoff }, at);
      return;
    }
    moveStep(db, cur, "done", { code: null, detail: JSON.stringify(answer.notShown).slice(0, 500), retry_at: 0, ...(phases.includes("after") ? { batch: 1 } : {}) }, at);
    // The owner's copy for Differences: never authority, and a row goes only when a list proved it gone (`prove`).
    db.transaction(() => storeItems(db, target as AccessTarget, answer.items, null, at));
    absorb(pc, p, target, answer.items);
    const open = stepsOf(db, id).filter((s) => s.target === target && s.op === "access_revoke" && ["pending", "sending", "claimed", "failed", "not_revocable"].includes(String(s.state)) && !stuckStep(s as never));
    prove(pc, open, answer.items, answer.notShown);
    if (pass === 1) return;
    const toSend = openToSend(pc, getPlan(db, id) as Row, stepsOf(db, id), phases, target);
    if (toSend.length === 0) return;
    const bySubject = new Map<string, Row[]>();
    for (const s of toSend) bySubject.set(`${String(s.subject_kind)}:${String(s.subject_id)}`, [...(bySubject.get(`${String(s.subject_kind)}:${String(s.subject_id)}`) ?? []), s]);
    for (const group of bySubject.values()) {
      for (let i = 0; i < group.length; i += revokeBatchMax(target)) {
        const batch = group.slice(i, i + revokeBatchMax(target));
        // The stale check right before the claim: nothing awaited stands between them. An op that cancelled the plan or changed the subject wins.
        const fresh = getPlan(db, id);
        if (!fresh || !isOpenPlan(String(fresh.state)) || moved(db, fresh)) return;
        const claimed = claimBatch(pc, p, target, batch, pc.now());
        if (!claimed) continue;
        await sendBatch(pc, p, target, batch, claimed.key, claimed.attempt);
      }
    }
  }
}

// ── Tick ────────────────────────────────────────────────────────────────────

export interface TickResult {
  open: boolean;
  afterMs: number;
}

function cadence(p: Row, now: number): number {
  const since = Math.max(Number(p.opened_at), Number(p.applying_since ?? 0), Number(p.applied_at ?? 0));
  return now - since < FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

function targetsOf(steps: readonly Row[]): string[] {
  return [...new Set(steps.filter((s) => s.phase === "read").map((s) => String(s.target)))];
}

/** One tick of one plan. It never throws for a store's or Core's answer. A crash anywhere leaves a state the next tick resumes from. */
export async function tick(pc: PlanCtx, id: string): Promise<TickResult> {
  const db = pc.db;
  let p = getPlan(db, id);
  if (!p || !isOpenPlan(String(p.state))) return { open: false, afterMs: 0 };
  if (moved(db, p)) {
    await staleEnd(pc, p);
    return { open: false, afterMs: 0 };
  }
  let steps = stepsOf(db, id);
  // 1. Core first: its answer decides what may run after it.
  const needAsk = p.rail === "draft" && p.state === "preparing" && p.draft_id === null;
  if (needAsk) await askForDraft(pc, p, steps);
  // Link mode too, when a draft exists: the rail may be back, and the owner may have approved that draft.
  else if (p.draft_key !== null && (!isAppliedHere(p) || steps.some((s) => s.phase === "core" && !isFinalStep(String(s.state))))) await syncDraft(pc, p, steps);
  p = getPlan(db, id) as Row;
  if (!isOpenPlan(String(p.state))) {
    await alerts(pc, p);
    return { open: false, afterMs: 0 };
  }
  if (p.rail === "portal_link") proveFromSlice(pc, stepsOf(db, id));
  steps = stepsOf(db, id);
  // 2. What the owner's confirm approves runs at once; what stands on a Core step waits for it.
  const open = p.rail === "none" || isAppliedHere(p) || (p.rail === "portal_link" && steps.filter((s) => s.phase === "core").some((s) => isFinalStep(String(s.state))));
  const phases = open ? ["now", "after"] : ["now"];
  for (const target of targetsOf(steps)) {
    if (pc.signal?.aborted) break;
    await runTarget(pc, p, target, phases);
    p = getPlan(db, id) as Row;
    if (!isOpenPlan(String(p.state))) break;
  }
  // 3. The state is computed from the steps, and only a plan past Core can end.
  p = getPlan(db, id) as Row;
  const now = pc.now();
  steps = stepsOf(db, id);
  if (isOpenPlan(String(p.state))) {
    const pastCore = p.rail === "none" || isAppliedHere(p) || (p.rail === "portal_link" && steps.filter((s) => s.phase === "core").every((s) => isFinalStep(String(s.state))));
    if (pastCore) movePlan(db, id, String(p.state), stateFromSteps(steps as never), {}, now);
    if (p.state === "applying" && p.applying_since !== null && now - Number(p.applying_since) > APPLYING_STUCK_MS) notePlan(db, id, "applying", { code: "portal_stopped" }, now);
  }
  p = getPlan(db, id) as Row;
  await alerts(pc, p);
  const stillOpen = isOpenPlan(String(p.state));
  return { open: stillOpen, afterMs: stillOpen ? cadence(p, pc.now()) : 0 };
}

async function staleEnd(pc: PlanCtx, p: Row): Promise<void> {
  const id = String(p.id);
  const rail = pc.rail;
  let code = "lifecycle_moved";
  // Whatever the mode says: a draft may stand in Portal since before the rail went away.
  if (rail && p.draft_key !== null && !isAppliedHere(p)) {
    const key = String(p.draft_key);
    const answer = await askRail(() => rail.withdraw(key));
    if (answer.kind === "draft_state") {
      // The owner approved first. What Core did goes on the record before the plan ends: a T6 must see it.
      const got = await askRail(() => rail.get(key));
      if (got.kind === "ok" && readableDraft(got.value)) {
        applyCoreSteps(pc, got.value, stepsOf(pc.db, id));
        notePlan(pc.db, id, String(p.state), { draft_state: got.value.state, core_digest: got.value.digest, ...(got.value.receiptId ? { receipt_id: got.value.receiptId } : {}) }, pc.now());
      } else notePlan(pc.db, id, String(p.state), { draft_state: "applying" }, pc.now());
    } else if (answer.kind !== "ok" && answer.kind !== "unknown_key") code = "not_taken_back";
  }
  endPlan(pc, id, String(p.state), "stale", { code }, pc.now());
}

async function alerts(pc: PlanCtx, p: Row): Promise<void> {
  if (p.state === "waiting" && p.trigger_kind === "system") await alertOnce(pc, p, "waiting");
  if (p.state === "expired") await alertOnce(pc, p, "expired");
  // A date passed and no draft waits (a person with no agents): the owner still hears of it.
  if (p.trigger_kind === "system" && p.rail === "none") await alertOnce(pc, p, "date_passed");
}

/** Boot: no tick of this process runs yet, so no lease is alive. A plan cut off by a crash goes on at once. */
export function releaseTicks(db: Db): void {
  db.prepare("UPDATE fleet_plans SET ticking_until = 0 WHERE ticking_until > 0").run();
}

/** Takes the lease of each due plan, and ticks it. A second run finds it taken. */
export async function runDue(pc: PlanCtx, limit = 50): Promise<number> {
  const db = pc.db;
  const now = pc.now();
  const open = db.prepare(`SELECT MAX(MAX(opened_at, COALESCE(applying_since, 0), COALESCE(applied_at, 0))) AS newest, COUNT(*) AS n FROM fleet_plans WHERE state IN (${OPEN_SQL})`).get();
  const many = Number(open?.n ?? 0) >= MANY_PLANS;
  const startSweep = pc.startSweep;
  // §4: the same pace as a tick, from the plan that moved last.
  if (many && startSweep && now - Number(lastSweepAt(db) ?? 0) >= (now - Number(open?.newest ?? 0) < FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS)) {
    try {
      startSweep();
    } catch (e) {
      // A read that could not start stops no plan.
      pc.warn("plans sweep not started", { reason: e instanceof Error ? e.message.slice(0, 200) : "error" });
    }
  }
  const ctx: PlanCtx = many ? { ...pc, sweep: () => {} } : { ...pc, sweep: undefined };
  const due = db.prepare(`SELECT id, next_at FROM fleet_plans WHERE state IN (${OPEN_SQL}) AND next_at <= ? AND ticking_until <= ? ORDER BY next_at, id LIMIT ?`).all(now, now, limit);
  let n = 0;
  for (const r of due) {
    if (pc.signal?.aborted) break;
    const id = String(r.id);
    // The lease outlives a job's timeout. A crash holds it until the next boot clears it: there is one process.
    const took = db.prepare("UPDATE fleet_plans SET next_at = ?, ticking_until = ? WHERE id = ? AND next_at = ? AND ticking_until <= ?").run(now + POLL_FAST_MS, now + TICK_LEASE_MS, id, Number(r.next_at), now);
    if (took.changes !== 1) continue;
    try {
      const res = await tick(ctx, id);
      // A wake during this tick set `next_at` to 0: it stays, so the next run looks again.
      db.prepare("UPDATE fleet_plans SET next_at = CASE WHEN next_at = 0 THEN 0 ELSE ? END, ticking_until = 0 WHERE id = ?").run(res.open ? pc.now() + res.afterMs : 0, id);
      n++;
    } catch (e) {
      db.prepare("UPDATE fleet_plans SET ticking_until = 0 WHERE id = ?").run(id);
      pc.warn("plan tick failed", { plan: id, reason: e instanceof Error ? e.message.slice(0, 200) : "error" });
    }
  }
  await retryPendingAlerts(pc);
  return n;
}

