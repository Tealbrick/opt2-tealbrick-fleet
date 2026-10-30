// The owner's reads of the lifecycle: one row per person and agent, one detail page, the summary (C380, DESIGN-C380 §10). Owner side only.
// A list reads the whole directory in a few indexed queries and builds it once (no query per row): `fleet_facts` shares this event loop (F12).
import type { Db, OpContext, SdkOpContext } from "@opt2-tealbrick/miniapp-sdk";
import type { ColleagueGetOutput, ColleaguesListOutput, SummaryGetOutput } from "#kit";
import { readStates } from "../access/client.ts";
import { ACCESS_AFTER_LEAVE, accessAfterLeave, openDifferences } from "../access/differences.ts";
import { type AccessTarget, TARGET_NAMES } from "../access/items.ts";
import { type Finding, findingsOf } from "../findings.ts";
import { fail, revision } from "../meta.ts";
import { latestPlanStates, unnamedAccounts } from "../plans/guards.ts";
import { type PlanAgent, portalPlan } from "../plans/portal-link.ts";
import { exclusionFindings } from "../roles/exclusions.ts";
import { cleanTopology, type DecodedTopology, decodeTopology } from "../topology-slice.ts";
import type { Trust } from "../trust.ts";
import { lastLeavingSnapshot, stopsSince, subjectEvents } from "./events.ts";
import { type FloorContext, type FloorView, floorView, readFloorStatus } from "./floor.ts";
import { getSettings } from "./settings.ts";
import { type Effective, effectiveAgent, effectivePerson, type Lifecycle, NEXT, type SubjectKind } from "./states.ts";
import { CAP_WINDOW_MS, capState, coolingEnd, DAY_MS, type Grant, guardOf, loadSubject } from "./transitions.ts";

export type Row = ColleaguesListOutput["items"][number];
export type Detail = ColleagueGetOutput["colleague"];
type Db_ = Record<string, unknown>;
const isoOf = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const runtimeOf = (status: unknown): "running" | "paused" | "gone" => (status === "active" ? "running" : status === "paused" ? "paused" : "gone");

/** One line, no pills: the three axes in plain words. */
function lineOf(kind: SubjectKind, lifecycle: Lifecycle, effective: Effective, runtime: Row["runtime"], validFrom: unknown): string {
  if (effective === "not_started") return `Starts on ${String(isoOf(validFrom)).slice(0, 10)}`;
  if (kind === "person") {
    return { proposed: "New, not reviewed", active: "Active", suspended: "Stop asked", leaving: "Leaving", archived: "Closed" }[effective];
  }
  if (runtime === "gone") return lifecycle === "archived" ? "Closed" : "Not listed in Portal";
  if (lifecycle === "archived") return "Closed, but Portal lists it again";
  if (effective === "proposed") return runtime === "running" ? "New: working, not reviewed" : "New, not reviewed: paused";
  if (effective === "active") return runtime === "running" ? "Working" : "Paused in Portal";
  const word = effective === "leaving" ? "Stop and remove" : "Stop";
  return runtime === "running" ? `${word} asked: still running` : effective === "leaving" ? "Stopped, removal waits for you" : "Stopped";
}

interface Loaded {
  rows: Row[];
  byId: Map<string, Row>;
}

/** Every person and workspace agent, sorted by name. Outside agents have no lifecycle and are not listed. */
export function loadColleagues(db: Db, now: number): Loaded {
  const conflicts = new Set(db.prepare("SELECT DISTINCT h.agent_id FROM fleet_agent_handles h JOIN fleet_handles p ON p.handle = h.handle").all().map((r) => String(r.agent_id)));
  const plans = latestPlanStates(db);
  const owners = new Map<string, { name: string; lifecycle: string | null }>();
  const rows: Row[] = [];
  const person = (p: Db_): Row => {
    const lifecycle = p.lifecycle as Lifecycle;
    const effective = effectivePerson({ lifecycle, validFrom: p.valid_from === null ? null : Number(p.valid_from) });
    return {
      kind: "person",
      id: String(p.id),
      name: String(p.name),
      lifecycle,
      effective,
      runtime: null,
      trust: p.trust as Trust,
      owner: null,
      line: lineOf("person", lifecycle, effective, null, p.valid_from),
      findings: findingsOf({ kind: "person", lifecycle, effective, runtime: null, hasOwner: false, ownerLifecycle: null, reason: p.lifecycle_reason === null ? null : String(p.lifecycle_reason), at: Number(p.lifecycle_at), validUntil: p.valid_until === null ? null : Number(p.valid_until), noCard: false, handleConflict: false, planState: plans.get(`person:${String(p.id)}`) ?? null, unnamedAccounts: lifecycle === "leaving" ? unnamedAccounts(db, String(p.id), now) : 0 }, now),
      validFrom: isoOf(p.valid_from),
      validUntil: isoOf(p.valid_until),
      keepRunning: false,
      at: isoOf(p.lifecycle_at),
    };
  };
  for (const p of db.prepare("SELECT id, name, kind, lifecycle, lifecycle_reason, lifecycle_at, valid_from, valid_until, trust FROM fleet_people").all()) {
    owners.set(String(p.id), { name: String(p.name), lifecycle: p.lifecycle === null ? null : String(p.lifecycle) });
    if (p.kind === "person" && p.lifecycle !== null) rows.push(person(p));
  }
  for (const a of db.prepare("SELECT id, name, status, trust, owner_id, lifecycle, lifecycle_reason, lifecycle_at, valid_from, valid_until, keep_running, migrated_note FROM fleet_agents").all()) {
    const lifecycle = a.lifecycle as Lifecycle;
    const owner = a.owner_id === null ? undefined : owners.get(String(a.owner_id));
    const keepRunning = Number(a.keep_running) === 1;
    const effective = effectiveAgent({ lifecycle, validFrom: a.valid_from === null ? null : Number(a.valid_from), keepRunning }, owner?.lifecycle ?? null);
    const runtime = runtimeOf(a.status);
    const findings = findingsOf(
      { kind: "agent", lifecycle, effective, runtime, hasOwner: owner !== undefined, ownerLifecycle: owner?.lifecycle ?? null, reason: a.lifecycle_reason === null ? null : String(a.lifecycle_reason), at: Number(a.lifecycle_at), validUntil: a.valid_until === null ? null : Number(a.valid_until), noCard: a.migrated_note === "no_card", handleConflict: conflicts.has(String(a.id)), planState: plans.get(`agent:${String(a.id)}`) ?? null },
      now,
    );
    rows.push({
      kind: "agent",
      id: String(a.id),
      name: String(a.name),
      lifecycle,
      effective,
      runtime,
      trust: a.trust as Trust,
      owner: owner ? { id: String(a.owner_id), name: owner.name } : null,
      line: lineOf("agent", lifecycle, effective, runtime, a.valid_from),
      findings,
      validFrom: isoOf(a.valid_from),
      validUntil: isoOf(a.valid_until),
      keepRunning,
      at: isoOf(a.lifecycle_at),
    });
  }
  const leave = accessAfterLeave(db);
  for (const r of rows) if (leave.has(`${r.kind}:${r.id}`)) r.findings.push(ACCESS_AFTER_LEAVE);
  // C380 T2-c "Cannot hold both": broken rules, computed here from the role rows like every finding (no rule: no query beyond one)
  const clash = exclusionFindings(db, now);
  for (const r of rows) {
    const c = clash.get(`${r.kind}:${r.id}`);
    if (c) r.findings.push(c);
  }
  rows.sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()) || x.id.localeCompare(y.id));
  return { rows, byId: new Map(rows.map((r) => [`${r.kind}:${r.id}`, r])) };
}

export function colleaguesList(db: Db, q: { kind?: SubjectKind | undefined; lifecycle?: Effective | undefined; finding?: string | undefined; cursor?: string | undefined; limit?: number | undefined }, now = Date.now()): ColleaguesListOutput {
  const all = loadColleagues(db, now).rows.filter((r) => (q.kind === undefined || r.kind === q.kind) && (q.lifecycle === undefined || r.effective === q.lifecycle) && (q.finding === undefined || r.findings.some((f) => f.code === q.finding)));
  const limit = q.limit ?? 100;
  const start = q.cursor === undefined ? 0 : Number(q.cursor);
  const items = all.slice(start, start + limit);
  return { items, nextCursor: start + limit < all.length ? String(start + limit) : null, total: all.length };
}

/** The picture from the slice, or null with no consent or an unreadable copy. Display only. */
export function readTopology(ctx: OpContext): DecodedTopology | null {
  let view: ReturnType<SdkOpContext["topology"]>;
  try {
    view = (ctx as OpContext & Partial<Pick<SdkOpContext, "topology">>).topology?.() ?? null;
  } catch {
    view = null;
  }
  if (!view) return null;
  const read = cleanTopology(view, view.agentIds.length);
  return read ? decodeTopology(read.topology, view.agentIds) : null;
}

/** Portal's list of who can use what, as a stated limit: no consent or a cut list. Its agents and their state are read either way. */
export const portalReadState = (topology: DecodedTopology | null): { read: true } | { read: false; text: string } =>
  !topology ? { read: false, text: "Which apps an agent can use is not shown. Turn on 'See who has access' for Governance in Portal." } : topology.truncated ? { read: false, text: "The list of access is too long to show here. Check it in Portal." } : { read: true };

/** What each agent can reach now, for the snapshot of T5. */
export function grantsOf(db: Db, topology: DecodedTopology | null, kind: SubjectKind, id: string): Grant[] {
  if (!topology) return [];
  const ids = kind === "agent" ? new Set([id]) : new Set(db.prepare("SELECT id FROM fleet_agents WHERE owner_id = ? AND status <> 'removed'").all(id).map((r) => String(r.id)));
  return topology.edges.filter((e) => ids.has(e.agent)).map((e) => ({ agent: e.agent, product: e.product, crud: [...e.crud] }));
}

const floorCtx = (ctx: OpContext) => ({ companionTargets: () => (ctx as OpContext & Partial<Pick<SdkOpContext, "companionTargets">>).companionTargets?.() ?? [], callApp: ctx.callApp.bind(ctx) }) as unknown as FloorContext;

async function floorFor(ctx: OpContext, rev: number, agentsRun: boolean, now: number): Promise<FloorView> {
  return floorView(await readFloorStatus(floorCtx(ctx)), rev, now, agentsRun);
}

/** The Portal page of the workspace, from the SDK's owner link; null on a standalone app. */
function portalUrl(ctx: OpContext): string | null {
  const link = (ctx as OpContext & { ownerLink?: (p: string) => string | null }).ownerLink?.("/") ?? null;
  const at = link?.indexOf("/open?") ?? -1;
  return link && at > 0 ? link.slice(0, at) : null;
}

const LABELS: Readonly<Record<Lifecycle, Partial<Record<Lifecycle, string>>>> = {
  proposed: { active: "Mark as reviewed", suspended: "Stop now", leaving: "Stop and remove access" },
  active: { suspended: "Stop now", leaving: "Stop and remove access" },
  suspended: { active: "Resume", leaving: "Stop and remove access" },
  leaving: { active: "Undo", proposed: "Bring back", archived: "Close" },
  archived: { proposed: "Bring back" },
};

export async function colleagueDetail(ctx: OpContext, kind: SubjectKind, id: string, now = Date.now()): Promise<Detail> {
  const db = ctx.db;
  const loaded = loadColleagues(db, now);
  const row = loaded.byId.get(`${kind}:${id}`);
  const s = loadSubject(db, kind, id);
  if (!row || !s) return fail(kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
  const extra = db.prepare(kind === "agent" ? "SELECT role AS title, lifecycle_reason, lifecycle_note, keep_reason FROM fleet_agents WHERE id = ?" : "SELECT title, lifecycle_reason, lifecycle_note, NULL AS keep_reason FROM fleet_people WHERE id = ?").get(id) as Db_;
  const teams = db
    .prepare("SELECT t.id, t.name, m.role FROM fleet_members m JOIN fleet_teams t ON t.id = m.team_id WHERE m.kind = ? AND m.subject_id = ? ORDER BY t.name COLLATE NOCASE, t.id LIMIT 50")
    .all(kind, id)
    .map((t) => ({ id: String(t.id), name: String(t.name), role: t.role as "member" | "lead" }));
  const owned = kind === "person" ? loaded.rows.filter((r) => r.kind === "agent" && r.owner?.id === id && r.runtime !== "gone") : [];
  const topology = readTopology(ctx);
  const wasStopped = kind === "agent" && lastLeavingSnapshot(db, "agent", id) !== null;
  const planAgents: PlanAgent[] = (kind === "agent" ? [row] : owned).map((r) => ({ id: r.id, name: r.name, lifecycle: r.lifecycle, effective: r.effective, runtime: r.runtime, wasStopped }));
  const built = portalPlan(planAgents, topology, portalUrl(ctx), kind === "person" && owned.length === 0 ? "This person owns no agents. Nothing to do in Portal." : null);
  const plan = built.steps.length > 0 || s.lifecycle === "suspended" || s.lifecycle === "leaving" ? built : null;
  const actions = NEXT[s.lifecycle]
    .map((to) => {
      const label = LABELS[s.lifecycle][to];
      if (!label) return null;
      const blocked = guardOf(db, s, to, { waive: "x" }, now);
      return { to, label, blocked: blocked?.message ?? null, needsWaive: to === "archived" && guardOf(db, s, to, {}, now)?.code === "cooling_not_over" };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .filter((a) => !(s.kind === "agent" && s.lifecycle === "archived" && a.blocked !== null));
  const days = getSettings(db).coolingDays;
  const close = s.lifecycle === "leaving" ? { coolingDays: days, coolingEndsAt: isoOf(coolingEnd(s, days)), coolingOver: coolingEnd(s, days) <= now, limits: ["Stores that were not read, and access no version can list, are not checked by this close."] } : null;
  const notices: string[] = [];
  if (row.keepRunning) notices.push("The person who left may still hold this agent's key.");
  if (kind === "agent" && row.lifecycle === "archived" && row.runtime === "gone") notices.push("A closed agent stays closed. New work needs a new agent.");
  const running = kind === "agent" ? row.runtime === "running" : owned.some((r) => r.runtime === "running");
  const snapshot = s.lifecycle === "proposed" || s.lifecycle === "archived" || s.lifecycle === "leaving" ? lastLeavingSnapshot(db, kind, id) : null;
  return {
    ...row,
    title: String(extra.title ?? ""),
    rev: s.rev,
    reason: extra.lifecycle_reason === null ? null : String(extra.lifecycle_reason),
    note: extra.lifecycle_note === null ? null : String(extra.lifecycle_note),
    keepReason: extra.keep_reason === null || extra.keep_reason === undefined ? null : String(extra.keep_reason),
    teams,
    agents: owned.slice(0, 400),
    actions,
    close,
    plan,
    floor: await floorFor(ctx, s.rev, running, now),
    grantsBefore: Array.isArray(snapshot?.grants) ? (snapshot.grants as Grant[]).slice(0, 200) : null,
    notices,
    history: subjectEvents(db, kind, id),
  };
}

export async function summaryGet(ctx: OpContext, now = Date.now()): Promise<SummaryGetOutput> {
  const db = ctx.db;
  const { rows } = loadColleagues(db, now);
  const agents = rows.filter((r) => r.kind === "agent" && r.runtime !== "gone");
  const people = rows.filter((r) => r.kind === "person");
  const running = agents.filter((r) => r.runtime === "running").length;
  const topology = readTopology(ctx);
  const maxRev = Number(db.prepare("SELECT MAX(lifecycle_rev) AS r FROM (SELECT lifecycle_rev FROM fleet_agents WHERE lifecycle IN ('suspended', 'leaving') OR valid_from IS NOT NULL UNION ALL SELECT lifecycle_rev FROM fleet_people WHERE lifecycle IN ('suspended', 'leaving') OR valid_from IS NOT NULL)").get()?.r ?? 0);
  const floor = await floorFor(ctx, maxRev, running > 0, now);
  const noOwner = agents.filter((r) => r.findings.some((f: Finding) => f.code === "no_owner")).length;
  const rulesOn = floor.state === "confirmed" || floor.state === "not_confirmed";
  const { used, limit } = capState(db, now);
  return {
    generatedAt: new Date(now).toISOString(),
    revision: revision(db),
    agents: {
      total: agents.length,
      running,
      paused: agents.filter((r) => r.runtime === "paused").length,
      stopping: agents.filter((r) => r.effective === "suspended" || r.effective === "leaving").length,
      notReviewed: agents.filter((r) => r.lifecycle === "proposed").length,
    },
    people: { total: people.length, leaving: people.filter((r) => r.lifecycle === "leaving").length, suspended: people.filter((r) => r.lifecycle === "suspended").length },
    noOwner,
    differences: openDifferences(db, rows, now),
    canWriteOrSend: topology && !topology.truncated ? new Set(topology.edges.filter((e) => e.crud.some((c) => c !== "read")).map((e) => e.agent)).size : null,
    stores: [
      { product: "core", name: "Portal", state: "read", text: "Agents and their state come from the workspace copy.", at: null },
      { product: "rules", name: "Rules & Approvals", state: floor.state === "not_installed" ? "not_installed" : floor.state === "not_read" || floor.state === "older" ? "not_read" : "read", text: floor.text, at: rulesOn ? new Date(now).toISOString() : null },
      // A refused or held read could not be read either; the text says which.
      ...readStates(db).map((s) => ({ product: s.target, name: TARGET_NAMES[s.target as AccessTarget] ?? s.target, state: s.state === "read" || s.state === "not_installed" ? s.state : ("not_read" as const), text: s.text ?? "Read.", at: s.readAt === null ? null : new Date(s.readAt).toISOString() })),
    ],
    readiness: [
      { id: "rules", state: rulesOn ? "ok" : "missing", text: rulesOn ? "Rules & Approvals can stop a call early." : floor.text, path: null },
      { id: "consent", state: topology ? "ok" : "missing", text: topology ? "Governance can see who has access." : "Turn on 'See who has access' for Governance in Portal.", path: null },
      { id: "owners", state: noOwner === 0 ? "ok" : "missing", text: noOwner === 0 ? "Every agent has an owner." : noOwner === 1 ? "1 agent has no owner." : `${noOwner} agents have no owner.`, path: "/people-and-agents" },
      { id: "alerts", state: "fallback", text: "Alerts show as a banner in Governance. No message is sent.", path: null },
    ],
    stoppedToday: stopsSince(db, now - DAY_MS),
    stopCap: { limit, windowMinutes: CAP_WINDOW_MS / 60_000, used },
    floor,
    settings: getSettings(db),
  };
}
