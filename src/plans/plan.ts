// A plan: what Governance asks for one stop (C380, DESIGN-C380 §5). One synchronous transaction makes it; the runner (runner.ts) moves it.
// The plan names no person and no reason to Core: the title is generic, the steps name agent ids. Above 100 Core steps it splits into
// numbered plans. Every later state change is one compare-and-set here, so a stale tick or a racing op changes nothing.
import { createHash } from "node:crypto";
import { canonicalize, ulid } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { ACCESS_TARGETS } from "../access/items.ts";
import { appendEvent } from "../lifecycle/events.ts";
import { effectiveAgent, type Lifecycle, type SubjectKind } from "../lifecycle/states.ts";
import { type Actor, loadSubject, type Subject } from "../lifecycle/transitions.ts";
import { fail } from "../meta.ts";
import { DEFAULT_EXPIRES_SEC, isOpenPlan, OPEN_PLAN_STATES, STEPS_PER_DRAFT } from "./steps.ts";

export type CoreOp = "agents.pause" | "agents.offboard" | "agents.rotate";
export interface CoreStep {
  opId: CoreOp;
  agt: string;
}
export interface Tick {
  product: string;
  id: string;
  /** what the owner saw: another digest at the first read is `changed` */
  digest?: string | undefined;
}
export interface PlanInput {
  kind: SubjectKind;
  id: string;
  expectedRev?: number | undefined;
  /** agents whose owner changed: pause and new key */
  transfers?: readonly string[] | undefined;
  /** the owner's ticks; absent = every item an app can end that is held by the subject */
  items?: readonly Tick[] | undefined;
  expiresInSec?: number | undefined;
  /** N2-6: only the sender bar of a person marked leaving. No Core step, Connect only. */
  barOnly?: boolean | undefined;
  actor: Actor;
  sourceEvent?: string | undefined;
}

export type Row = Record<string, unknown>;
export const OPEN_SQL = OPEN_PLAN_STATES.map((s) => `'${s}'`).join(", ");
const STOPPED: readonly Lifecycle[] = ["suspended", "leaving"];

/** The Core steps of this stop. A kept agent has none. Closed agents have none: they stopped before. */
export function coreStepsFor(db: Db, s: Subject, transfers: readonly string[]): CoreStep[] {
  const steps: CoreStep[] = [];
  const add = (opId: CoreOp, agt: string) => {
    if (!steps.some((x) => x.opId === opId && x.agt === agt)) steps.push({ opId, agt });
  };
  const agentRow = (id: string) => db.prepare("SELECT id, lifecycle, valid_from, keep_running, owner_id, status FROM fleet_agents WHERE id = ?").get(id);
  const ownerLifecycle = (ownerId: unknown): string | null => (ownerId === null ? null : ((db.prepare("SELECT lifecycle FROM fleet_people WHERE id = ?").get(String(ownerId))?.lifecycle as string | null | undefined) ?? null));
  const forAgent = (r: Row) => {
    if (r.status === "removed") return;
    const effective = effectiveAgent({ lifecycle: r.lifecycle as Lifecycle, validFrom: r.valid_from === null ? null : Number(r.valid_from), keepRunning: Number(r.keep_running) === 1 }, ownerLifecycle(r.owner_id));
    if (effective === "leaving") add("agents.offboard", String(r.id));
    // Already paused, by an earlier approval or in Portal: a second draft asks only for what is new.
    else if (effective === "suspended" && r.status !== "paused") add("agents.pause", String(r.id));
  };
  if (s.kind === "agent") {
    const r = agentRow(s.id);
    if (r) forAgent(r);
  } else {
    for (const r of db.prepare("SELECT id FROM fleet_agents WHERE owner_id = ? ORDER BY name COLLATE NOCASE, id").all(s.id)) {
      const a = agentRow(String(r.id));
      if (a) forAgent(a);
    }
  }
  for (const agt of transfers) {
    const r = agentRow(agt) ?? fail("agent_not_found", "No such agent.", 404);
    if (r.lifecycle === "archived" || r.status === "removed") fail("agent_closed", "This agent is closed. It cannot move to a new owner.", 409);
    if (r.status !== "paused") add("agents.pause", agt);
    add("agents.rotate", agt);
  }
  return steps;
}

export const digestOfPlan = (doc: Json): string => `sha256:${createHash("sha256").update(canonicalize(doc)).digest("hex")}`;

/** Each agent's steps stay in one part, so an app step can wait for the one draft that stops its agent. */
export function splitSteps(steps: readonly CoreStep[], max = STEPS_PER_DRAFT): CoreStep[][] {
  const byAgent = new Map<string, CoreStep[]>();
  for (const s of steps) byAgent.set(s.agt, [...(byAgent.get(s.agt) ?? []), s]);
  const parts: CoreStep[][] = [];
  let cur: CoreStep[] = [];
  for (const group of byAgent.values()) {
    if (cur.length + group.length > max) {
      parts.push(cur);
      cur = [];
    }
    cur.push(...group);
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

export interface Made {
  ids: string[];
}

/** What refuses a plan, before anything is done for it: a new plan takes an older draft back only when it will really be made. */
export function checkPlan(db: Db, input: PlanInput): { s: Subject; steps: CoreStep[] } {
  const s = loadSubject(db, input.kind, input.id) ?? fail(input.kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
  if (input.expectedRev !== undefined && input.expectedRev !== s.rev) fail("lifecycle_stale", "This entry changed since you looked. Open it again.", 409);
  if (s.lifecycle === "archived") fail("subject_closed", "This entry is closed. Bring it back first.", 409);
  const steps = input.barOnly ? [] : coreStepsFor(db, s, input.transfers ?? []);
  if (steps.length === 0 && !(s.kind === "person" && STOPPED.includes(s.lifecycle)) && !input.items?.length) fail("nothing_to_stop", "This entry has nothing to stop. Tick what to remove.", 409);
  return { s, steps };
}

/**
 * Makes the plan, one row per part, in the caller's transaction or its own. Reads the stores nothing: the first tick reads them, with the
 * owner's ticks kept in `wanted_json`. A plan with nothing to stop and nothing ticked is refused, so an empty plan never reads as a stop done.
 */
export function createPlan(db: Db, input: PlanInput, now = Date.now()): Made {
  return db.transaction(() => {
    const { s, steps } = checkPlan(db, input);
    if (db.prepare(`SELECT 1 FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND state IN (${OPEN_SQL})`).get(s.kind, s.id)) fail("plan_open", "A plan for this entry is still open. Cancel it or wait for it.", 409);
    const purpose = input.barOnly ? "bar" : s.lifecycle === "suspended" ? "suspend" : s.lifecycle === "leaving" ? "leave" : input.transfers?.length ? "transfer" : steps.length > 0 ? "suspend" : "review";
    const parts = splitSteps(steps);
    const count = Math.max(parts.length, 1);
    const groupId = `pln_${ulid(now)}`;
    const ids: string[] = [];
    const expires = input.expiresInSec ?? DEFAULT_EXPIRES_SEC;
    for (let i = 0; i < count; i++) {
      const id = i === 0 ? groupId : `pln_${ulid(now)}`;
      const core = parts[i] ?? [];
      const digest = digestOfPlan({ v: 1, subject: { kind: s.kind, id: s.id }, purpose, part: i + 1, parts: count, steps: core.map((c) => ({ opId: c.opId, agt: c.agt })) } as unknown as Json);
      db.prepare(
        `INSERT INTO fleet_plans (id, group_id, part, parts, subject_kind, subject_id, subject_name, purpose, trigger_kind, actor_id, source_event, lifecycle_rev, state, rail, plan_digest, expires_in_sec, wanted_json, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?)`,
      ).run(id, groupId, i + 1, count, s.kind, s.id, s.name, purpose, input.actor.kind, input.actor.id, i === 0 ? (input.sourceEvent ?? null) : null, s.rev, core.length > 0 ? "draft" : "none", digest, expires, input.items ? JSON.stringify(input.items) : null, now, now);
      let n = 0;
      for (const c of core) addStep(db, id, n++, { phase: "core", target: "core", op: c.opId, agent: c.agt, subject: { kind: "agent", id: c.agt } }, now);
      for (const t of input.barOnly ? (["connect"] as const) : ACCESS_TARGETS) addStep(db, id, n++, { phase: "read", target: t, op: "access_list" }, now);
      ids.push(id);
    }
    appendEvent(db, { subject: { kind: s.kind, id: s.id, name: s.name }, kind: "changed", actor: input.actor, note: input.barOnly ? "No plan came after this person was marked as leaving. Governance made one for the sender bar only." : `A plan was made: ${steps.length} steps in Portal.`, plan: { id: groupId, draftId: null, receiptId: null }, at: now });
    return { ids };
  });
}

export interface NewStep {
  phase: "read" | "core" | "now" | "after";
  target: string;
  op: string;
  agent?: string | null;
  subject?: { kind: string; id: string } | null;
  item?: { id: string; kind: string; digest: string; label: string } | null;
  state?: string;
  code?: string | null;
  detail?: string | null;
}

export function addStep(db: Db, planId: string, n: number, s: NewStep, now: number): void {
  db.prepare(
    `INSERT INTO fleet_plan_steps (id, plan_id, n, phase, target, op, agent_id, subject_kind, subject_id, item_id, item_kind, item_digest, label, state, code, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`pst_${ulid(now)}`, planId, n, s.phase, s.target, s.op, s.agent ?? null, s.subject?.kind ?? null, s.subject?.id ?? null, s.item?.id ?? null, s.item?.kind ?? null, s.item?.digest ?? null, s.item?.label ?? null, s.state ?? "pending", s.code ?? null, s.detail ?? null, now);
}

export const getPlan = (db: Db, id: string): Row | null => db.prepare("SELECT * FROM fleet_plans WHERE id = ?").get(id) ?? null;
export const stepsOf = (db: Db, id: string): Row[] => db.prepare("SELECT * FROM fleet_plan_steps WHERE plan_id = ? ORDER BY n").all(id);
export const openPlansOf = (db: Db, kind: string, id: string): Row[] => db.prepare(`SELECT * FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? AND state IN (${OPEN_SQL}) ORDER BY part`).all(kind, id);

type Fields = Record<string, string | number | null>;
const assign = (f: Fields): { sql: string; values: (string | number | null)[] } => ({ sql: Object.keys(f).map((k) => `${k} = ?`).join(", "), values: Object.values(f) });

/** The one writer of a plan's state. False when the plan is no longer in `from`: a racing op or a stale tick won, and nothing changed. */
export function movePlan(db: Db, id: string, from: string | readonly string[], to: string, fields: Fields, now: number): boolean {
  const states = typeof from === "string" ? [from] : from;
  const { sql, values } = assign({ ...fields, state: to, updated_at: now, ...(isOpenPlan(to) ? {} : { closed_at: now }) });
  return db.transaction(() => {
    const moved = db.prepare(`UPDATE fleet_plans SET ${sql} WHERE id = ? AND state IN (${states.map(() => "?").join(", ")})`).run(...values, id, ...states).changes === 1;
    if (moved && !isOpenPlan(to) && !states.includes(to)) recordPlan(db, id, `The plan ended: ${to}.`, now);
    return moved;
  });
}

/** The record for later reading, with Core's ids: SDK receipts live 90 days. */
export function recordPlan(db: Db, id: string, note: string, now: number): void {
  const p = getPlan(db, id);
  if (!p) return;
  appendEvent(db, {
    subject: { kind: String(p.subject_kind), id: String(p.subject_id), name: String(p.subject_name) },
    kind: "changed",
    actor: { kind: p.trigger_kind === "system" ? "system" : "owner", id: p.actor_id === null ? null : String(p.actor_id) },
    note,
    plan: { id, draftId: p.draft_id === null ? null : String(p.draft_id), receiptId: p.receipt_id === null ? null : String(p.receipt_id) },
    at: now,
  });
}

/** Fields only, in the plan's current state. False when the state moved. */
export function notePlan(db: Db, id: string, state: string, fields: Fields, now: number): boolean {
  const { sql, values } = assign({ ...fields, updated_at: now });
  return db.prepare(`UPDATE fleet_plans SET ${sql} WHERE id = ? AND state = ?`).run(...values, id, state).changes === 1;
}

/** The one writer of a step. `UPDATE ... WHERE state = ? AND attempt = ?`: false when another run moved it first. */
export function moveStep(db: Db, step: Row, to: string, fields: Fields, now: number): boolean {
  const { sql, values } = assign({ ...fields, state: to, updated_at: now });
  return db.prepare(`UPDATE fleet_plan_steps SET ${sql} WHERE id = ? AND state = ? AND attempt = ?`).run(...values, String(step.id), String(step.state), Number(step.attempt)).changes === 1;
}

