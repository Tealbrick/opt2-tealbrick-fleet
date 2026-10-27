// The grant view as rows (C373 WP-D): who may use which app, built from the workspace's access copy (`SliceTopology`,
// see access-types.ts) plus the directory's agents and their Connect channel identities. Pure, no DOM, unit-tested.
//
// Guards: a row only ever shows an agent the page knows AND the slice names. An edge, connection, companion or identity
// that names an unknown agent or app is left out and counted (L3: never silent), never shown under another agent. An
// agent's channel identities are only its own. Governance changes nothing here: access is changed in Portal.
import type { AccessAgent, ChannelIdentity, Crud, SliceTopology } from "./access-types.ts";
import type { GraphInput, TopoEdge, TopoNode } from "./graph-layout.ts";

const CRUD_ORDER: readonly Crud[] = ["create", "read", "update", "delete"];
const CRUD_WORD: Record<Crud, string> = { create: "create", read: "read", update: "update", delete: "delete" };
const isCrud = (v: string): v is Crud => (CRUD_ORDER as readonly string[]).includes(v);

/** "CRU" for create, read, update (always in C R U D order; unknown words ignored); "None" when nothing. */
export function crudLetters(crud: readonly string[]): string {
  const set = new Set(crud.filter(isCrud));
  const out = CRUD_ORDER.filter((c) => set.has(c))
    .map((c) => c.charAt(0).toUpperCase())
    .join("");
  return out || "None";
}
/** "Create, read, update" (the same in words, for a title or a screen reader); "No access" when nothing. */
export function crudWords(crud: readonly string[]): string {
  const set = new Set(crud.filter(isCrud));
  const words = CRUD_ORDER.filter((c) => set.has(c)).map((c) => CRUD_WORD[c]);
  if (words.length === 0) return "No access";
  const s = words.join(", ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
const byNameThenId = (a: { name: string; id: string }, b: { name: string; id: string }): number => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id);

export interface AppRow {
  ins: string;
  product: string;
  app: string;
  version: string;
  crud: Crud[];
  letters: string;
  words: string;
  mode: string;
  held: string[];
  workflowOps: number;
  paused: boolean;
}
export interface AgentAccess {
  id: string;
  name: string;
  connections: { con: string; method: "key" | "pairing"; status: "active" | "revoked" }[];
  identities: { channel: string; handle: string }[];
  apps: AppRow[];
}
export interface AppAgentRow {
  id: string;
  name: string;
  letters: string;
  words: string;
  mode: string;
  held: string[];
  workflowOps: number;
  paused: boolean;
}
export interface AppCaller {
  ins: string;
  name: string;
  letters: string;
  words: string;
  ops: number;
}
export interface AppAccess {
  ins: string;
  product: string;
  name: string;
  version: string;
  agents: AppAgentRow[];
  callers: AppCaller[];
}
export interface AccessView {
  agents: AgentAccess[];
  apps: AppAccess[];
  /** entries in the slice or the identities that name an agent or app this page does not know (left out, counted) */
  leftOut: number;
}

/** Build both views (by agent, by app) from the slice, the known agents and their channel identities. */
export function accessView(slice: SliceTopology, agents: readonly AccessAgent[], identities: readonly ChannelIdentity[]): AccessView {
  let leftOut = 0;
  const known = new Map<string, AccessAgent>();
  for (const a of agents) if (!known.has(a.id)) known.set(a.id, a);
  const instances = new Map<string, SliceTopology["instances"][number]>();
  for (const i of slice.instances) if (!instances.has(i.ins)) instances.set(i.ins, i);

  const byAgent = new Map<string, AgentAccess>();
  for (const a of [...known.values()].sort(byNameThenId)) byAgent.set(a.id, { id: a.id, name: a.name, connections: [], identities: [], apps: [] });

  const seen = new Set<string>();
  for (const e of slice.edges) {
    const who = byAgent.get(e.agent);
    const ins = instances.get(e.ins);
    const key = `${e.agent}\u0000${e.ins}`;
    if (!who || !ins || seen.has(key)) {
      leftOut++;
      continue;
    }
    seen.add(key);
    const crud = CRUD_ORDER.filter((c) => e.crud.includes(c));
    who.apps.push({
      ins: ins.ins,
      product: ins.product,
      app: ins.name,
      version: ins.version,
      crud,
      letters: crudLetters(crud),
      words: crudWords(crud),
      mode: e.mode,
      held: [...e.held].sort(cmp),
      workflowOps: e.wf?.length ?? 0,
      paused: e.paused === true,
    });
  }
  for (const c of slice.connections) {
    const who = byAgent.get(c.agt);
    if (!who) {
      leftOut++;
      continue;
    }
    who.connections.push({ con: c.con, method: c.method, status: c.status });
  }
  for (const i of identities) {
    const who = byAgent.get(i.agent);
    if (!who) {
      leftOut++;
      continue;
    }
    who.identities.push({ channel: i.channel, handle: i.handle });
  }
  for (const a of byAgent.values()) {
    a.apps.sort((x, y) => cmp(x.app.toLowerCase(), y.app.toLowerCase()) || cmp(x.ins, y.ins));
    a.connections.sort((x, y) => (x.status === y.status ? cmp(x.con, y.con) : x.status === "active" ? -1 : 1));
    a.identities.sort((x, y) => cmp(x.channel, y.channel) || cmp(x.handle, y.handle));
  }

  // by app: every known instance, the agents that may use it, and the apps that may call it
  const apps = [...instances.values()]
    .map((i): AppAccess => ({ ins: i.ins, product: i.product, name: i.name, version: i.version, agents: [], callers: [] }))
    .sort((a, b) => byNameThenId({ name: a.name, id: a.ins }, { name: b.name, id: b.ins }));
  const appAt = new Map(apps.map((a) => [a.ins, a]));
  for (const a of byAgent.values()) {
    for (const r of a.apps) {
      appAt.get(r.ins)?.agents.push({ id: a.id, name: a.name, letters: r.letters, words: r.words, mode: r.mode, held: r.held, workflowOps: r.workflowOps, paused: r.paused });
    }
  }
  const callerSeen = new Set<string>();
  for (const c of slice.companions) {
    const to = appAt.get(c.to);
    const from = instances.get(c.from);
    const key = `${c.from}\u0000${c.to}`;
    if (!to || !from || callerSeen.has(key)) {
      leftOut++;
      continue;
    }
    callerSeen.add(key);
    to.callers.push({ ins: from.ins, name: from.name, letters: crudLetters(c.crud), words: crudWords(c.crud), ops: c.ops?.length ?? 0 });
  }
  for (const a of apps) a.callers.sort((x, y) => byNameThenId({ name: x.name, id: x.ins }, { name: y.name, id: y.ins }));

  return { agents: [...byAgent.values()], apps, leftOut };
}

/** Narrow a view to one agent and/or one app. Entries with nothing left under the filter drop out. */
export function filterAccess(view: AccessView, filter: { agent?: string; app?: string }): AccessView {
  const { agent, app } = filter;
  const agents = view.agents
    .filter((a) => !agent || a.id === agent)
    .map((a) => (app ? { ...a, apps: a.apps.filter((r) => r.ins === app) } : a))
    .filter((a) => !app || a.apps.length > 0);
  const apps = view.apps
    .filter((a) => !app || a.ins === app)
    .map((a) => (agent ? { ...a, agents: a.agents.filter((r) => r.id === agent) } : a))
    .filter((a) => !agent || a.agents.length > 0);
  return { agents, apps, leftOut: view.leftOut };
}

/**
 * The "App access" layer of the graph: the topology input plus one app node per instance and the `access` (agent → app)
 * and `companion` (app → app) edges from the slice. An access edge is added only for an agent that is already a node in
 * the topology (nothing is invented); a paused grant is an "off" wire.
 */
export function withAccess(input: GraphInput, slice: SliceTopology): GraphInput {
  const nodes: TopoNode[] = [...input.nodes];
  const ids = new Set(nodes.map((n) => n.id));
  const agentIds = new Set(nodes.filter((n) => n.kind === "agent").map((n) => n.id));
  const apps = new Set<string>();
  for (const i of [...slice.instances].sort((a, b) => cmp(a.ins, b.ins))) {
    if (ids.has(i.ins)) continue; // an id clash with a person, agent or team: never overwrite a node
    ids.add(i.ins);
    apps.add(i.ins);
    nodes.push({ id: i.ins, kind: "app", name: i.name, trust: null, status: "active", reviewDueAt: null, changedSinceReview: false });
  }
  const edges: TopoEdge[] = [...input.edges];
  const edgeIds = new Set(edges.map((e) => e.id));
  const push = (e: TopoEdge) => {
    if (edgeIds.has(e.id)) return;
    edgeIds.add(e.id);
    edges.push(e);
  };
  for (const e of slice.edges) {
    if (!agentIds.has(e.agent) || !apps.has(e.ins)) continue;
    push({ id: `access:${e.agent}:${e.ins}`, kind: "access", from: e.agent, to: e.ins, label: crudLetters(e.crud), state: e.paused ? "off" : "live", since: null });
  }
  for (const c of slice.companions) {
    if (!apps.has(c.from) || !apps.has(c.to) || c.from === c.to) continue;
    push({ id: `companion:${c.from}:${c.to}`, kind: "companion", from: c.from, to: c.to, label: crudLetters(c.crud), state: "live", since: null });
  }
  return { nodes, edges };
}

/**
 * The graph's "App access" layer on its own (the mockup's Layers toggle: People and contacts / App access): people,
 * agents and teams with their owner and member edges, plus the apps and the access and companion edges. Contact edges,
 * outside agents and people only reached as contacts are left out (they belong to the other layer).
 */
export function accessLayer(input: GraphInput, slice: SliceTopology): GraphInput {
  const contactOnly = new Set(input.edges.filter((e) => e.kind === "contact").map((e) => e.to));
  for (const e of input.edges) if (e.kind !== "contact") contactOnly.delete(e.to);
  for (const e of input.edges) contactOnly.delete(e.from);
  const nodes = input.nodes.filter((n) => n.kind !== "outside_agent" && n.kind !== "app" && !contactOnly.has(n.id));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = input.edges.filter((e) => (e.kind === "owner" || e.kind === "member") && keep.has(e.from) && keep.has(e.to));
  return withAccess({ nodes, edges }, slice);
}
