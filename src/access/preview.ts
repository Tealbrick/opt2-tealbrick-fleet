// "See what would stop" (C380, DESIGN-C380 §5.1): what each app reports now for one person or agent. One row per store, and a store that
// was not read is never an empty list. It changes nothing. The one write is the backoff of a refused or held read, so that opening a
// page twice makes no second hold; it moves no feed revision and no shadow row. The answer goes to the owner only (C88).
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { PlanPreviewOutput } from "#kit";
import { fail } from "../meta.ts";
import type { DecodedTopology } from "../topology-slice.ts";
import { type AccessEnv, absentAnswer, inBackoff, noteStop, presence, readPage, readStateOf } from "./client.ts";
import { ACCESS_TARGETS, type AccessItem, type AccessTarget, LIST_LIMITS, type ListSubject, type NotShown, onlyAsked, personSubject, shadowOf, TARGET_NAMES, unlinkedCount } from "./items.ts";

type Store = PlanPreviewOutput["stores"][number];
type Row = Store["items"][number];

/** One store has this long, from the start of the preview to its last page. The op has 30 s. */
export const STORE_BUDGET_MS = 12_000;
export const PREVIEW_PAGES = 10;

interface Agent {
  id: string;
  name: string;
  status: string;
  keepRunning: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** What a stop does to the item, so the page never derives it. `manual`: no app can end it; a person must. */
function effectOf(i: Pick<AccessItem, "direction" | "revocable" | "level">, keeps: boolean): Row["effect"] {
  if (i.direction === "about") return "about";
  if (keeps) return "stays";
  if (i.revocable) return "stops";
  return i.level === "info" ? "stays" : "manual";
}

function toRow(i: AccessItem, subjectId: string, agents: ReadonlyMap<string, Agent>): Row {
  const owned = i.subject.kind === "agent" ? agents.get(i.subject.id) : undefined;
  return { id: i.id, kind: i.kind, label: i.label, level: i.level, direction: i.direction, state: i.state, effect: effectOf(i, owned?.keepRunning === true), who: owned && owned.id !== subjectId ? owned.name : null };
}

/** 32 subjects per call. */
function chunks(subjects: readonly ListSubject[]): ListSubject[][] {
  const out: ListSubject[][] = [];
  for (let i = 0; i < subjects.length; i += LIST_LIMITS.subjects) out.push(subjects.slice(i, i + LIST_LIMITS.subjects));
  return out;
}

interface Read {
  store: Store;
  unlinked: number | null;
}

async function readStore(env: AccessEnv, db: Db, target: AccessTarget, subjects: readonly ListSubject[], who: { id: string; agents: ReadonlyMap<string, Agent> }, now: number, budgetMs: number): Promise<Read> {
  const name = TARGET_NAMES[target];
  const named = subjects.flatMap((s) => (s.kind === "agent" || s.kind === "person" ? [{ kind: s.kind, id: s.id }] : []));
  /** Not read: the last list, if there is one, with its time. Never an empty list that looks like an answer. */
  const notRead = (state: Exclude<Store["state"], "read">, text: string): Read => {
    const last = readStateOf(db, target);
    const rows = state === "not_installed" ? [] : shadowOf(db, target, named);
    const old = last?.readAt ? ` The last list, from ${iso(last.readAt).slice(0, 10)}, had ${rows.length === 1 ? "1 item" : `${rows.length} items`}.` : "";
    return { store: { product: target, name, state, text: state === "not_installed" ? text : `${text}${old}`, at: last?.readAt ? iso(last.readAt) : null, notShown: [], items: rows.map((i) => toRow(i, who.id, who.agents)) }, unlinked: null };
  };
  const there = presence(env, target);
  if (there !== "present") {
    const a = absentAnswer(there);
    return notRead(a.state, a.text);
  }
  const back = inBackoff(db, target, now);
  if (back) return notRead(back.state === "read" ? "not_read" : back.state, back.text ?? "This app could not be read.");
  const items = new Map<string, AccessItem>();
  const notShown: NotShown[] = [];
  let asOf = iso(now);
  let pages = 0;
  const deadline = Date.now() + budgetMs;
  for (const chunk of chunks(subjects)) {
    let cursor: string | null = null;
    do {
      if (pages >= PREVIEW_PAGES) return notRead("not_read", "This app has more to list than a preview reads. Use Check now.");
      const left = deadline - Date.now();
      if (left <= 0) return notRead("not_read", "The app did not answer in time.");
      pages++;
      const a = await readPage(env, target, { v: 1, subjects: chunk, limit: LIST_LIMITS.limit, ...(cursor === null ? {} : { cursor }) }, left);
      if (!a.ok) {
        // Only a refusal or a hold: a timeout is no state to keep, and the next look may work.
        if (a.backoffMs > 0) noteStop(db, target, a, Date.now());
        return notRead(a.state, a.text);
      }
      for (const i of onlyAsked(a.page.items, chunk)) items.set(i.id, i);
      for (const n of a.page.notShown) if (!notShown.some((k) => k.kind === n.kind)) notShown.push(n);
      asOf = a.page.asOf;
      cursor = a.page.nextCursor;
    } while (cursor !== null);
  }
  const all = [...items.values()];
  const listed = all.filter((i) => i.subject.kind !== "unlinked");
  const unlinked = target === "connect" ? all.filter((i) => i.subject.kind === "unlinked" && i.kind.startsWith("account_")).length : null;
  return { store: { product: target, name, state: "read", text: null, at: asOf, notShown, items: listed.map((i) => toRow(i, who.id, who.agents)) }, unlinked };
}

/** Portal's own row: what runs, from the signed slice, and who can use what, when the owner allowed Governance to see it. */
function portalStore(topology: DecodedTopology | null, agents: readonly Agent[], subjectId: string, now: number): Store {
  const items: Row[] = [];
  for (const a of agents) {
    const who = a.id === subjectId ? null : a.name;
    const running = a.status === "active";
    items.push({ id: `runtime:${a.id}`, kind: "agent_runtime", label: running ? "Runs now" : "Paused in Portal", level: "use", direction: "held_by", state: running ? "active" : "paused", effect: running && !a.keepRunning ? "stops" : "stays", who });
    for (const e of topology?.edges.filter((x) => x.agent === a.id) ?? []) {
      items.push({ id: `edge:${a.id}:${e.ins}`, kind: "app_access", label: `Can use ${e.product}`, level: e.crud.some((c) => c !== "read") ? "write" : "read", direction: "held_by", state: e.paused ? "paused" : "active", effect: a.keepRunning ? "stays" : "stops", who });
    }
    for (const c of topology?.connections.filter((x) => x.agt === a.id && x.status === "active") ?? []) {
      items.push({ id: `connection:${c.con}`, kind: "connection", label: "A connected machine or key", level: "use", direction: "held_by", state: "active", effect: a.keepRunning ? "stays" : "stops", who });
    }
  }
  const notShown: NotShown[] = !topology
    ? [{ kind: "app_access", reason: "Which apps an agent can use. Turn on 'See who has access' for Governance in Portal." }]
    : topology.truncated
      ? [{ kind: "app_access", reason: "The list of access is too long to show here. Check it in Portal." }]
      : [];
  return { product: "core", name: "Portal", state: "read", text: null, at: iso(now), notShown, items };
}

export async function planPreview(env: AccessEnv, db: Db, kind: "person" | "agent", id: string, topology: DecodedTopology | null, now = Date.now(), budgetMs = STORE_BUDGET_MS): Promise<PlanPreviewOutput> {
  const toAgent = (r: Record<string, unknown>): Agent => ({ id: String(r.id), name: String(r.name), status: String(r.status), keepRunning: Number(r.keep_running) === 1 });
  const row = db.prepare(kind === "agent" ? "SELECT id, name, status, keep_running FROM fleet_agents WHERE id = ?" : "SELECT id, name FROM fleet_people WHERE id = ? AND kind = 'person'").get(id);
  if (!row) return fail(kind === "agent" ? "agent_not_found" : "person_not_found", "No such entry.", 404);
  // A person's stop reaches the agents the person owns (§2). A closed card has nothing left to stop.
  const agents = kind === "agent" ? [toAgent(row)] : db.prepare("SELECT id, name, status, keep_running FROM fleet_agents WHERE owner_id = ? AND status <> 'removed' ORDER BY name COLLATE NOCASE, id").all(id).map(toAgent);
  const subjects: ListSubject[] = kind === "agent" ? [{ kind: "agent", id }] : [personSubject(db, id), { kind: "unlinked" }, ...agents.map((a): ListSubject => ({ kind: "agent", id: a.id }))];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const reads = await Promise.all(ACCESS_TARGETS.map((t) => readStore(env, db, t, subjects, { id, agents: byId }, now, budgetMs)));
  const fresh = reads[ACCESS_TARGETS.indexOf("connect")]?.unlinked ?? null;
  return {
    subject: { kind, id, name: String(row.name) },
    asOf: iso(now),
    unlinkedAccounts: kind === "agent" ? 0 : (fresh ?? unlinkedCount(db)),
    stores: [portalStore(topology, agents, id, now), ...reads.map((r) => r.store)],
  };
}
