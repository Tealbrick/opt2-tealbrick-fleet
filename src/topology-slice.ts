// The grant picture from the verified slice (C373 WP-D, G-2), server side. Core copies "who may use which app" into the
// slice of an app that declares `needsTopology` and that the owner allowed to see it (consent `topology`). The SDK reads
// it with `ctx.topology()` (SDK 0.1.43, spec 0.1.87), which validates it and hands the agent ids of the same slice. This module
// cleans it once more (second line of defence: a bad row is dropped and flagged, never an error) and decodes it.
//
// DISPLAY ONLY. Nothing here authorizes anything; the bridge and the SDK decide every call from the signed grant.
//
// Compact (tuple) form, as Core sends it:
//   { v: 1,
//     instances:   [ins, product, name, version][],
//     edges:       [agentIdx, instIdx, crud, mode "f"|"b", held bitmask, wfCount, paused 0|1][],
//     companions:  [fromIdx, toIdx, crud, opsCount][],
//     connections: [con, agentIdx, "k"|"p", "a"|"r"][],
//     truncated?: true }
// `agentIdx` indexes the SAME slice's `agents[]` (`ctx.topology().agentIds`); the other indexes point into `instances`.
// The decoded (object) form below is what the Access page and the graph read (src/ui/access-types.ts is the same shape).
import { HOLD_FAMILIES } from "@opt2-tealbrick/manifest";

/** Bounds of each list (spec 0.1.87 `TOPOLOGY_MAX`, the slice schema's maxItems). A longer list is cut and the picture is marked truncated. */
export const TOPOLOGY_MAX = { instances: 40, edges: 600, companions: 100, connections: 300 } as const;
/** `held` is a 31-bit mask (spec 0.1.87 `TOPOLOGY_HELD_MASK_MAX`). */
export const HELD_MASK_MAX = 0x7fff_ffff;
export const OPS_COUNT_MAX = 128;
const CRUD_PATTERN = /^c?r?u?d?$/;

/**
 * The bit order of `held`: bit i = HOLD_FAMILIES[i]. Append-only in the spec. The pinned manifest package exports the list
 * as `HOLD_FAMILIES`; `MANIFEST_HOLD_FAMILIES` (the spec 0.1.87 name) is the same array. `test/access-get.test.ts` pins today's order.
 */
export const HELD_BITS: readonly string[] = HOLD_FAMILIES;

export type CompactInstance = [ins: string, product: string, name: string, version: string];
export type CompactEdge = [agentIdx: number, instIdx: number, crud: string, mode: "f" | "b", held: number, wfCount: number, paused: 0 | 1];
export type CompactCompanion = [fromIdx: number, toIdx: number, crud: string, opsCount: number];
export type CompactConnection = [con: string, agentIdx: number, method: "k" | "p", status: "a" | "r"];
export interface CompactTopology {
  v: 1;
  instances: CompactInstance[];
  edges: CompactEdge[];
  companions: CompactCompanion[];
  connections: CompactConnection[];
  truncated?: true;
}

export type Crud = "create" | "read" | "update" | "delete";
/** The decoded picture. Same shape as `SliceTopology` in src/ui/access-types.ts (a test keeps the two assignable). `wf` / `ops` = how many workflow ops the grant lists; absent = all ops. */
export interface DecodedTopology {
  instances: { ins: string; product: string; name: string; version: string }[];
  edges: { agent: string; ins: string; product: string; crud: Crud[]; mode: "free" | "bound"; held: string[]; wf?: number; paused?: true }[];
  companions: { from: string; to: string; product: string; crud: Crud[]; ops?: number }[];
  connections: { con: string; agt: string; method: "key" | "pairing"; status: "active" | "revoked" }[];
  truncated?: true;
}

/**
 * C383 review: agents with a working key or app access in a whole picture. A cut list or no list says nothing, so it gives nobody: Governance cannot see them there.
 * Core removes both when it offboards an agent, so one of these after that means Portal gave it back: Reinstate, then a new pairing or grant.
 */
export function accessShown(top: DecodedTopology | null | undefined): ReadonlySet<string> {
  if (!top || top.truncated) return new Set();
  return new Set([...top.connections.filter((c) => c.status === "active").map((c) => c.agt), ...top.edges.map((e) => e.agent)]);
}

const CRUD_LETTERS: readonly [string, Crud][] = [
  ["c", "create"],
  ["r", "read"],
  ["u", "update"],
  ["d", "delete"],
];
/** The compact crud code → actions (null when the code is not `^c?r?u?d?$`). */
export function crudFromCode(code: unknown): Crud[] | null {
  if (typeof code !== "string" || !CRUD_PATTERN.test(code)) return null;
  return CRUD_LETTERS.filter(([l]) => code.includes(l)).map(([, a]) => a);
}
/** The `held` mask → hold family ids in bit order. Bits above the families this app knows are ignored. null when the mask is not an integer in range. */
export function heldFromMask(mask: unknown): string[] | null {
  if (typeof mask !== "number" || !Number.isInteger(mask) || mask < 0 || mask > HELD_MASK_MAX) return null;
  return HELD_BITS.filter((_, i) => (mask & (1 << i)) !== 0);
}

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max;
const idx = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= OPS_COUNT_MAX;

/** Result of reading the slice: the cleaned compact picture, and whether anything was left out. */
export interface ReadTopology {
  topology: CompactTopology;
  truncated: boolean;
}

/**
 * Validate what `ctx.topology()` returned. Returns null when it is not a topology at all (not an object, `v` is not 1, a list is
 * missing or not an array). Otherwise returns the topology with only the rows that are well formed AND whose indexes are in range
 * (`agentCount` = the length of the slice `agents[]`); every dropped row, a list over its bound, or `truncated: true` from Core
 * sets `truncated`. Never throws.
 */
export function cleanTopology(raw: unknown, agentCount: number): ReadTopology | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (t.v !== 1) return null;
  for (const k of ["instances", "edges", "companions", "connections"] as const) if (!Array.isArray(t[k])) return null;
  let truncated = t.truncated === true;
  const cut = (list: unknown[], max: number): unknown[] => {
    if (list.length > max) truncated = true;
    return list.slice(0, max);
  };
  const instances: CompactInstance[] = [];
  const valid = new Set<number>(); // positions of well formed instance rows (the other lists index them by position)
  cut(t.instances as unknown[], TOPOLOGY_MAX.instances).forEach((row, i) => {
    if (Array.isArray(row) && row.length === 4 && str(row[0], 64) && str(row[1], 64) && str(row[2], 200) && str(row[3], 40)) {
      instances[i] = [row[0], row[1], row[2], row[3]];
      valid.add(i);
    } else truncated = true;
  });
  const inst = (i: unknown): i is number => idx(i) && valid.has(i);
  const agent = (i: unknown): i is number => idx(i) && i < agentCount;

  const edges: CompactEdge[] = [];
  for (const row of cut(t.edges as unknown[], TOPOLOGY_MAX.edges)) {
    if (!Array.isArray(row) || row.length !== 7) {
      truncated = true;
      continue;
    }
    const [a, i, crud, mode, held, wf, paused] = row as unknown[];
    if (!agent(a) || !inst(i) || crudFromCode(crud) === null || (mode !== "f" && mode !== "b") || heldFromMask(held) === null || !count(wf) || (paused !== 0 && paused !== 1)) {
      truncated = true;
      continue;
    }
    edges.push([a, i, crud as string, mode, held as number, wf, paused]);
  }
  const companions: CompactCompanion[] = [];
  for (const row of cut(t.companions as unknown[], TOPOLOGY_MAX.companions)) {
    if (!Array.isArray(row) || row.length !== 4) {
      truncated = true;
      continue;
    }
    const [from, to, crud, ops] = row as unknown[];
    if (!inst(from) || !inst(to) || crudFromCode(crud) === null || !count(ops)) {
      truncated = true;
      continue;
    }
    companions.push([from, to, crud as string, ops]);
  }
  const connections: CompactConnection[] = [];
  for (const row of cut(t.connections as unknown[], TOPOLOGY_MAX.connections)) {
    if (!Array.isArray(row) || row.length !== 4) {
      truncated = true;
      continue;
    }
    const [con, a, method, status] = row as unknown[];
    if (!str(con, 64) || !agent(a) || (method !== "k" && method !== "p") || (status !== "a" && status !== "r")) {
      truncated = true;
      continue;
    }
    connections.push([con, a, method, status]);
  }
  // `instances` keeps holes for dropped rows so that indexes stay true; the holes are closed when decoding
  return { topology: { v: 1, instances, edges, companions, connections, ...(truncated ? { truncated: true as const } : {}) }, truncated };
}

/**
 * Compact → object form. `agents` = the slice `agents[]` ids in slice order (the index base of `agentIdx`). A row that names an
 * agent or instance outside the lists is dropped (cleanTopology already did that; this is the second line of defence).
 */
export function decodeTopology(t: CompactTopology, agents: readonly string[]): DecodedTopology {
  const instances: DecodedTopology["instances"] = [];
  const at = new Map<number, DecodedTopology["instances"][number]>();
  t.instances.forEach((row, i) => {
    if (!row) return;
    const ins = { ins: row[0], product: row[1], name: row[2], version: row[3] };
    at.set(i, ins);
    instances.push(ins);
  });
  const out: DecodedTopology = { instances, edges: [], companions: [], connections: [] };
  let truncated = t.truncated === true;
  for (const [a, i, crud, mode, held, wf, paused] of t.edges) {
    const agent = agents[a];
    const ins = at.get(i);
    const actions = crudFromCode(crud);
    const families = heldFromMask(held);
    if (agent === undefined || !ins || !actions || !families) {
      truncated = true;
      continue;
    }
    out.edges.push({ agent, ins: ins.ins, product: ins.product, crud: actions, mode: mode === "b" ? "bound" : "free", held: families, ...(wf > 0 ? { wf } : {}), ...(paused === 1 ? { paused: true as const } : {}) });
  }
  for (const [f, to, crud, ops] of t.companions) {
    const from = at.get(f);
    const target = at.get(to);
    const actions = crudFromCode(crud);
    if (!from || !target || !actions) {
      truncated = true;
      continue;
    }
    out.companions.push({ from: from.ins, to: target.ins, product: target.product, crud: actions, ...(ops > 0 ? { ops } : {}) });
  }
  for (const [con, a, method, status] of t.connections) {
    const agt = agents[a];
    if (agt === undefined) {
      truncated = true;
      continue;
    }
    out.connections.push({ con, agt, method: method === "p" ? "pairing" : "key", status: status === "r" ? "revoked" : "active" });
  }
  if (truncated) out.truncated = true;
  return out;
}
