// The topology picture as numbers (C373 WP-D, DESIGN §6 "canvas look"): a deterministic layered layout of the
// `topology_get` answer, computed in plain TypeScript with no DOM, so the server, a test or the UI get the same picture.
//
// Columns, left to right: people → agents → apps → the dashed "outside the workspace" region (outside agents, and people
// who are only reached as contacts). Teams are regions (bands) that span the people and agents columns; a person or agent
// sits in the band of its first team (by team name), and a further team membership is drawn as a wire to that team's
// region. Read only: no ports, no drag. The same input always gives the same output (sorted by name, then id; no
// randomness, no measurement), whatever order the input lists things in.
//
// Caps: a big workspace (500 agents) is not drawn in full. Each group shows its first N (by name) and the answer says how
// many are left out, so the page can say "+M more — see the table" (the Relationships table stays the accessible
// equivalent and lists everything).
import type { TopologyGetOutput } from "#kit";

export type TopoNode = TopologyGetOutput["nodes"][number];
export type TopoEdge = TopologyGetOutput["edges"][number];
/** What the graph draws: the `topology_get` answer's nodes and edges (sources are the page's business). */
export interface GraphInput {
  nodes: readonly TopoNode[];
  edges: readonly TopoEdge[];
}

export type Group = "people" | "agents" | "apps" | "outside" | "teams";
export type Caps = Record<Group, number>;
export const GRAPH_CAPS: Caps = { people: 40, agents: 60, apps: 30, outside: 30, teams: 20 };

/** Sizes in CSS pixels (the SVG user unit). */
export const GEOMETRY = {
  nodeW: 200,
  nodeH: 60,
  rowGap: 14,
  colGap: 120,
  pad: 14,
  regionHead: 30,
  bandGap: 22,
  margin: 12,
  emptyRegion: 26,
  /** characters of a name that fit on a card (bold 15px); longer names end in "…" and keep the full text in the title */
  nameChars: 18,
  labelChars: 22,
  /** estimated width of one label character (bold 12px) and the label pill's height, for placing labels apart */
  labelCharW: 6.8,
  labelH: 22,
  metaChars: 26,
  /** wire labels are drawn only while the picture stays readable */
  labelMax: 30,
} as const;

export type WireClass = "own" | "live" | "held" | "off" | "blocked";

export interface PlacedNode {
  id: string;
  kind: TopoNode["kind"];
  /** the column group: "outside" for outside agents and for people only reached as contacts */
  group: Exclude<Group, "teams">;
  /** the full name (title / aria-label) */
  name: string;
  /** the name as drawn: at most GEOMETRY.nameChars characters */
  label: string;
  initial: string;
  meta: string;
  trust: TopoNode["trust"];
  status: string;
  changedSinceReview: boolean;
  /** the team whose region it sits in, or null */
  team: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Region {
  /** the team id, or "outside" for the outside region */
  id: string;
  kind: "team" | "outside";
  name: string;
  label: string;
  empty: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Wire {
  id: string;
  kind: TopoEdge["kind"];
  from: string;
  to: string;
  state: TopoEdge["state"];
  cls: WireClass;
  d: string;
  label: string | null;
  /** the label's centre and estimated width (a label is moved up or down until it covers no card and no other label, or dropped) */
  lx: number;
  ly: number;
  lw: number;
}
export interface GraphLayout {
  width: number;
  height: number;
  regions: Region[];
  nodes: PlacedNode[];
  wires: Wire[];
  /** how many of each group the input has */
  total: Record<Group, number> & { edges: number };
  /** how many of each group are left out by the caps (edges: left out because an end is not drawn) */
  hidden: Record<Group, number> & { edges: number };
  /** member edges shown by a node sitting inside its team's region (not drawn as a wire, not hidden) */
  contained: number;
}

export const KIND_WORD: Record<TopoNode["kind"], string> = { person: "Person", outside_agent: "Outside agent", agent: "Agent", app: "App", team: "Team" };
/** the kind on a card's meta line: short, so "Outside · unreviewed" fits the card (the full kind is in the aria-label) */
const META_KIND: Record<TopoNode["kind"], string> = { ...KIND_WORD, outside_agent: "Outside" };
const TRUST_WORD: Record<NonNullable<TopoNode["trust"]>, string> = { unreviewed: "unreviewed", trusted: "trusted", limited: "limited", blocked: "blocked" };

/** Cut a text to `max` characters (code points, so an emoji is never split), ending in "…" when cut. */
export function fit(text: string, max: number): string {
  const chars = Array.from(text.trim().replace(/\s+/g, " "));
  if (chars.length <= max) return chars.join("");
  return `${chars
    .slice(0, Math.max(1, max - 1))
    .join("")
    .trimEnd()}…`;
}
const initialOf = (name: string): string => (Array.from(name.trim())[0] ?? "?").toUpperCase();
/** Byte order, not locale order: the same on every machine. */
const byName = (a: TopoNode, b: TopoNode): number => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The meta line of a card: kind, trust, and a status that is not "active". */
export function metaOf(n: TopoNode): string {
  const parts = [META_KIND[n.kind]];
  if (n.trust) parts.push(TRUST_WORD[n.trust]);
  if (n.status && n.status !== "active") parts.push(n.status);
  return parts.join(" · ");
}

/** The words on a wire. */
export function relationLabel(e: TopoEdge): string {
  if (e.kind === "owner") return "owns";
  if (e.kind === "member") return e.label === "lead" ? "leads" : "member";
  return e.label;
}

/** Wire look: blocked and held win over the kind; owner and member wires are ink, the others teal while live. */
export function wireClass(e: TopoEdge): WireClass {
  if (e.state === "blocked") return "blocked";
  if (e.state === "held") return "held";
  if (e.state === "off") return "off";
  return e.kind === "owner" || e.kind === "member" ? "own" : "live";
}

/** Lay out the topology. Pure and deterministic. */
export function layoutGraph(input: GraphInput, caps: Partial<Caps> = {}): GraphLayout {
  const cap: Caps = { ...GRAPH_CAPS, ...caps };
  const G = GEOMETRY;
  const ids = new Set<string>();
  const nodes: TopoNode[] = [];
  for (const n of input.nodes) {
    if (ids.has(n.id)) continue; // a repeated id is drawn once
    ids.add(n.id);
    nodes.push(n);
  }
  nodes.sort(byName);
  const edges = [...input.edges].filter((e) => ids.has(e.from) && ids.has(e.to)).sort(byId);

  // a person is "outside" when the only way it is reached is as the target of contact edges
  const contactOnly = new Set<string>();
  const tied = new Set<string>();
  for (const e of edges) {
    if (e.kind === "contact") contactOnly.add(e.to);
    else tied.add(e.to);
    tied.add(e.from);
  }
  const groupOf = (n: TopoNode): Group => {
    if (n.kind === "team") return "teams";
    if (n.kind === "agent") return "agents";
    if (n.kind === "app") return "apps";
    if (n.kind === "outside_agent") return "outside";
    return contactOnly.has(n.id) && !tied.has(n.id) ? "outside" : "people";
  };
  const groups: Record<Group, TopoNode[]> = { people: [], agents: [], apps: [], outside: [], teams: [] };
  for (const n of nodes) groups[groupOf(n)].push(n);

  const total = { people: groups.people.length, agents: groups.agents.length, apps: groups.apps.length, outside: groups.outside.length, teams: groups.teams.length, edges: edges.length };
  const shown: Record<Group, TopoNode[]> = { people: [], agents: [], apps: [], outside: [], teams: [] };
  for (const g of Object.keys(groups) as Group[]) shown[g] = groups[g].slice(0, Math.max(0, Math.floor(cap[g])));
  const hidden = {
    people: total.people - shown.people.length,
    agents: total.agents - shown.agents.length,
    apps: total.apps - shown.apps.length,
    outside: total.outside - shown.outside.length,
    teams: total.teams - shown.teams.length,
    edges: 0,
  };
  const visible = new Set<string>();
  for (const g of Object.keys(shown) as Group[]) for (const n of shown[g]) visible.add(n.id);

  // primary team: the first visible team (by name) a node is a member of
  const teamOrder = new Map(shown.teams.map((t, i) => [t.id, i]));
  const primary = new Map<string, string>();
  for (const e of edges) {
    if (e.kind !== "member" || !visible.has(e.from) || !teamOrder.has(e.to)) continue;
    const cur = primary.get(e.from);
    if (cur === undefined || (teamOrder.get(e.to) as number) < (teamOrder.get(cur) as number)) primary.set(e.from, e.to);
  }

  // columns: the band columns (people, agents) exist when they have a node; at least one column for the regions
  const bandKinds: ("people" | "agents")[] = [];
  if (shown.people.length > 0) bandKinds.push("people");
  if (shown.agents.length > 0) bandKinds.push("agents");
  if (bandKinds.length === 0 && shown.teams.length > 0) bandKinds.push("people");
  const colX = new Map<string, number>();
  let x = G.margin + G.pad;
  for (const k of bandKinds) {
    colX.set(k, x);
    x += G.nodeW + G.colGap;
  }
  if (shown.apps.length > 0) {
    colX.set("apps", x);
    x += G.nodeW + G.colGap;
  }
  if (shown.outside.length > 0) {
    colX.set("outside", x + G.pad);
    x += G.nodeW + 2 * G.pad + G.colGap;
  }

  const placed: PlacedNode[] = [];
  const at = new Map<string, PlacedNode>();
  const place = (n: TopoNode, px: number, py: number, team: string | null): void => {
    const p: PlacedNode = {
      id: n.id,
      kind: n.kind,
      group: groupOf(n) as Exclude<Group, "teams">,
      name: n.name,
      label: fit(n.name, G.nameChars),
      initial: initialOf(n.name),
      meta: fit(metaOf(n), G.metaChars),
      trust: n.trust,
      status: n.status,
      changedSinceReview: n.changedSinceReview,
      team,
      x: px,
      y: py,
      w: G.nodeW,
      h: G.nodeH,
    };
    placed.push(p);
    at.set(n.id, p);
  };
  const rowsHeight = (rows: number) => (rows <= 0 ? 0 : rows * G.nodeH + (rows - 1) * G.rowGap);

  // bands: one per visible team (a region), then the people and agents in no visible team (no region)
  const regions: Region[] = [];
  const firstCol = colX.get(bandKinds[0] ?? "people") ?? G.margin + G.pad;
  const lastCol = colX.get(bandKinds[bandKinds.length - 1] ?? "people") ?? firstCol;
  const regionX = firstCol - G.pad;
  const regionW = lastCol + G.nodeW + G.pad - regionX;
  let y = G.margin;
  const bands: { team: TopoNode | null; people: TopoNode[]; agents: TopoNode[] }[] = shown.teams.map((t) => ({ team: t, people: [], agents: [] }));
  const loose = { team: null, people: [] as TopoNode[], agents: [] as TopoNode[] };
  const bandOf = new Map(bands.map((b) => [b.team?.id, b]));
  for (const k of ["people", "agents"] as const) {
    for (const n of shown[k]) {
      const t = primary.get(n.id);
      (t === undefined ? loose : (bandOf.get(t) ?? loose))[k].push(n);
    }
  }
  for (const b of [...bands, loose]) {
    const rows = Math.max(b.people.length, b.agents.length);
    if (b.team === null && rows === 0) continue;
    const head = b.team ? G.regionHead : 0;
    const inner = b.team && rows === 0 ? G.emptyRegion : rowsHeight(rows);
    const h = head + inner + (b.team ? G.pad : 0);
    if (b.team) regions.push({ id: b.team.id, kind: "team", name: b.team.name, label: fit(b.team.name, 40), empty: rows === 0, x: regionX, y, w: regionW, h });
    for (const k of ["people", "agents"] as const) {
      const cx = colX.get(k);
      if (cx === undefined) continue;
      b[k].forEach((n, i) => {
        place(n, cx, y + head + i * (G.nodeH + G.rowGap), b.team?.id ?? null);
      });
    }
    y += h + G.bandGap;
  }
  let height = y - G.bandGap;

  // apps column, top to bottom
  const ax = colX.get("apps");
  if (ax !== undefined) {
    shown.apps.forEach((n, i) => {
      place(n, ax, G.margin + i * (G.nodeH + G.rowGap), null);
    });
    height = Math.max(height, G.margin + rowsHeight(shown.apps.length));
  }
  // the outside region
  const ox = colX.get("outside");
  if (ox !== undefined) {
    const h = G.regionHead + rowsHeight(shown.outside.length) + G.pad;
    regions.push({ id: "outside", kind: "outside", name: "Outside the workspace", label: "Outside the workspace", empty: false, x: ox - G.pad, y: G.margin, w: G.nodeW + 2 * G.pad, h });
    shown.outside.forEach((n, i) => {
      place(n, ox, G.margin + G.regionHead + i * (G.nodeH + G.rowGap), null);
    });
    height = Math.max(height, G.margin + h);
  }

  // wires
  const regionAt = new Map(regions.map((r) => [r.id, r]));
  const wires: Wire[] = [];
  const curves = new Map<string, Curve>();
  let contained = 0;
  for (const e of edges) {
    const a = at.get(e.from);
    if (e.kind === "member" && a && primary.get(e.from) === e.to) {
      contained++;
      continue;
    }
    const b = at.get(e.to);
    const r = e.kind === "member" ? regionAt.get(e.to) : undefined;
    if (!a || (!b && !r)) {
      hidden.edges++;
      continue;
    }
    const [x1, y1, x2, y2, bend] = b ? ends(a, b) : [a.x + a.w, a.y + a.h / 2, (r as Region).x + (r as Region).w, (r as Region).y + G.regionHead / 2, 48];
    const same = bend !== 0;
    const mx = same ? Math.max(x1, x2) + bend : (x1 + x2) / 2;
    const d = `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
    curves.set(e.id, { x1, y1, mx, y2, x2 });
    const lx = same ? (x1 + x2) / 2 + bend * 0.75 : mx;
    const label = fit(relationLabel(e), G.labelChars);
    wires.push({ id: e.id, kind: e.kind, from: e.from, to: e.to, state: e.state, cls: wireClass(e), d, label, lx: round(lx), ly: round((y1 + y2) / 2), lw: round(Array.from(label).length * G.labelCharW + 20) });
  }
  if (wires.length > G.labelMax) for (const w of wires) w.label = null;
  else placeLabels(wires, placed, curves);

  // the picture's size: the furthest card, region or bend, plus the margin (0 × 0 when there is nothing to draw)
  const boxes = [...placed, ...regions];
  const empty = boxes.length === 0;
  const labelled = wires.filter((w) => w.label !== null);
  const right = Math.max(0, ...boxes.map((b) => b.x + b.w), ...labelled.map((w) => w.lx + w.lw / 2));
  const bottom = Math.max(height, ...boxes.map((b) => b.y + b.h), ...labelled.map((w) => w.ly + G.labelH / 2));
  return { width: empty ? 0 : round(right + G.margin), height: empty ? 0 : round(bottom + G.margin), regions, nodes: placed, wires, total, hidden, contained };
}

const round = (v: number): number => Math.round(v * 10) / 10;

/** The control data of a wire's curve `M x1 y1 C mx y1 mx y2 x2 y2`. */
interface Curve {
  x1: number;
  y1: number;
  mx: number;
  y2: number;
  x2: number;
}
/** A point on the curve at t in [0, 1]. */
function pointAt(c: Curve, t: number): [number, number] {
  const u = 1 - t;
  const x = u * u * u * c.x1 + 3 * u * u * t * c.mx + 3 * u * t * t * c.mx + t * t * t * c.x2;
  const y = u * u * u * c.y1 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y2;
  return [x, y];
}
/** Where on the wire a label may sit, best first: the middle, then further out on both sides (an offset ALONG the wire). */
const LABEL_T = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82] as const;

/** Place each label ON its own wire, at the middle if that is free, else at the nearest free point along the wire (so several
 * wires into one node do not stack their labels). A label may not cover a card or a label placed before it. If no point
 * along the wire is free, the old rule applies (move up or down in steps of a label height, at most four); a label with no
 * free place at all is dropped (the wire stays, the table has the words). */
function placeLabels(wires: Wire[], cards: readonly PlacedNode[], curves: ReadonlyMap<string, Curve>): void {
  const G = GEOMETRY;
  const gap = 3;
  const taken: { x: number; y: number; w: number; h: number }[] = cards.map((c) => ({ x: c.x - 4, y: c.y - 4, w: c.w + 8, h: c.h + 8 }));
  const hits = (b: { x: number; y: number; w: number; h: number }) => taken.some((t) => b.x < t.x + t.w && t.x < b.x + b.w && b.y < t.y + t.h && t.y < b.y + b.h);
  const step = G.labelH + 4;
  for (const w of wires) {
    if (w.label === null) continue;
    const curve = curves.get(w.id);
    const candidates: [number, number][] = [];
    if (curve) for (const t of LABEL_T) candidates.push(pointAt(curve, t));
    for (const dy of [0, step, -step, 2 * step, -2 * step, 3 * step, -3 * step, 4 * step, -4 * step]) candidates.push([w.lx, w.ly + dy]);
    let done = false;
    for (const [cx, cy] of candidates) {
      const box = { x: cx - w.lw / 2 - gap, y: cy - G.labelH / 2 - gap, w: w.lw + 2 * gap, h: G.labelH + 2 * gap };
      if (box.y < 0 || box.x < 0 || hits(box)) continue;
      w.lx = round(cx);
      w.ly = round(cy);
      taken.push(box);
      done = true;
      break;
    }
    if (!done) w.label = null;
  }
}

/** The two ends of a wire between cards: right side → left side across columns; the right sides with a bend in one column. */
function ends(a: PlacedNode, b: PlacedNode): [number, number, number, number, number] {
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  if (b.x > a.x) return [a.x + a.w, ay, b.x, by, 0];
  if (b.x < a.x) return [a.x, ay, b.x + b.w, by, 0];
  return [a.x + a.w, ay, b.x + b.w, by, 40];
}

/** The plain summary of the picture for the aria-label: what is drawn and what is not. */
export function graphSummary(l: GraphLayout): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const drawn = (g: Group) => l.total[g] - l.hidden[g];
  const parts = [
    n(drawn("people"), "person", "people"),
    n(drawn("agents"), "agent", "agents"),
    n(drawn("teams"), "team", "teams"),
    n(drawn("apps"), "app", "apps"),
    n(drawn("outside"), "outside contact", "outside contacts"),
    n(l.wires.length + l.contained, "link", "links"),
  ];
  const more = moreNote(l);
  return `Topology graph, read only: ${parts.join(", ")}.${more ? ` ${more}` : ""}`;
}

/** "+M more — see the table." when the caps left something out; "" when everything is drawn. */
export function moreNote(l: GraphLayout): string {
  const words: [Group | "edges", string, string][] = [
    ["people", "person", "people"],
    ["agents", "agent", "agents"],
    ["teams", "team", "teams"],
    ["apps", "app", "apps"],
    ["outside", "outside contact", "outside contacts"],
  ];
  const parts = words.filter(([g]) => l.hidden[g] > 0).map(([g, one, many]) => `+${l.hidden[g]} more ${l.hidden[g] === 1 ? one : many}`);
  if (parts.length === 0) return "";
  return `${parts.join(", ")} — see the table.`;
}
