// access_get (C373 WP-D, G-2): the grant picture from the verified slice, person op only. The compact form Core sends is
// cleaned and decoded on the server (src/topology-slice.ts). Each guard has a quiet-on-good and a fire-on-bad case with the
// exact outcome (L34, L27). Until sdk#60 is released the pinned SDK has no `ctx.topology`; the op reads it defensively.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLD_FAMILIES, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Db, type Json, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessGetOutput } from "#kit";
import { handlers, manifest } from "../src/app.ts";
import { forgetSliceAgents, rememberSliceAgents } from "../src/slice-agents.ts";
import { type CompactTopology, cleanTopology, crudFromCode, decodeTopology, HELD_BITS, heldFromMask, readSliceTopology, TOPOLOGY_MAX } from "../src/topology-slice.ts";
import type { SliceTopology } from "../src/ui/access-types.ts";
import { AGENT_A, AGENT_B, migratedDb } from "./helpers.ts";

const log = { debug() {}, info() {}, warn() {}, error() {} };
const OWNER = { type: "person", id: "per_01J0000000000000000000000P", name: "owner", mode: null };
const AGENTS = [
  { id: AGENT_A.id, name: AGENT_A.name },
  { id: AGENT_B.id, name: AGENT_B.name },
];
const compact = (over: Partial<CompactTopology> = {}): CompactTopology => ({
  v: 1,
  instances: [
    ["ins_knowledge", "knowledge", "Knowledge", "1.2.0"],
    ["ins_connect", "connect", "Connect", "0.7.5"],
  ],
  edges: [
    [0, 0, "r", "f", 0, 0, 0],
    [0, 1, "cru", "b", 0b10001, 3, 0],
    [1, 0, "r", "f", 0, 0, 1],
  ],
  companions: [[1, 0, "r", 2]],
  connections: [
    ["con_01J0000000000000000000KEY", 0, "k", "a"],
    ["con_01J0000000000000000000PAIR", 1, "p", "r"],
  ],
  ...over,
});
/** A context like the SDK's, with an optional `topology` reader and a Connect that answers identities_list. */
function ctxOf(db: Db, opts: { caller?: object; topology?: unknown; reader?: boolean; identities?: Json[]; connectDown?: boolean } = {}): OpContext {
  const ctx: Record<string, unknown> = {
    db,
    caller: opts.caller ?? OWNER,
    log,
    callApp: async () => {
      if (opts.connectDown) throw new TbError("no_grant", "x", 403);
      return { status: "ok", output: { identities: opts.identities ?? [], nextCursor: null } };
    },
  };
  if (opts.reader !== false) ctx.topology = () => opts.topology ?? null;
  return ctx as unknown as OpContext;
}
const get = (c: OpContext) => handlers.access_get.run({} as never, c) as Promise<AccessGetOutput>;
const op = manifest.operations.find((o) => o.id === "access_get") as unknown as { audience: string; effect: string; idempotency: string; receipt: boolean; crud: string[]; output: Parameters<typeof validateAgainstSchema>[0] };
async function outcome(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    const x = e as { code?: string; httpStatus?: number };
    return x.code ? `${x.code} ${x.httpStatus}` : `other:${String(e)}`;
  }
}

// ── the manifest and who may call ────────────────────────────────────────────────────────────────────────────────

test("access_get is a person read: no idempotency, no receipt, never an agent tool (C88)", () => {
  assert.deepEqual([op.audience, op.effect, op.idempotency, op.receipt, op.crud], ["person", "read", "none", false, ["read"]]);
  assert.ok(!manifest.operations.some((o) => (o as { audience?: string }).audience === "agent" && o.id === "access_get"));
  // no agent op output can carry the grant picture or channel identities
  for (const o of manifest.operations.filter((x) => (x as { audience?: string }).audience === "agent")) assert.doesNotMatch(JSON.stringify(o.output), /"connections"|"companions"|"wf"/, `${o.id} carries no grant picture`);
});

test("an agent, an app and a scheduled caller are refused (no_access 403); the owner is served", async () => {
  const db = migratedDb();
  rememberSliceAgents(AGENTS);
  for (const caller of [{ type: "agent", id: AGENT_A.id, name: "A", mode: "free" }, { type: "app", id: "ins_rules", product: "rules", listed: true }, { type: "system", id: "x" }]) {
    assert.equal(await outcome(() => get(ctxOf(db, { caller, topology: compact() }))), "no_access 403", JSON.stringify(caller));
  }
  assert.equal(await outcome(() => get(ctxOf(db, { topology: compact() }))), "ok");
});

// ── the decoder ──────────────────────────────────────────────────────────────────────────────────────────────────

test("the hold-family bit order is the spec's, append-only (a changed order would show the wrong family)", () => {
  assert.deepEqual([...HELD_BITS], ["first_contact", "profile_change", "live_call", "destructive", "money", "outward", "identity", "public_link"]);
  assert.deepEqual([...HELD_BITS], [...HOLD_FAMILIES]);
  assert.deepEqual(heldFromMask(0b10001), ["first_contact", "money"]);
  assert.deepEqual(heldFromMask(0), []);
  assert.deepEqual(heldFromMask(1 << 20), [], "a bit above the known families is ignored");
  // fire on bad
  for (const bad of [-1, 1.5, 0x8000_0000, "1", null]) assert.equal(heldFromMask(bad), null, String(bad));
});

test("crud codes: letters in c r u d order only", () => {
  assert.deepEqual(crudFromCode("crud"), ["create", "read", "update", "delete"]);
  assert.deepEqual(crudFromCode(""), []);
  assert.deepEqual(crudFromCode("ru"), ["read", "update"]);
  for (const bad of ["rc", "x", "rr", "CRUD", null, 7]) assert.equal(crudFromCode(bad), null, String(bad));
});

test("decode: compact → object form, agents resolved by index in slice order, words for mode, method and status", () => {
  const read = cleanTopology(compact(), 2);
  assert.ok(read && !read.truncated);
  const d = decodeTopology(read.topology, AGENTS.map((a) => a.id));
  assert.deepEqual(d.instances.map((i) => [i.ins, i.product, i.name, i.version]), [
    ["ins_knowledge", "knowledge", "Knowledge", "1.2.0"],
    ["ins_connect", "connect", "Connect", "0.7.5"],
  ]);
  assert.deepEqual(d.edges, [
    { agent: AGENT_A.id, ins: "ins_knowledge", product: "knowledge", crud: ["read"], mode: "free", held: [] },
    { agent: AGENT_A.id, ins: "ins_connect", product: "connect", crud: ["create", "read", "update"], mode: "bound", held: ["first_contact", "money"], wf: 3 },
    { agent: AGENT_B.id, ins: "ins_knowledge", product: "knowledge", crud: ["read"], mode: "free", held: [], paused: true },
  ]);
  assert.deepEqual(d.companions, [{ from: "ins_connect", to: "ins_knowledge", product: "knowledge", crud: ["read"], ops: 2 }]);
  assert.deepEqual(d.connections, [
    { con: "con_01J0000000000000000000KEY", agt: AGENT_A.id, method: "key", status: "active" },
    { con: "con_01J0000000000000000000PAIR", agt: AGENT_B.id, method: "pairing", status: "revoked" },
  ]);
  assert.equal(d.truncated, undefined);
  // the decoded picture is the UI's shape (compile-time check by assignment)
  const ui: SliceTopology = d;
  assert.equal(ui.edges.length, 3);
});

test("an index out of range drops the row and marks the picture truncated; the other rows stay (spec 0.1.80 rule 2)", () => {
  const read = cleanTopology(
    compact({
      edges: [
        [0, 0, "r", "f", 0, 0, 0],
        [5, 0, "r", "f", 0, 0, 0], // agent 5 of 2
        [0, 9, "r", "f", 0, 0, 0], // instance 9 of 2
      ],
      companions: [[0, 7, "r", 0]],
      connections: [["con_x", 2, "k", "a"]],
    }),
    2,
  );
  assert.ok(read);
  assert.equal(read.truncated, true);
  assert.equal(read.topology.edges.length, 1);
  assert.equal(read.topology.companions.length, 0);
  assert.equal(read.topology.connections.length, 0);
  const d = decodeTopology(read.topology, AGENTS.map((a) => a.id));
  assert.equal(d.truncated, true);
  assert.equal(d.edges.length, 1);
});

test("malformed rows are dropped and counted; a list over its bound is cut; a malformed whole is no picture", () => {
  const bad = cleanTopology(
    compact({
      edges: [
        [0, 0, "r", "f", 0, 0, 0],
        [0, 0, "rr", "f", 0, 0, 0], // bad crud
        [0, 0, "r", "x" as never, 0, 0, 0], // bad mode
        [0, 0, "r", "f", -1, 0, 0], // bad mask
        [0, 0, "r", "f", 0, 999, 0], // count over 128
        [0, 0, "r", "f", 0, 0, 2 as never], // bad paused
        [0, 0, "r", "f", 0, 0] as never, // wrong arity
        "nope" as never,
      ],
    }),
    2,
  );
  assert.ok(bad);
  assert.equal(bad.topology.edges.length, 1);
  assert.equal(bad.truncated, true);
  const many = cleanTopology(compact({ connections: Array.from({ length: TOPOLOGY_MAX.connections + 5 }, (_, i): [string, number, "k", "a"] => [`con_${i}`, 0, "k", "a"]) }), 2);
  assert.equal(many?.topology.connections.length, TOPOLOGY_MAX.connections);
  assert.equal(many?.truncated, true);
  for (const junk of [null, undefined, 7, "x", [], { v: 2, instances: [], edges: [], companions: [], connections: [] }, { v: 1, instances: [], edges: {}, companions: [], connections: [] }, { v: 1 }]) assert.equal(cleanTopology(junk, 2), null, JSON.stringify(junk));
  // an instance row that is dropped keeps the positions of the others true: edges into it are dropped, not moved
  const hole = cleanTopology(compact({ instances: [["ins_knowledge", "knowledge", "Knowledge", "1.2.0"], ["bad"] as never] }), 2);
  assert.ok(hole);
  assert.deepEqual(
    hole.topology.edges.map((e) => e[1]),
    [0, 0],
    "the edge into instance 1 is gone",
  );
});

test("readSliceTopology: no reader on the SDK, a reader that answers nothing, a reader that throws, a picture", () => {
  assert.deepEqual(readSliceTopology({}, 2), { state: "no_reader" });
  assert.deepEqual(readSliceTopology({ topology: () => null }, 2), { state: "none" });
  assert.deepEqual(
    readSliceTopology(
      {
        topology: () => {
          throw new Error("boom");
        },
      },
      2,
    ),
    { state: "none" },
  );
  assert.equal(readSliceTopology({ topology: () => compact() }, 2).state, "read");
  assert.equal(readSliceTopology({ topology: () => ({ v: 9 }) }, 2).state, "none");
});

// ── the op ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("available: the picture, the agents and their channel identities (only known agents'), valid against the manifest", async () => {
  const db = migratedDb();
  rememberSliceAgents(AGENTS);
  const out = await get(
    ctxOf(db, {
      topology: compact(),
      identities: [
        { agent: AGENT_A.id, channel: "buzz", identity: "buzz:npub1aaa" },
        { agent: "agt_01J0000000000000000000GHOST", channel: "slack", identity: "slack:UGHOST" },
      ] as Json[],
    }),
  );
  assert.equal(out.status, "available");
  assert.equal(out.note, "");
  assert.deepEqual(out.agents, AGENTS);
  assert.deepEqual(out.identities, [{ agent: AGENT_A.id, channel: "buzz", handle: "buzz:npub1aaa" }], "an identity of an agent the slice does not list is not shown");
  assert.equal(out.topology?.edges.length, 3);
  assert.equal(validateAgainstSchema(op.output, out as unknown as Json).ok, true);
});

test("unavailable: the SDK has no topology reader (older than sdk#60) → plain words, no picture, no agents (fire on bad)", async () => {
  const db = migratedDb();
  rememberSliceAgents(AGENTS);
  const out = await get(ctxOf(db, { reader: false }));
  assert.equal(out.status, "unavailable");
  assert.equal(out.topology, null);
  assert.deepEqual([out.agents, out.identities], [[], []]);
  assert.match(out.note, /Turn on 'See who has access' for Governance in the Portal \(app settings\) to show this\./);
  assert.equal(validateAgainstSchema(op.output, out as unknown as Json).ok, true);
});

test("not_consented: the reader answers nothing (the owner has not allowed it) → the same plain sentence", async () => {
  const db = migratedDb();
  rememberSliceAgents(AGENTS);
  const out = await get(ctxOf(db, { topology: null }));
  assert.equal(out.status, "not_consented");
  assert.equal(out.topology, null);
  assert.match(out.note, /Turn on 'See who has access' for Governance in the Portal \(app settings\) to show this\./);
  assert.equal(validateAgainstSchema(op.output, out as unknown as Json).ok, true);
});

test("the agent list has not arrived yet: unavailable, never a guess of whose grants these are", async () => {
  const db = migratedDb();
  forgetSliceAgents();
  const out = await get(ctxOf(db, { topology: compact() }));
  assert.equal(out.status, "unavailable");
  assert.equal(out.topology, null);
  assert.match(out.note, /list of agents has not loaded/);
  // and quiet on good: an empty picture needs no agents
  const empty = await get(ctxOf(db, { topology: { v: 1, instances: [], edges: [], companions: [], connections: [] } }));
  assert.equal(empty.status, "available");
});

test("a truncated picture and a Connect that cannot answer are said in the note; the picture still shows", async () => {
  const db = migratedDb();
  rememberSliceAgents(AGENTS);
  const out = await get(ctxOf(db, { topology: compact({ edges: [[0, 0, "r", "f", 0, 0, 0], [9, 0, "r", "f", 0, 0, 0]] }), connectDown: true }));
  assert.equal(out.status, "available");
  assert.equal(out.topology?.truncated, true);
  assert.match(out.note, /shortened copy/);
  assert.match(out.note, /Channel identities are not shown\. Deploy Connect/);
  assert.deepEqual(out.identities, []);
  assert.equal(validateAgainstSchema(op.output, out as unknown as Json).ok, true);
});

test("the full-size picture (40 apps, 600 edges, 100 companions, 300 connections) is valid against the manifest", async () => {
  const db = migratedDb();
  const agents = Array.from({ length: 50 }, (_, i) => ({ id: `agt_${String(i).padStart(26, "0")}`, name: `Agent ${i}` }));
  rememberSliceAgents(agents);
  const t: CompactTopology = {
    v: 1,
    instances: Array.from({ length: 40 }, (_, i): [string, string, string, string] => [`ins_${i}`, "knowledge", `App ${i}`, "1.0.0"]),
    edges: Array.from({ length: 600 }, (_, i): [number, number, string, "f", number, number, 0] => [i % 50, i % 40, "crud", "f", 0xff, 128, 0]),
    companions: Array.from({ length: 100 }, (_, i): [number, number, string, number] => [i % 40, (i + 1) % 40, "crud", 128]),
    connections: Array.from({ length: 300 }, (_, i): [string, number, "k", "a"] => [`con_${i}`, i % 50, "k", "a"]),
  };
  const out = await get(ctxOf(db, { topology: t }));
  assert.equal(out.status, "available");
  assert.equal(out.topology?.edges.length, 600);
  assert.equal(validateAgainstSchema(op.output, out as unknown as Json).ok, true);
  forgetSliceAgents();
});
