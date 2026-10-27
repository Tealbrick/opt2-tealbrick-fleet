// The topology picture's layout (src/graph-layout.ts, C373 WP-D): pure, deterministic, capped. Each guard has a
// quiet-on-good and a fire-on-bad case with the exact outcome (L34, L27).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fit, GEOMETRY, type GraphLayout, graphSummary, layoutGraph, metaOf, moreNote, relationLabel, type TopoEdge, type TopoNode, wireClass } from "../src/graph-layout.ts";

const node = (id: string, kind: TopoNode["kind"], name: string, over: Partial<TopoNode> = {}): TopoNode => ({ id, kind, name, trust: kind === "team" || kind === "app" ? null : "trusted", status: "active", reviewDueAt: null, changedSinceReview: false, ...over });
const edge = (kind: TopoEdge["kind"], from: string, to: string, label: string = kind, state: TopoEdge["state"] = "live"): TopoEdge => ({ id: `${kind}:${from}:${to}`, kind, from, to, label, state, since: null });

/** A small workspace: two people, three agents, two teams, an app, an outside agent and a contact-only person. */
const SMALL = (): { nodes: TopoNode[]; edges: TopoEdge[] } => ({
  nodes: [
    node("psn_ann", "person", "Ann Example"),
    node("psn_lena", "person", "Lena Hart"),
    node("psn_jana", "person", "Jana Novak"), // reached only as a contact → outside
    node("psn_bot", "outside_agent", "Brightline intake", { trust: "unreviewed" }),
    node("agt_front", "agent", "Front desk"),
    node("agt_scout", "agent", "Scout", { status: "paused", trust: "limited", changedSinceReview: true }),
    node("agt_night", "agent", "Night shift"),
    node("tm_ops", "team", "Operations"),
    node("tm_support", "team", "Support"),
    node("ins_kn", "app", "Knowledge"),
  ],
  edges: [
    edge("owner", "psn_ann", "agt_front", "owns"),
    edge("owner", "psn_lena", "agt_scout", "owns"),
    edge("member", "psn_ann", "tm_support", "lead"),
    edge("member", "agt_front", "tm_support", "member"),
    edge("member", "agt_front", "tm_ops", "member"), // second team: Operations comes first by name → primary; Support is a wire
    edge("member", "agt_night", "tm_ops", "member", "off"),
    edge("contact", "agt_front", "psn_jana", "Buzz"),
    edge("contact", "agt_scout", "psn_bot", "first contact waits", "held"),
    edge("access", "agt_front", "ins_kn", "CR"),
    edge("contact", "agt_night", "psn_bot", "blocked", "blocked"),
  ],
});

const byId = (l: GraphLayout, id: string) => {
  const n = l.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id}`);
  return n;
};
const inside = (n: { x: number; y: number; w: number; h: number }, r: { x: number; y: number; w: number; h: number }) => n.x >= r.x && n.y >= r.y && n.x + n.w <= r.x + r.w && n.y + n.h <= r.y + r.h;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A shuffle that is the same on every run (no Math.random in tests either). */
const shuffled = <T>(xs: readonly T[]): T[] => {
  const out = [...xs];
  let s = 7;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe("layoutGraph", () => {
  it("is deterministic: the same input gives the same picture, whatever order the input lists things in", () => {
    const a = layoutGraph(SMALL());
    assert.deepEqual(layoutGraph(SMALL()), a);
    const s = SMALL();
    assert.deepEqual(layoutGraph({ nodes: shuffled(s.nodes), edges: shuffled(s.edges) }), a);
    // fire-on-bad: a changed name moves the order (the layout really depends on the input)
    const renamed = SMALL();
    renamed.nodes[4] = node("agt_front", "agent", "Zed desk");
    const rows = (l: GraphLayout) => l.nodes.map((n) => [n.id, n.y]);
    assert.notDeepEqual(rows(layoutGraph(renamed)), rows(a));
  });

  it("columns: people, then agents, then apps, then the dashed outside region", () => {
    const l = layoutGraph(SMALL());
    const x = (id: string) => byId(l, id).x;
    assert.equal(x("psn_ann"), x("psn_lena"));
    assert.ok(x("psn_ann") < x("agt_front"));
    assert.equal(x("agt_front"), x("agt_scout"));
    assert.ok(x("agt_front") < x("ins_kn"));
    assert.ok(x("ins_kn") < x("psn_bot"));
    assert.equal(x("psn_bot"), x("psn_jana"), "a contact-only person sits outside with the outside agents");
    assert.equal(byId(l, "psn_jana").group, "outside");
    assert.equal(byId(l, "psn_ann").group, "people");
    const out = l.regions.find((r) => r.kind === "outside");
    assert.ok(out);
    assert.equal(out.name, "Outside the workspace");
    for (const id of ["psn_bot", "psn_jana"]) assert.ok(inside(byId(l, id), out), `${id} inside the outside region`);
    assert.ok(!inside(byId(l, "agt_front"), out));
  });

  it("teams are regions: a member sits in its first team's region; the region spans people and agents", () => {
    const l = layoutGraph(SMALL());
    assert.deepEqual(
      l.regions.map((r) => [r.kind, r.id, r.name, r.empty]),
      [
        ["team", "tm_ops", "Operations", false],
        ["team", "tm_support", "Support", false],
        ["outside", "outside", "Outside the workspace", false],
      ],
    );
    const ops = l.regions[0];
    const support = l.regions[1];
    assert.ok(ops && support);
    assert.equal(byId(l, "agt_front").team, "tm_ops");
    assert.ok(inside(byId(l, "agt_front"), ops));
    assert.ok(inside(byId(l, "agt_night"), ops));
    assert.ok(inside(byId(l, "psn_ann"), support));
    assert.equal(byId(l, "psn_lena").team, null, "no team: below the regions");
    assert.ok(!inside(byId(l, "psn_lena"), ops) && !inside(byId(l, "psn_lena"), support));
    assert.ok(ops.y + ops.h < support.y, "regions do not overlap");
  });

  it("wires: containment replaces the member wire; a second team is a wire to that region; classes follow kind and state", () => {
    const l = layoutGraph(SMALL());
    assert.equal(l.contained, 3, "Ann in Support, Front desk in Operations, Night shift in Operations");
    assert.deepEqual(
      l.wires.map((w) => [w.id, w.cls, w.label]),
      [
        ["access:agt_front:ins_kn", "live", "CR"],
        ["contact:agt_front:psn_jana", "live", "Buzz"],
        ["contact:agt_night:psn_bot", "blocked", "blocked"],
        ["contact:agt_scout:psn_bot", "held", "first contact waits"],
        ["member:agt_front:tm_support", "own", "member"],
        ["owner:psn_ann:agt_front", "own", "owns"],
        ["owner:psn_lena:agt_scout", "own", "owns"],
      ],
    );
    for (const w of l.wires) assert.match(w.d, /^M-?[\d.]+ -?[\d.]+ C(-?[\d.]+ ){5}-?[\d.]+$/);
    assert.equal(l.hidden.edges, 0);
  });

  it("wireClass and relationLabel: blocked and held win; ink for owner and member, teal for the others", () => {
    assert.equal(wireClass(edge("owner", "a", "b")), "own");
    assert.equal(wireClass(edge("member", "a", "b")), "own");
    assert.equal(wireClass(edge("contact", "a", "b")), "live");
    assert.equal(wireClass(edge("companion", "a", "b")), "live");
    assert.equal(wireClass(edge("owner", "a", "b", "owns", "blocked")), "blocked");
    assert.equal(wireClass(edge("access", "a", "b", "CR", "held")), "held");
    assert.equal(wireClass(edge("access", "a", "b", "CR", "off")), "off");
    assert.equal(relationLabel(edge("member", "a", "b", "lead")), "leads");
    assert.equal(relationLabel(edge("member", "a", "b", "member")), "member");
    assert.equal(relationLabel(edge("owner", "a", "b", "x")), "owns");
  });

  it("no two cards overlap, and every card is inside the picture", () => {
    const l = layoutGraph(SMALL());
    for (const [i, a] of l.nodes.entries()) {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= l.width && a.y + a.h <= l.height, `${a.id} inside`);
      for (const b of l.nodes.slice(i + 1)) assert.ok(!overlap(a, b), `${a.id} and ${b.id} overlap`);
    }
    for (const r of l.regions) assert.ok(r.x + r.w <= l.width && r.y + r.h <= l.height, `${r.id} inside`);
  });

  it("0 nodes: an empty picture (0 × 0), nothing drawn, the summary still says so", () => {
    const l = layoutGraph({ nodes: [], edges: [] });
    assert.deepEqual([l.width, l.height, l.nodes.length, l.regions.length, l.wires.length], [0, 0, 0, 0, 0]);
    assert.equal(graphSummary(l), "Topology graph, read only: 0 people, 0 agents, 0 teams, 0 apps, 0 outside contacts, 0 links.");
    assert.equal(moreNote(l), "");
  });

  it("1 node: one card at the margin, a picture just big enough", () => {
    const l = layoutGraph({ nodes: [node("agt_a", "agent", "Solo")], edges: [] });
    assert.equal(l.nodes.length, 1);
    const n = l.nodes[0];
    assert.ok(n);
    assert.deepEqual([n.x, n.y, n.initial, n.meta], [GEOMETRY.margin + GEOMETRY.pad, GEOMETRY.margin, "S", "Agent · trusted"]);
    assert.equal(l.width, n.x + n.w + GEOMETRY.margin);
    assert.equal(l.height, n.y + n.h + GEOMETRY.margin);
    assert.equal(graphSummary(l), "Topology graph, read only: 0 people, 1 agent, 0 teams, 0 apps, 0 outside contacts, 0 links.");
  });

  it("an empty team is a short region that says so; a team-only workspace still draws its regions", () => {
    const l = layoutGraph({ nodes: [node("tm_a", "team", "Alpha")], edges: [] });
    assert.deepEqual(
      l.regions.map((r) => [r.id, r.empty]),
      [["tm_a", true]],
    );
    assert.ok(l.width > 0 && l.height > 0);
  });

  it("500 agents: the first 60 by name are drawn, the rest are counted (+M more — see the table), edges to them are hidden", () => {
    const agents = Array.from({ length: 500 }, (_, i) => node(`agt_${String(i).padStart(3, "0")}`, "agent", `Agent ${String(i).padStart(3, "0")}`));
    const owner = node("psn_o", "person", "Owner");
    const l = layoutGraph({ nodes: [owner, ...agents], edges: agents.map((a) => edge("owner", "psn_o", a.id, "owns")) });
    const drawn = l.nodes.filter((n) => n.kind === "agent");
    assert.equal(drawn.length, 60);
    assert.deepEqual(
      drawn.map((n) => n.id),
      agents.slice(0, 60).map((a) => a.id),
    );
    assert.deepEqual([l.total.agents, l.hidden.agents, l.hidden.edges, l.wires.length], [500, 440, 440, 60], "the 60 drawn agents keep their owner wire");
    assert.equal(moreNote(l), "+440 more agents — see the table.");
    assert.match(graphSummary(l), /^Topology graph, read only: 1 person, 60 agents, .* \+440 more agents — see the table\.$/);
    // quiet on good: under the cap nothing is hidden and there is no note
    const few = layoutGraph({ nodes: agents.slice(0, 60), edges: [] });
    assert.deepEqual([few.hidden.agents, moreNote(few)], [0, ""]);
    // the caps can be set
    const tight = layoutGraph({ nodes: agents.slice(0, 5), edges: [] }, { agents: 2 });
    assert.equal(moreNote(tight), "+3 more agents — see the table.");
  });

  it("wires above 30: the wires stay, the labels go (a busy picture stays readable)", () => {
    const agents = Array.from({ length: 31 }, (_, i) => node(`agt_${String(i).padStart(2, "0")}`, "agent", `A${String(i).padStart(2, "0")}`));
    const l = layoutGraph({ nodes: [node("psn_o", "person", "O"), ...agents], edges: agents.map((a) => edge("owner", "psn_o", a.id, "owns")) });
    assert.equal(l.wires.length, 31);
    assert.ok(l.wires.every((w) => w.label === null));
    const ok = layoutGraph({ nodes: [node("psn_o", "person", "O"), ...agents.slice(0, 30)], edges: agents.slice(0, 30).map((a) => edge("owner", "psn_o", a.id, "owns")) });
    assert.ok(ok.wires.every((w) => w.label === "owns"));
  });

  it("long names are cut on the card with … and kept whole for the title; emoji are not split", () => {
    const long = "A very long agent name that never ends at all";
    const l = layoutGraph({ nodes: [node("agt_l", "agent", long)], edges: [] });
    const n = l.nodes[0];
    assert.ok(n);
    assert.equal(n.name, long);
    assert.equal(n.label, "A very long agent…");
    assert.ok(Array.from(n.label).length <= GEOMETRY.nameChars);
    assert.equal(fit("Short", 18), "Short");
    assert.equal(fit("  spaced   out  ", 18), "spaced out");
    assert.equal(fit("😀😀😀😀😀", 3), "😀😀…");
    assert.equal(layoutGraph({ nodes: [node("x", "agent", "  ")], edges: [] }).nodes[0]?.initial, "?");
  });

  it("fire-on-bad: an edge to an unknown node and a repeated node id are not drawn twice or invented", () => {
    const l = layoutGraph({
      nodes: [node("agt_a", "agent", "A"), node("agt_a", "agent", "A again"), node("psn_p", "person", "P")],
      edges: [edge("owner", "psn_p", "agt_a", "owns"), edge("owner", "psn_p", "agt_ghost", "owns"), edge("contact", "agt_ghost", "psn_p", "x")],
    });
    assert.deepEqual(
      l.nodes.map((n) => [n.id, n.name]),
      [
        ["psn_p", "P"],
        ["agt_a", "A"],
      ],
    );
    assert.deepEqual(
      l.wires.map((w) => w.id),
      ["owner:psn_p:agt_a"],
    );
    assert.equal(l.total.edges, 1, "dangling edges are not part of the picture");
  });

  it("metaOf: kind, trust, and a status that is not active", () => {
    assert.equal(metaOf(node("a", "agent", "A", { status: "paused", trust: "limited" })), "Agent · limited · paused");
    assert.equal(metaOf(node("t", "team", "T")), "Team");
    assert.equal(metaOf(node("o", "outside_agent", "O", { trust: "blocked" })), "Outside · blocked");
  });
});
