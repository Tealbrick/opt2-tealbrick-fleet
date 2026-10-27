// The grant view as rows (src/ui/access-rows.ts, C373 WP-D): per agent, per app, filters, and the "App access" graph layer.
// Fire-on-bad: a row never shows data for an agent the page does not know or the slice does not name, and an agent's
// card never carries another agent's handles (L34, L27).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accessLayer, accessView, crudLetters, crudWords, filterAccess, withAccess } from "../src/ui/access-rows.ts";
import type { AccessAgent, ChannelIdentity, SliceTopology } from "../src/ui/access-types.ts";
import { layoutGraph, type TopoEdge, type TopoNode } from "../src/ui/graph-layout.ts";

const FRONT = "agt_01J0000000000000000000000A";
const SCOUT = "agt_01J0000000000000000000000B";
const GHOST = "agt_01J0000000000000000000000G"; // in the slice, not in the directory
const AGENTS: AccessAgent[] = [
  { id: SCOUT, name: "Scout" },
  { id: FRONT, name: "Front desk" },
];
const IDS: ChannelIdentity[] = [
  { agent: FRONT, channel: "buzz", handle: "npub1front" },
  { agent: SCOUT, channel: "slack", handle: "U0SCOUT" },
  { agent: FRONT, channel: "slack", handle: "U0FRONT" },
  { agent: GHOST, channel: "buzz", handle: "npub1ghost" },
];
const SLICE = (): SliceTopology => ({
  instances: [
    { ins: "ins_kn", product: "knowledge", name: "Knowledge", version: "0.4.1" },
    { ins: "ins_cn", product: "connect", name: "Connect", version: "0.9.0" },
    { ins: "ins_rl", product: "rules", name: "Rules", version: "0.3.0" },
  ],
  edges: [
    { agent: FRONT, ins: "ins_kn", product: "knowledge", crud: ["read", "create"], mode: "free", held: [] },
    { agent: FRONT, ins: "ins_cn", product: "connect", crud: ["delete", "read", "update", "create"], mode: "free", held: ["money", "first_contact"], wf: ["wf.a", "wf.b"] },
    { agent: SCOUT, ins: "ins_kn", product: "knowledge", crud: ["read"], mode: "bound", held: [], paused: true },
    { agent: GHOST, ins: "ins_kn", product: "knowledge", crud: ["read", "delete"], mode: "free", held: [] },
    { agent: FRONT, ins: "ins_gone", product: "gone", crud: ["read"], mode: "free", held: [] },
    { agent: FRONT, ins: "ins_kn", product: "knowledge", crud: ["delete"], mode: "free", held: [] }, // repeat: first wins
  ],
  companions: [
    { from: "ins_rl", to: "ins_cn", product: "connect", crud: ["read"], ops: ["contacts_list"] },
    { from: "ins_kn", to: "ins_cn", product: "connect", crud: ["read", "create"] },
    { from: "ins_gone", to: "ins_cn", product: "connect", crud: ["read"] },
  ],
  connections: [
    { con: "con_2", agt: FRONT, method: "pairing", status: "revoked" },
    { con: "con_1", agt: FRONT, method: "key", status: "active" },
    { con: "con_9", agt: GHOST, method: "key", status: "active" },
  ],
});

describe("crud letters and words", () => {
  it("always C R U D order; unknown words ignored; nothing = None / No access", () => {
    assert.equal(crudLetters(["update", "read", "create"]), "CRU");
    assert.equal(crudLetters(["delete", "read", "update", "create"]), "CRUD");
    assert.equal(crudLetters(["read", "read", "launch"]), "R");
    assert.equal(crudLetters([]), "None");
    assert.equal(crudWords(["read", "create"]), "Create, read");
    assert.equal(crudWords(["bogus"]), "No access");
  });
});

describe("accessView", () => {
  it("by agent: connections, own identities, the apps each agent can use (sorted by name)", () => {
    const v = accessView(SLICE(), AGENTS, IDS);
    assert.deepEqual(
      v.agents.map((a) => a.name),
      ["Front desk", "Scout"],
    );
    const [front, scout] = v.agents;
    assert.ok(front && scout);
    assert.deepEqual(front.connections, [
      { con: "con_1", method: "key", status: "active" },
      { con: "con_2", method: "pairing", status: "revoked" },
    ]);
    assert.deepEqual(front.identities, [
      { channel: "buzz", handle: "npub1front" },
      { channel: "slack", handle: "U0FRONT" },
    ]);
    assert.deepEqual(
      front.apps.map((r) => [r.app, r.letters, r.words, r.mode, r.held, r.workflowOps, r.paused, r.version]),
      [
        ["Connect", "CRUD", "Create, read, update, delete", "free", ["first_contact", "money"], 2, false, "0.9.0"],
        ["Knowledge", "CR", "Create, read", "free", [], 0, false, "0.4.1"],
      ],
    );
    assert.deepEqual(
      scout.apps.map((r) => [r.app, r.letters, r.paused]),
      [["Knowledge", "R", true]],
    );
    assert.deepEqual(scout.connections, []);
    assert.deepEqual(scout.identities, [{ channel: "slack", handle: "U0SCOUT" }]);
  });

  it("by app: the agents that can use it and the apps that can call it", () => {
    const v = accessView(SLICE(), AGENTS, IDS);
    assert.deepEqual(
      v.apps.map((a) => [a.name, a.agents.map((r) => [r.name, r.letters, r.paused]), a.callers.map((c) => [c.name, c.letters, c.ops])]),
      [
        [
          "Connect",
          [["Front desk", "CRUD", false]],
          [
            ["Knowledge", "CR", 0],
            ["Rules", "R", 1],
          ],
        ],
        [
          "Knowledge",
          [
            ["Front desk", "CR", false],
            ["Scout", "R", true],
          ],
          [],
        ],
        ["Rules", [], []],
      ],
    );
  });

  it("fire-on-bad: an agent not in the directory, an unknown app, a repeat: left out and counted, never shown", () => {
    const v = accessView(SLICE(), AGENTS, IDS);
    // GHOST edge + ins_gone edge + repeated edge + GHOST connection + GHOST identity + ins_gone companion
    assert.equal(v.leftOut, 6);
    const text = JSON.stringify(v);
    assert.doesNotMatch(text, new RegExp(GHOST));
    assert.doesNotMatch(text, /npub1ghost|con_9|ins_gone/);
    // a repeated edge does not overwrite the first grant
    assert.equal(v.agents[0]?.apps.find((r) => r.ins === "ins_kn")?.letters, "CR");
  });

  it("fire-on-bad: an agent's card never carries another agent's handles", () => {
    const v = accessView(SLICE(), AGENTS, IDS);
    for (const a of v.agents) {
      const own = new Set(IDS.filter((i) => i.agent === a.id).map((i) => i.handle));
      for (const i of a.identities) assert.ok(own.has(i.handle), `${a.name} shows ${i.handle}`);
    }
    assert.ok(!v.agents.find((a) => a.id === SCOUT)?.identities.some((i) => /front/i.test(i.handle)));
  });

  it("an agent in the directory with no grants: an empty row set, not data from someone else", () => {
    const v = accessView({ instances: [], edges: [], companions: [], connections: [] }, AGENTS, []);
    assert.deepEqual(
      v.agents.map((a) => [a.name, a.apps.length, a.connections.length, a.identities.length]),
      [
        ["Front desk", 0, 0, 0],
        ["Scout", 0, 0, 0],
      ],
    );
    assert.deepEqual([v.apps, v.leftOut], [[], 0]);
  });

  it("filterAccess: by agent, by app, both; entries with nothing left drop out", () => {
    const v = accessView(SLICE(), AGENTS, IDS);
    assert.deepEqual(
      filterAccess(v, { agent: SCOUT }).agents.map((a) => a.name),
      ["Scout"],
    );
    assert.deepEqual(
      filterAccess(v, { agent: SCOUT }).apps.map((a) => [a.name, a.agents.map((r) => r.name)]),
      [["Knowledge", ["Scout"]]],
    );
    const conn = filterAccess(v, { app: "ins_cn" });
    assert.deepEqual(
      conn.agents.map((a) => [a.name, a.apps.map((r) => r.app)]),
      [["Front desk", ["Connect"]]],
    );
    assert.deepEqual(
      conn.apps.map((a) => a.name),
      ["Connect"],
    );
    assert.deepEqual(filterAccess(v, { agent: SCOUT, app: "ins_cn" }).agents, []);
    assert.deepEqual(filterAccess(v, {}), v);
  });
});

describe("withAccess (the App access layer of the graph)", () => {
  const node = (id: string, kind: TopoNode["kind"], name: string): TopoNode => ({ id, kind, name, trust: kind === "team" ? null : "trusted", status: "active", reviewDueAt: null, changedSinceReview: false });
  const TOPO = (): { nodes: TopoNode[]; edges: TopoEdge[] } => ({ nodes: [node("psn_ann", "person", "Ann"), node(FRONT, "agent", "Front desk"), node(SCOUT, "agent", "Scout")], edges: [{ id: `owner:psn_ann:${FRONT}`, kind: "owner", from: "psn_ann", to: FRONT, label: "owns", state: "live", since: null }] });

  it("adds an app node per instance, agent → app access edges (paused = off) and app → app companion edges", () => {
    const g = withAccess(TOPO(), SLICE());
    assert.deepEqual(
      g.nodes.filter((n) => n.kind === "app").map((n) => [n.id, n.name]),
      [
        ["ins_cn", "Connect"],
        ["ins_kn", "Knowledge"],
        ["ins_rl", "Rules"],
      ],
    );
    assert.deepEqual(
      g.edges.map((e) => [e.kind, e.from, e.to, e.label, e.state]),
      [
        ["owner", "psn_ann", FRONT, "owns", "live"],
        ["access", FRONT, "ins_kn", "CR", "live"],
        ["access", FRONT, "ins_cn", "CRUD", "live"],
        ["access", SCOUT, "ins_kn", "R", "off"],
        ["companion", "ins_rl", "ins_cn", "R", "live"],
        ["companion", "ins_kn", "ins_cn", "CR", "live"],
      ],
    );
    // the input is not changed
    assert.equal(TOPO().nodes.length, 3);
  });

  it("fire-on-bad: no access edge for an agent that is not a node, an unknown app, or an id clash", () => {
    const topo = TOPO();
    topo.nodes.push(node("ins_rl", "team", "A team that happens to share the id"));
    const g = withAccess(topo, SLICE());
    assert.ok(!g.edges.some((e) => e.from === GHOST || e.to === "ins_gone"));
    assert.equal(g.nodes.find((n) => n.id === "ins_rl")?.kind, "team", "an existing node is never overwritten");
    assert.ok(!g.edges.some((e) => e.kind === "companion" && e.from === "ins_rl"), "no companion edge from a clashed id");
  });

  it("the layer draws: apps in their own column, access wires teal or off", () => {
    const l = layoutGraph(withAccess(TOPO(), SLICE()));
    const x = (id: string) => l.nodes.find((n) => n.id === id)?.x ?? -1;
    assert.ok(x(FRONT) < x("ins_kn"));
    assert.equal(x("ins_kn"), x("ins_cn"));
    assert.deepEqual(
      l.wires.filter((w) => w.kind === "access").map((w) => [w.from, w.to, w.cls]),
      [
        [FRONT, "ins_cn", "live"],
        [FRONT, "ins_kn", "live"],
        [SCOUT, "ins_kn", "off"],
      ],
    );
  });
});

describe("accessLayer (the App access layer on its own)", () => {
  const node = (id: string, kind: TopoNode["kind"], name: string): TopoNode => ({ id, kind, name, trust: kind === "team" ? null : "trusted", status: "active", reviewDueAt: null, changedSinceReview: false });
  const edge = (kind: TopoEdge["kind"], from: string, to: string): TopoEdge => ({ id: `${kind}:${from}:${to}`, kind, from, to, label: kind, state: "live", since: null });

  it("keeps people, agents, teams with owner and member edges; drops contacts and outside contacts; adds apps and access", () => {
    const g = accessLayer(
      {
        nodes: [node("psn_ann", "person", "Ann"), node("psn_jana", "person", "Jana"), node("psn_bot", "outside_agent", "Bot"), node(FRONT, "agent", "Front desk"), node("tm_s", "team", "Support")],
        edges: [edge("owner", "psn_ann", FRONT), edge("member", FRONT, "tm_s"), edge("contact", FRONT, "psn_jana"), edge("contact", FRONT, "psn_bot")],
      },
      SLICE(),
    );
    assert.deepEqual(
      g.nodes.map((n) => n.id),
      ["psn_ann", FRONT, "tm_s", "ins_cn", "ins_kn", "ins_rl"],
    );
    assert.deepEqual(
      g.edges.map((e) => e.kind),
      ["owner", "member", "access", "access", "companion", "companion"],
    );
  });
});
