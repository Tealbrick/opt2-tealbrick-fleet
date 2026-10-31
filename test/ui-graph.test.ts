// The topology picture (src/ui/graph.tsx) and the Access grant view (src/ui/access.tsx), rendered in happy-dom (C373
// WP-D): the SVG cards and regions, keyboard focus and Enter/Space select, the aria summary, caps with "+M more — see the
// table", empty and "not available" states in plain text (L18), filters and the by-app toggle, names as text, and no
// other agent's handles on an agent's card. The modules are compiled with the build tsconfig into dist/ui-test-graph.
//
// Preview harness: GOV_PREVIEW_DIR=<dir> node --test test/ui-graph.test.ts also writes the rendered markup as static
// pages (light and dark, kit CSS + the app's CSS linked by file URL) for a screenshot. Off by default.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import type { SliceTopology } from "../src/ui/access-types.ts";
import type { TopoEdge, TopoNode } from "../src/ui/graph-layout.ts";

type GraphUi = typeof import("../src/ui/graph.tsx");
type AccessUi = typeof import("../src/ui/access.tsx");
type AccessHelpers = typeof import("../src/ui/access-rows.ts");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-graph");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/fleet/topology", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLSelectElement", "HTMLInputElement", "SVGElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");

async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(el));
  return {
    host,
    rerender: async (next: ReactElement) => act(async () => r.render(next)),
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const key = async (el: Element, k: string) => {
  await act(async () => {
    el.dispatchEvent(new (win.KeyboardEvent as unknown as typeof KeyboardEvent)("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new (win.MouseEvent as unknown as typeof MouseEvent)("click", { bubbles: true, cancelable: true }));
  });
};
const change = async (sel: HTMLSelectElement, value: string) => {
  await act(async () => {
    sel.value = value;
    sel.dispatchEvent(new (win.Event as unknown as typeof Event)("change", { bubbles: true }));
  });
};
const cards = (host: ParentNode) => [...host.querySelectorAll("g.g-node")];
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** The text nodes joined with a space (what a reader sees as separate words, where textContent runs them together). */
const words = (el: Node | null | undefined): string => {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const t = (n.textContent ?? "").trim();
      if (t) out.push(t);
    }
    for (const c of [...n.childNodes]) walk(c);
  };
  if (el) walk(el);
  return out.join(" ");
};

// ── fixtures ────────────────────────────────────────────────────────────────
const node = (id: string, kind: TopoNode["kind"], name: string, over: Partial<TopoNode> = {}): TopoNode => ({ id, kind, name, trust: kind === "team" || kind === "app" ? null : "trusted", status: "active", reviewDueAt: null, changedSinceReview: false, ...over });
const edge = (kind: TopoEdge["kind"], from: string, to: string, label: string = kind, state: TopoEdge["state"] = "live"): TopoEdge => ({ id: `${kind}:${from}:${to}`, kind, from, to, label, state, since: null });
const FRONT = "agt_01J0000000000000000000000A";
const SCOUT = "agt_01J0000000000000000000000B";
const TOPO = (): { nodes: TopoNode[]; edges: TopoEdge[] } => ({
  nodes: [
    node("psn_ann", "person", "Ann Novak"),
    node("psn_lena", "person", "Lena Hart"),
    node("psn_jana", "person", "Jana Novak"),
    node("psn_bright", "outside_agent", "Brightline intake", { trust: "unreviewed" }),
    node("psn_promo", "outside_agent", "PromoBot", { trust: "blocked" }),
    node(FRONT, "agent", "Front desk", { changedSinceReview: true }),
    node(SCOUT, "agent", "Scout"),
    node("agt_night", "agent", "Night shift with a very long name indeed", { status: "paused", trust: "limited" }),
    node("tm_support", "team", "Support"),
    node("tm_ops", "team", "Operations"),
  ],
  edges: [
    edge("owner", "psn_ann", FRONT, "owns"),
    edge("owner", "psn_lena", SCOUT, "owns"),
    edge("member", "psn_ann", "tm_support", "lead"),
    edge("member", "psn_lena", "tm_support", "member"),
    edge("member", FRONT, "tm_support", "member"),
    edge("member", SCOUT, "tm_support", "member"),
    edge("member", "agt_night", "tm_ops", "member", "off"),
    edge("contact", FRONT, "psn_jana", "Buzz"),
    edge("contact", SCOUT, "psn_bright", "first contact waits", "held"),
    edge("contact", "agt_night", "psn_promo", "blocked", "blocked"),
  ],
});
const SLICE = (): SliceTopology => ({
  instances: [
    { ins: "ins_kn", product: "knowledge", name: "Knowledge", version: "0.4.1" },
    { ins: "ins_cn", product: "connect", name: "Connect", version: "0.9.0" },
  ],
  edges: [
    { agent: FRONT, ins: "ins_kn", product: "knowledge", crud: ["read", "create"], mode: "free", held: [] },
    { agent: FRONT, ins: "ins_cn", product: "connect", crud: ["read", "create", "update"], mode: "free", held: ["first_contact", "money"], wf: 1 },
    { agent: SCOUT, ins: "ins_kn", product: "knowledge", crud: ["read"], mode: "bound", held: [], paused: true },
    { agent: "agt_ghost", ins: "ins_kn", product: "knowledge", crud: ["read"], mode: "free", held: [] },
  ],
  companions: [{ from: "ins_kn", to: "ins_cn", product: "connect", crud: ["read"], ops: 2 }],
  connections: [
    { con: "con_01J0000000000000000000KEY", agt: FRONT, method: "key", status: "active" },
    { con: "con_01J0000000000000000000PAIR", agt: SCOUT, method: "pairing", status: "revoked" },
  ],
});
const AGENTS = [
  { id: FRONT, name: "Front desk" },
  { id: SCOUT, name: "Scout" },
];
const IDENTITIES = [
  { agent: FRONT, channel: "buzz", handle: "npub1frontdesk" },
  { agent: SCOUT, channel: "slack", handle: "U0SCOUT" },
  { agent: "agt_ghost", channel: "buzz", handle: "npub1ghost" },
];

let graph: GraphUi;
let access: AccessUi;
let helpers: AccessHelpers;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  graph = (await import(pathToFileURL(join(outDir, "ui", "graph.js")).href)) as GraphUi;
  access = (await import(pathToFileURL(join(outDir, "ui", "access.js")).href)) as AccessUi;
  helpers = (await import(pathToFileURL(join(outDir, "ui", "access-rows.js")).href)) as AccessHelpers;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

// ── preview harness (off unless GOV_PREVIEW_DIR is set) ──────────────────────
const previewDir = process.env.GOV_PREVIEW_DIR;
function preview(name: string, host: Element): void {
  if (!previewDir) return;
  mkdirSync(previewDir, { recursive: true });
  const css = ["node_modules/@opt2-tealbrick/ui/dist/tokens.css", "node_modules/@opt2-tealbrick/ui/dist/components.css", "src/ui/pages.css", "src/ui/app.css", "src/ui/graph.css"].map((f) => `<link rel="stylesheet" href="${pathToFileURL(join(root, f)).href}">`).join("\n");
  for (const theme of ["light", "dark"]) {
    writeFileSync(
      join(previewDir, `${name}-${theme}.html`),
      `<!doctype html><html lang="en-GB" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title>\n${css}\n<style>body{margin:0;padding:24px;background:var(--tb-paper);color:var(--tb-ink);font-family:var(--tb-font)}</style></head><body><main class="app-page">${host.innerHTML}</main></body></html>`,
    );
  }
}

describe("TopologyGraph", () => {
  it("draws every card and team region as text in SVG, with an aria summary of what is drawn", async () => {
    const m = await mount(h(graph.TopologyGraph, { input: TOPO() }));
    const svg = m.host.querySelector("svg.topo-svg");
    assert.ok(svg);
    assert.equal(svg.getAttribute("role"), "group");
    assert.equal(svg.getAttribute("aria-label"), "Who owns what, graph, read only: 2 people, 3 agents, 2 teams, 0 apps, 3 outside contacts, 10 links.");
    assert.equal(cards(m.host).length, 8);
    assert.deepEqual(
      [...m.host.querySelectorAll("g.g-region")].map((r) => [r.getAttribute("class"), r.getAttribute("data-id")]),
      [
        ["g-region is-team", "tm_ops"],
        ["g-region is-team", "tm_support"],
        ["g-region is-outside", "outside"],
      ],
    );
    // avatars: agents filled, people outlined, outside contacts (agents and contact-only people) plate
    const cls = (id: string) => m.host.querySelector(`g.g-node[data-id="${id}"]`)?.getAttribute("class");
    assert.equal(cls(FRONT), "g-node is-agent");
    assert.equal(cls("psn_ann"), "g-node is-person");
    assert.equal(cls("psn_jana"), "g-node is-outside_agent");
    assert.equal(cls("psn_promo"), "g-node is-outside_agent");
    // wires: teal live, brick dashed waits, dotted blocked and off; no ports, nothing draggable, no inputs
    assert.deepEqual(
      [...m.host.querySelectorAll("path.g-w")].filter((p) => p.closest(".g-wires")).map((p) => p.getAttribute("class")),
      ["g-w w-live", "g-w w-held", "g-w w-blocked", "g-w w-own", "g-w w-own"],
    );
    assert.equal(m.host.querySelector("[draggable], input, .port, .tb-port"), null);
    // a changed-since-review dot; the legend lists only what is drawn
    assert.equal(m.host.querySelectorAll("circle.g-due").length, 1);
    assert.deepEqual(
      [...m.host.querySelectorAll(".topo-legend li")].map((li) => li.textContent),
      ["Agent", "Person", "Outside contact", "Owns or member", "Live", "Waits for you", "Blocked"], "Night shift's off membership is shown by containment, so no off wire",
    );
    preview("graph", m.host);
    await m.unmount();
  });

  it("keyboard: every card and team is in the Tab order; Enter and Space select; a click selects; aria-pressed follows", async () => {
    const picked: string[] = [];
    const onSelect = (id: string) => picked.push(id);
    const m = await mount(h(graph.TopologyGraph, { input: TOPO(), onSelect }));
    const focusables = [...m.host.querySelectorAll('[role="button"]')];
    assert.equal(focusables.length, 10, "8 cards + 2 team regions");
    assert.ok(focusables.every((f) => f.getAttribute("tabindex") === "0"));
    const front = m.host.querySelector(`g.g-node[data-id="${FRONT}"]`);
    assert.ok(front);
    (front as unknown as HTMLElement).focus();
    assert.equal(document.activeElement, front, "a card takes focus");
    await key(front, "Enter");
    await key(front, " ");
    await key(front, "a"); // quiet: another key does nothing
    const team = m.host.querySelector('g.g-region[data-id="tm_support"]');
    assert.ok(team);
    await click(team);
    assert.deepEqual(picked, [FRONT, FRONT, "tm_support"]);
    assert.equal(front.getAttribute("aria-label"), "Agent Front desk, trusted, in team Support, changed since the last review");
    assert.equal(front.getAttribute("aria-pressed"), "false");
    await m.rerender(h(graph.TopologyGraph, { input: TOPO(), onSelect, selected: FRONT }));
    assert.equal(m.host.querySelector(`g.g-node[data-id="${FRONT}"]`)?.getAttribute("aria-pressed"), "true");
    assert.equal(m.host.querySelectorAll('[aria-pressed="true"]').length, 1);
    await m.unmount();
  });

  it("long names: cut on the card, whole in the title and the aria-label", async () => {
    const m = await mount(h(graph.TopologyGraph, { input: TOPO() }));
    const night = m.host.querySelector('g.g-node[data-id="agt_night"]');
    assert.equal(text(night?.querySelector("text.g-name")), "Night shift with…");
    assert.equal(night?.querySelector("title")?.textContent, "Night shift with a very long name indeed");
    assert.match(night?.getAttribute("aria-label") ?? "", /^Agent Night shift with a very long name indeed, limited, paused, in team Operations$/);
    await m.unmount();
  });

  it("names are text, never markup", async () => {
    const m = await mount(h(graph.TopologyGraph, { input: { nodes: [node("agt_x", "agent", "<b>Bold</b><script>x()</script>")], edges: [] } }));
    assert.equal(m.host.querySelector("svg b, svg script"), null);
    assert.equal(m.host.querySelector("title")?.textContent, "<b>Bold</b><script>x()</script>");
    await m.unmount();
  });

  it("0 nodes: a plain empty state, never a blank box (L18)", async () => {
    const m = await mount(h(graph.TopologyGraph, { input: { nodes: [], edges: [] } }));
    assert.equal(m.host.querySelector("svg"), null);
    assert.equal(text(m.host.querySelector(".tb-empty h3")), "Nothing to draw yet.");
    assert.match(text(m.host), /Add people, agents or teams and they show here\./);
    await m.unmount();
  });

  it("1 node: one focusable card", async () => {
    const m = await mount(h(graph.TopologyGraph, { input: { nodes: [node("agt_a", "agent", "Solo")], edges: [] } }));
    assert.equal(cards(m.host).length, 1);
    assert.equal(m.host.querySelector(".topo-more"), null);
    await m.unmount();
  });

  it("500 agents: 60 drawn, the note says +440 more — see the table; the aria summary says it too", async () => {
    const agents = Array.from({ length: 500 }, (_, i) => node(`agt_${String(i).padStart(3, "0")}`, "agent", `Agent ${String(i).padStart(3, "0")}`));
    const m = await mount(h(graph.TopologyGraph, { input: { nodes: [node("psn_o", "person", "Owner"), ...agents], edges: agents.map((a) => edge("owner", "psn_o", a.id, "owns")) } }));
    assert.equal(m.host.querySelectorAll("g.g-node.is-agent").length, 60);
    assert.equal(text(m.host.querySelector(".topo-more")), "+440 more agents — see the table.");
    assert.match(m.host.querySelector("svg.topo-svg")?.getAttribute("aria-label") ?? "", /\+440 more agents — see the table\.$/);
    assert.equal(m.host.querySelectorAll(".g-label").length, 0, "60 wires: no wire labels");
    await m.unmount();
  });

  it("the App access layer: app cards and access wires (accessLayer), no contacts", async () => {
    const m = await mount(h(graph.TopologyGraph, { input: helpers.accessLayer(TOPO(), SLICE()) }));
    assert.equal(m.host.querySelectorAll("g.g-node.is-app").length, 2);
    assert.equal(m.host.querySelector(".g-region.is-outside"), null, "contacts belong to the other layer");
    assert.equal(m.host.querySelector(".g-w.w-held, .g-w.w-blocked"), null);
    assert.ok([...m.host.querySelectorAll("path.g-w")].some((p) => p.getAttribute("data-id") === `access:${SCOUT}:ins_kn` && p.getAttribute("class") === "g-w w-off"), "a paused grant is an off wire");
    assert.ok(!m.host.innerHTML.includes("agt_ghost"), "no wire for an agent that is not in the topology");
    preview("graph-access", m.host);
    await m.unmount();
  });
});

describe("AccessView", () => {
  it("not available: a plain notice with what to do, no table (L18)", async () => {
    const m = await mount(h(access.AccessView, { slice: null, agents: AGENTS, identities: IDENTITIES }));
    assert.equal(text(m.host.querySelector('[role="status"]')), "App access is not shown. The copy of access from Portal is not available to apps yet. Change access in Portal.");
    assert.equal(m.host.querySelector("table"), null);
    assert.doesNotMatch(text(m.host), /npub1/);
    await m.unmount();
  });

  it("nothing yet: an empty state, not a blank page", async () => {
    const m = await mount(h(access.AccessView, { slice: { instances: [], edges: [], companions: [], connections: [] }, agents: [], identities: [] }));
    assert.equal(text(m.host.querySelector(".tb-empty h3")), "No agents or apps yet.");
    assert.match(text(m.host), /Read only\. Change access in Portal\./);
    await m.unmount();
  });

  it("by agent: connections, own channels, and the apps it can use with letters, mode, held, workflow ops, state", async () => {
    const m = await mount(h(access.AccessView, { slice: SLICE(), agents: AGENTS, identities: IDENTITIES, portalHref: "https://portal.example/canvas" }));
    const front = m.host.querySelector('[aria-label="Agent Front desk"]');
    assert.ok(front);
    assert.match(words(front), /Connections Key Active/);
    assert.match(words(front), /Channels buzz · npub1frontdesk/);
    assert.deepEqual(
      [...front.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => text(td))),
      [
        ["Connect", "CRU", "free", "first contact, money", "1", "Active"],
        ["Knowledge", "CR", "free", "None", "All", "Active"],
      ],
    );
    assert.equal(front.querySelector("abbr")?.getAttribute("title"), "Create, read, update");
    const scout = m.host.querySelector('[aria-label="Agent Scout"]');
    assert.match(words(scout), /Connections Pairing Revoked/);
    assert.deepEqual(
      [...(scout?.querySelectorAll("tbody tr td") ?? [])].map((td) => text(td)),
      ["Knowledge", "R", "bound", "None", "All", "Paused"],
    );
    // fire-on-bad: one agent's card never shows another agent's handle; an unknown agent is not shown at all
    assert.doesNotMatch(words(scout), /npub1frontdesk/);
    assert.doesNotMatch(words(front), /U0SCOUT/);
    assert.doesNotMatch(text(m.host), /agt_ghost|npub1ghost/);
    assert.equal(text(m.host.querySelector('.tb-notice[role="status"]')), "2 entries are left out: they name an agent or app this page does not know.");
    assert.equal(m.host.querySelector('a[href="https://portal.example/canvas"]')?.textContent, "Change access in Portal");
    preview("access-by-agent", m.host);
    await m.unmount();
  });

  it("by app: agents that can use it and apps that can call it; filters by agent and by app", async () => {
    const m = await mount(h(access.AccessView, { slice: SLICE(), agents: AGENTS, identities: IDENTITIES }));
    const byApp = [...m.host.querySelectorAll(".tb-segmented button")].find((b) => b.textContent === "By app");
    assert.ok(byApp);
    await click(byApp);
    assert.equal(byApp.getAttribute("aria-pressed"), "true");
    const conn = m.host.querySelector('[aria-label="App Connect"]');
    assert.ok(conn);
    assert.match(words(conn), /Agents that can use it.*Front desk CRU free first contact, money 1 Active/);
    assert.match(words(conn), /Apps that can call it.*Knowledge R 2/);
    const kn = m.host.querySelector('[aria-label="App Knowledge"]');
    assert.match(words(kn), /No other app can call it\./);
    preview("access-by-app", m.host);

    const [agentSel, appSel] = [...m.host.querySelectorAll("select")] as HTMLSelectElement[];
    assert.ok(agentSel && appSel);
    assert.deepEqual(
      [...agentSel.options].map((o) => o.textContent),
      ["All agents", "Front desk", "Scout"],
    );
    await change(agentSel, SCOUT);
    assert.deepEqual(
      [...m.host.querySelectorAll(".access-card")].map((c) => c.getAttribute("aria-label")),
      ["App Knowledge"],
    );
    await change(appSel, "ins_cn");
    assert.equal(m.host.querySelectorAll(".access-card").length, 0);
    assert.match(text(m.host), /Nothing matches this filter\./);
    // back to by agent, all agents: Connect only for Front desk
    await change(agentSel, "");
    await click([...m.host.querySelectorAll(".tb-segmented button")].find((b) => b.textContent === "By agent") as Element);
    assert.deepEqual(
      [...m.host.querySelectorAll(".access-card")].map((c) => c.getAttribute("aria-label")),
      ["Agent Front desk"],
    );
    await m.unmount();
  });

  it("held actions are words, never ids; an unknown family still shows; a shortened copy and a note are said", async () => {
    const slice: SliceTopology = {
      ...SLICE(),
      edges: [{ agent: FRONT, ins: "ins_cn", product: "connect", crud: ["read"], mode: "free", held: ["first_contact", "profile_change", "live_call", "destructive", "money", "outward", "identity", "public_link", "brand_new_family"] }],
      companions: [],
      connections: [],
      truncated: true,
    };
    const m = await mount(h(access.AccessView, { slice, agents: AGENTS, identities: [] }));
    assert.match(words(m.host.querySelector('[aria-label="Agent Front desk"]')), /brand new family, destructive, first contact, identity, live call, money, outward, profile change, public link/);
    assert.doesNotMatch(text(m.host), /first_contact|profile_change|live_call|public_link|brand_new_family/);
    assert.ok([...m.host.querySelectorAll('[role="status"]')].some((n) => text(n) === "The workspace sent a shortened copy of access: some access is not shown."));
    await m.unmount();
    // the note of access_get replaces the default sentence when there is no picture
    const none = await mount(h(access.AccessView, { slice: null, agents: [], identities: [], note: "Turn on 'See who has access' for Governance in the Portal (app settings) to show this." }));
    assert.equal(text(none.host.querySelector('[role="status"]')), "App access is not shown. Turn on 'See who has access' for Governance in the Portal (app settings) to show this.");
    await none.unmount();
  });

  it("names and handles are text, never markup", async () => {
    const m = await mount(h(access.AccessView, { slice: SLICE(), agents: [{ id: FRONT, name: "<img src=x onerror=1>" }], identities: [{ agent: FRONT, channel: "buzz", handle: "<b>h</b>" }] }));
    assert.equal(m.host.querySelector(".access-card img, .access-card b"), null);
    assert.match(text(m.host), /<b>h<\/b>/);
    await m.unmount();
  });
});
