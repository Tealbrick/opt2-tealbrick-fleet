// The topology answer for the owner (C166, DESIGN §3 `topology_get`, §6): who is who, who owns which agent, who is in which
// team, drawn from Governance's OWN data. Person audience only: the answer carries names, kinds, trust, status, roles and
// owner links, and nothing else. No email, no handle, no tag, no review reason (they stay in `overview_get` and `review_get`).
//
// Layers: `org` is built here from Governance's own data. `contacts` (the Connect contact book, G-5, src/contacts.ts) is read
// ON DEMAND from Connect's `contacts_list` by the handler and passed in; when Connect cannot answer, the layer is `unavailable`
// with a plain note and NO edges. `access` (the Core slice, G-2) is not part of this answer: it is the person op `access_get`
// (src/access.ts), so a requested `access` layer answers `unavailable` and a layer not asked for answers `not_requested`.
// Nothing is invented (L18), nothing is silent (L3). A contact edge runs from an agent to the directory entry that owns the
// handle, or to an "outside" node named by the handle (only here, only for the owner; C88: never in an agent op, hook or feed).
//
// Caps (the draft manifest's maxItems): beyond them the answer is refused with `topology_too_large` (503, transient, like
// `feed_too_large`), never cut. The caps apply to the answer that would be returned, so `focus` still works on a big directory.
import { createHash } from "node:crypto";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { TopologyGetInput, TopologyGetOutput } from "#kit";
import type { ContactRow, ContactsRead } from "./contacts.ts";
import { changedSinceReview, reviewDueDates } from "./reviews.ts";
import { fail } from "./store.ts";

export const TOPOLOGY_CAPS = { nodes: 3000, edges: 10000 } as const;
export const LAYERS = ["org", "contacts", "access"] as const;
export type Layer = (typeof LAYERS)[number];

type Node = TopologyGetOutput["nodes"][number];
type Edge = TopologyGetOutput["edges"][number];
type Source = TopologyGetOutput["sources"]["contacts"];

const NAME_MAX = 200;
const ID_MAX = 64;
const iso = (ms: unknown) => new Date(Number(ms)).toISOString();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Only the owner reads the topology (person audience in the manifest). The handler checks too: an agent, an app or anything else gets `no_access`. */
export function assertTopologyCaller(caller: { type: string }): void {
  if (caller.type !== "person") throw new TbError("no_access", "topology_get is for the owner only", 403);
}

const tooLarge = (what: string, cap: number): never => {
  throw new TbError("topology_too_large", `the topology has more than ${cap} ${what}; narrow it with focus`, 503);
};

/** One warning per left-out id (bounded memory): a legacy row must not flood the log on every call. */
const warned = new Set<string>();
export type Warn = (msg: string, fields: Record<string, string>) => void;
function skip(warn: Warn | undefined, what: string, id: string): void {
  const key = `${what}:${id}`;
  if (warned.has(key)) return;
  if (warned.size >= 1000) warned.clear();
  warned.add(key);
  warn?.(`topology_get leaves out ${what} whose id does not fit the answer`, { what, id: id.slice(0, 80) });
}
const idFits = (id: string): boolean => id.length >= 1 && id.length <= ID_MAX;

/** The plain sentence that says what the two layers are, for every combination (at most 280 characters). */
export function sourceNote(contacts: Source, access: Source, leftOut = 0, contactsNote = ""): string {
  const parts: string[] = [];
  if (contacts === "unavailable") parts.push(contactsNote ? `Channel contacts are not shown. ${contactsNote}` : "Channel contacts are not shown: the Connect contact book is not available to apps yet.");
  if (contacts === "available" && contactsNote) parts.push(`Channel contacts are shown. ${contactsNote}`);
  if (access === "unavailable") parts.push("App access is not part of this answer: see the Access page. Change access in Portal.");
  if (parts.length === 0) parts.push(contacts === "not_requested" && access === "not_requested" ? "Only people, agents and teams were asked for." : contacts === "available" && access !== "available" ? "Channel contacts are shown." : "Contacts and access are shown.");
  // L3: an entry that cannot be carried is counted, not dropped without a word
  if (leftOut > 0) parts.push(`${leftOut} ${leftOut === 1 ? "entry" : "entries"} left out: id too long.`);
  return parts.join(" ");
}

/**
 * `contacts` = what the handler read from Connect (`readContacts`); absent = not read, so a requested contacts layer is
 * `unavailable`. The function itself does no I/O besides the database.
 */
export function topologyGet(db: Db, input: TopologyGetInput, warn?: Warn, contacts?: ContactsRead): TopologyGetOutput {
  const asked = new Set<Layer>(input.layers ?? LAYERS);
  const sourceOf = (layer: Layer): Source => (asked.has(layer) ? "unavailable" : "not_requested");
  const sources: TopologyGetOutput["sources"] = { contacts: sourceOf("contacts"), access: sourceOf("access"), note: "" };

  let nodes: Node[] = [];
  let edges: Edge[] = [];
  let leftOut = 0;
  let contactsNote = contacts?.status === "unavailable" ? contacts.note : "";
  const outside = new Set<string>(); // ids of the outside nodes made from handles (no review to compute)
  if (asked.has("org") || asked.has("contacts")) ({ nodes, edges, leftOut } = orgLayer(db, warn));
  if (asked.has("contacts") && contacts?.status === "available") {
    const made = contactsLayer(db, nodes, edges, contacts.rows, outside);
    sources.contacts = "available";
    contactsNote = [contacts.note, made.skipped > 0 ? `${made.skipped} ${made.skipped === 1 ? "contact" : "contacts"} left out: not a workspace agent.` : ""].filter(Boolean).join(" ");
    if (!asked.has("org")) {
      // only the contacts layer was asked: keep the agents and the entries the contacts name, and the contact edges
      const keep = new Set(edges.filter((e) => e.kind === "contact").flatMap((e) => [e.from, e.to]));
      edges = edges.filter((e) => e.kind === "contact");
      nodes = nodes.filter((n) => keep.has(n.id));
    }
  } else if (!asked.has("org")) {
    nodes = [];
    edges = [];
  }
  sources.note = sourceNote(sources.contacts, sources.access, leftOut, contactsNote);

  if (input.focus !== undefined) {
    const focus = input.focus;
    if (!nodes.some((n) => n.id === focus)) fail("node_not_found", "no person, agent or team with this id in the topology", 404);
    // the node, its direct neighbours, and the edges between all of them
    const keep = new Set<string>([focus]);
    for (const e of edges) {
      if (e.from === focus) keep.add(e.to);
      if (e.to === focus) keep.add(e.from);
    }
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  if (nodes.length > TOPOLOGY_CAPS.nodes) tooLarge("nodes", TOPOLOGY_CAPS.nodes);
  if (edges.length > TOPOLOGY_CAPS.edges) tooLarge("edges", TOPOLOGY_CAPS.edges);

  // trust, due date and "changed since review" come from the review logic (src/reviews.ts); computed only for an answer that fits,
  // and the changed flags only for the nodes in it (a focused answer stays cheap)
  const due = reviewDueDates(db);
  const changed = changedSinceReview(db, new Set(nodes.filter((n) => n.kind !== "team" && !outside.has(n.id)).map((n) => `${n.kind}:${n.id}`)));
  for (const n of nodes) {
    if (n.kind === "team" || outside.has(n.id)) continue;
    const key = `${n.kind}:${n.id}`;
    n.reviewDueAt = due.get(key) ?? null;
    n.changedSinceReview = changed.has(key);
  }
  return { nodes, edges, sources };
}

type Row = Record<string, unknown>;
const KIND_ORDER: Record<Node["kind"], number> = { person: 0, outside_agent: 1, agent: 2, app: 3, team: 4 };

/** People, outside agents, agents and teams; `owner` and `member` edges. Four reads, none per node. */
function orgLayer(db: Db, warn?: Warn): { nodes: Node[]; edges: Edge[]; leftOut: number } {
  const nodes: Node[] = [];
  let leftOut = 0;
  const byId = new Map<string, Node>();
  const add = (n: Node): void => {
    if (!idFits(n.id)) {
      skip(warn, `a ${n.kind}`, n.id);
      leftOut++;
      return;
    }
    nodes.push(n);
    byId.set(n.id, n);
  };
  const base = { reviewDueAt: null, changedSinceReview: false } as const;

  for (const p of db.prepare("SELECT id, name, kind, status, trust FROM fleet_people ORDER BY name COLLATE NOCASE, id").all() as Row[]) {
    add({ id: String(p.id), kind: p.kind as Node["kind"], name: clip(String(p.name), NAME_MAX), trust: p.trust as Node["trust"], status: String(p.status), ...base });
  }
  // removed agents only while a team still names them (so the owner can see and drop the member), like directory_feed
  for (const a of db
    .prepare("SELECT id, name, status, trust FROM fleet_agents WHERE status <> 'removed' OR id IN (SELECT subject_id FROM fleet_members WHERE kind = 'agent') ORDER BY name COLLATE NOCASE, id")
    .all() as Row[]) {
    add({ id: String(a.id), kind: "agent", name: clip(String(a.name), NAME_MAX), trust: a.trust as Node["trust"], status: String(a.status), ...base });
  }
  for (const t of db.prepare("SELECT id, name FROM fleet_teams ORDER BY name COLLATE NOCASE, id").all() as Row[]) {
    add({ id: String(t.id), kind: "team", name: clip(String(t.name), NAME_MAX), trust: null, status: "active", ...base });
  }
  nodes.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind]); // stable: name, id order inside a kind

  const edges: Edge[] = [];
  /** A wire is blocked when either end is blocked, off when either end is not active, else live. A hold is Rules' business, so `held` is not used here. */
  const stateOf = (a: Node, b: Node): Edge["state"] => (a.trust === "blocked" || b.trust === "blocked" ? "blocked" : a.status !== "active" || b.status !== "active" ? "off" : "live");
  const wire = (kind: "owner" | "member", from: string, to: string, label: string, since: string | null): void => {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) return; // dangling, or left out above
    edges.push({ id: `${kind}:${from}:${to}`, kind, from, to, label, state: stateOf(a, b), since });
  };
  for (const a of db.prepare("SELECT id, owner_id FROM fleet_agents WHERE owner_id IS NOT NULL ORDER BY id").all() as Row[]) wire("owner", String(a.owner_id), String(a.id), "owns", null);
  for (const m of db.prepare("SELECT team_id, subject_id, role, created_at FROM fleet_members ORDER BY team_id, kind, subject_id").all() as Row[]) {
    wire("member", String(m.subject_id), String(m.team_id), String(m.role), iso(m.created_at));
  }
  edges.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "owner" ? -1 : 1));
  return { nodes, edges, leftOut };
}

const short = (s: string, max: number): string => (Array.from(s).length > max ? `${Array.from(s).slice(0, max - 1).join("")}…` : s);
/** The id of the outside node for a handle: stable, 28 characters, and never a directory id. */
export const outsideId = (handle: string): string => `ext_${createHash("sha256").update(handle).digest("hex").slice(0, 24)}`;

/**
 * Contact edges: agent → the directory entry that owns the handle (fleet_handles), else agent → an outside node named by the
 * handle. One edge per (agent, target); its label lists the channels; `since` = the earliest first contact. A contact whose agent
 * is not a node of this answer (removed, unknown) is skipped and counted. Mutates `nodes` and `edges`.
 */
function contactsLayer(db: Db, nodes: Node[], edges: Edge[], rows: readonly ContactRow[], outside: Set<string>): { skipped: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const owner = new Map<string, string>();
  for (const r of db.prepare("SELECT handle, person_id FROM fleet_handles").all() as Row[]) owner.set(String(r.handle), String(r.person_id));
  const wires = new Map<string, { from: string; to: string; channels: Set<string>; since: number }>();
  let skipped = 0;
  for (const c of rows) {
    const agent = byId.get(c.agent);
    if (agent?.kind !== "agent") {
      skipped++;
      continue;
    }
    let target = owner.get(c.handle);
    if (!target || !byId.has(target)) {
      target = outsideId(c.handle);
      if (!byId.has(target)) {
        const n: Node = { id: target, kind: "outside_agent", name: short(c.handle, NAME_MAX), trust: null, status: "active", reviewDueAt: null, changedSinceReview: false };
        nodes.push(n);
        byId.set(target, n);
        outside.add(target);
      }
    }
    const id = `contact:${c.agent}:${target}`;
    const w = wires.get(id) ?? { from: c.agent, to: target, channels: new Set<string>(), since: c.firstContactAt };
    w.channels.add(c.channel);
    w.since = Math.min(w.since, c.firstContactAt);
    wires.set(id, w);
  }
  for (const [id, w] of [...wires].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const a = byId.get(w.from) as Node;
    const b = byId.get(w.to) as Node;
    const state: Edge["state"] = a.trust === "blocked" || b.trust === "blocked" ? "blocked" : a.status !== "active" || b.status !== "active" ? "off" : "live";
    edges.push({ id, kind: "contact", from: w.from, to: w.to, label: short([...w.channels].sort().join(", "), 80), state, since: w.since > 0 ? iso(w.since) : null });
  }
  nodes.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind]);
  return { skipped };
}
