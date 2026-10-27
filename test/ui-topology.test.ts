// The Topology page (src/ui/topology.tsx) and the Access page (src/ui/access-page.tsx) against the real SDK client and a
// stub server, rendered in happy-dom: the graph and the Relationships table that is its accessible equivalent, the layer
// toggle (People and contacts / App access), the inspector, the table of people and agents, the notices (contacts and access
// unavailable, in plain words), the print button, plain messages for failures (L18), RUL-14 (a failed load is an error, not
// an empty state), names shown as text. Preview harness: GOV_PREVIEW_DIR=<dir> also writes the rendered pages as static HTML. The module is compiled with the build tsconfig into dist/ui-test-topology (JSX needs a compile).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type Page = typeof import("../src/ui/topology.tsx");
type AccessPageUi = typeof import("../src/ui/access-page.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-topology");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/fleet/topology", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;
let printed = 0;
g.print = () => {
  printed++;
};

// ── stub server ──────────────────────────────────────────────────────────────
const ANN = "psn_ann";
const SCOUT = "agt_01J0000000000000000000000B";
const FRONT = "agt_01J0000000000000000000000A";
const node = (id: string, kind: string, name: string, over: Record<string, unknown> = {}) => ({ id, kind, name, trust: kind === "team" ? null : "trusted", status: "active", reviewDueAt: null, changedSinceReview: false, ...over });
const edge = (kind: string, from: string, to: string, label: string, state = "live") => ({ id: `${kind}:${from}:${to}`, kind, from, to, label, state, since: null });
const SOURCES = { contacts: "unavailable", access: "not_requested", note: "Channel contacts are not shown. Connect does not offer contacts yet; update Connect." };
const ANSWER = () => ({
  nodes: [
    node(ANN, "person", "Ann Example", { reviewDueAt: "2026-12-01T00:00:00.000Z" }),
    node("psn_bot", "outside_agent", "Outside Bot", { trust: "limited", reviewDueAt: "2026-11-02T00:00:00.000Z", changedSinceReview: true }),
    node(FRONT, "agent", "Front desk", { reviewDueAt: "2026-10-12T00:00:00.000Z" }),
    node(SCOUT, "agent", "Scout", { status: "paused", trust: "blocked" }),
    node("tm_support", "team", "Support"),
  ],
  edges: [
    edge("owner", ANN, FRONT, "owns"),
    edge("member", ANN, "tm_support", "lead"),
    edge("member", "psn_bot", "tm_support", "member"),
    edge("member", SCOUT, "tm_support", "member", "blocked"),
    edge("member", FRONT, "tm_support", "member", "off"),
  ],
  sources: SOURCES,
});
const INS_KN = "ins_knowledge";
const INS_CN = "ins_connect";
/** access_get: available, with the grant picture in the object form */
const ACCESS = () => ({
  status: "available",
  note: "",
  topology: {
    instances: [
      { ins: INS_KN, product: "knowledge", name: "Knowledge", version: "1.2.0" },
      { ins: INS_CN, product: "connect", name: "Connect", version: "0.7.5" },
    ],
    edges: [
      { agent: FRONT, ins: INS_KN, product: "knowledge", crud: ["read"], mode: "free", held: [] },
      { agent: FRONT, ins: INS_CN, product: "connect", crud: ["create", "read", "update"], mode: "bound", held: ["first_contact", "money"], wf: 3 },
      { agent: SCOUT, ins: INS_KN, product: "knowledge", crud: ["read"], mode: "free", held: [], paused: true },
    ],
    companions: [{ from: INS_CN, to: INS_KN, product: "knowledge", crud: ["read"], ops: 2 }],
    connections: [{ con: "con_01J0000000000000000000KEY", agt: FRONT, method: "key", status: "active" }],
  },
  agents: [
    { id: FRONT, name: "Front desk" },
    { id: SCOUT, name: "Scout" },
  ],
  identities: [{ agent: FRONT, channel: "buzz", handle: "npub1frontdesk" }],
  generatedAt: "2026-10-27T09:00:00.000Z",
});
const NOT_CONSENTED = () => ({ status: "not_consented", note: "Access is not shared with this app. Turn on 'See who has access' for Governance in the Portal (app settings) to show this.", topology: null, agents: [], identities: [], generatedAt: "2026-10-27T09:00:00.000Z" });
interface Stub {
  calls: { op: string; input: any }[];
  fail: { status: number; code: string } | undefined;
  answer: any;
  /** the access_get answer; "fail" = the op answers 500 */
  access: any;
}
const stub: Stub = { calls: [], fail: undefined, answer: ANSWER(), access: ACCESS() };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any };
  stub.calls.push({ op, input: body.input });
  if (stub.fail && op === "topology_get") return json(stub.fail.status, { error: { code: stub.fail.code, message: `raw upstream text for ${stub.fail.code}`, requestId: "req_1" } });
  if (op === "topology_get") return json(200, { status: "ok", output: stub.answer });
  if (op === "access_get") return stub.access === "fail" ? json(500, { error: { code: "internal_error", message: "raw upstream text", requestId: "req_2" } }) : json(200, { status: "ok", output: stub.access });
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "fleet" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const click = async (el: Element) => {
  // an SVG group has no click(): send the event the browser would
  await act(async () => el.dispatchEvent(new (win.MouseEvent as unknown as typeof MouseEvent)("click", { bubbles: true, cancelable: true })));
  await flush();
};
const button = (root: ParentNode, text: string) => {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const alerts = (host: ParentNode) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const statuses = (host: ParentNode) => [...host.querySelectorAll('[role="status"]')].map((a) => a.textContent ?? "");
const cells = (section: Element | null) => [...(section?.querySelectorAll("tbody tr") ?? [])].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? ""));

let ui: Page;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  ui = (await import(pathToFileURL(join(outDir, "ui", "topology.js")).href)) as Page;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const previewDir = process.env.GOV_PREVIEW_DIR;
/** Write the rendered page as static HTML (light and dark) for a screenshot; off unless GOV_PREVIEW_DIR is set. */
function preview(name: string, host: Element): void {
  if (!previewDir) return;
  mkdirSync(previewDir, { recursive: true });
  const css = ["node_modules/@opt2-tealbrick/ui/dist/tokens.css", "node_modules/@opt2-tealbrick/ui/dist/components.css", "src/ui/pages.css", "src/ui/app.css", "src/ui/graph.css"].map((f) => `<link rel="stylesheet" href="${pathToFileURL(join(root, f)).href}">`).join("\n");
  for (const theme of ["light", "dark"]) {
    writeFileSync(
      join(previewDir, `${name}-${theme}.html`),
      `<!doctype html><html lang="en-GB" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title>\n${css}\n<style>body{margin:0;padding:24px;background:var(--tb-paper);color:var(--tb-ink);font-family:var(--tb-font)}@media (max-width:720px){body{padding:12px}}</style></head><body>${host.innerHTML}</body></html>`,
    );
  }
}
const reset = () => {
  stub.calls = [];
  stub.fail = undefined;
  stub.answer = ANSWER();
  stub.access = ACCESS();
  printed = 0;
};

describe("Topology page", () => {
  it("asks for the people layers and for access, and lists every relationship in a table, with the state of each", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    assert.deepEqual(stub.calls.map((c) => [c.op, c.input]).sort(), [
      ["access_get", {}],
      ["topology_get", { layers: ["org", "contacts"] }],
    ]);
    assert.equal(m.host.querySelector("h1")?.textContent, "Topology");
    assert.deepEqual(cells(m.host.querySelector('[aria-label="Relationships"]')), [
      ["Ann Example (person) psn_ann", "owns", "Front desk (agent) …00000A", "Live"],
      ["Ann Example (person) psn_ann", "leads", "Support (team) …upport", "Live"],
      ["Outside Bot (outside agent) psn_bot", "is a member of", "Support (team) …upport", "Live"],
      ["Scout (agent) …00000B", "is a member of", "Support (team) …upport", "Blocked"],
      ["Front desk (agent) …00000A", "is a member of", "Support (team) …upport", "Off"],
    ]);
    assert.deepEqual([...m.host.querySelectorAll('[aria-label="Relationships"] thead th')].map((x) => x.textContent), ["From", "Relationship", "To", "State"]);
    assert.match(m.host.querySelector('[aria-label="Relationships"]')?.textContent ?? "", /Off: one side is departed or paused\. Blocked: one side is blocked\./);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("draws the graph AND keeps the table: one card per person, agent and team's members, no 'later version' notice", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    const svg = m.host.querySelector('[aria-label="Network picture"] svg.topo-svg');
    assert.ok(svg, "the graph is drawn");
    assert.match(svg.getAttribute("aria-label") ?? "", /^Topology graph, read only: 1 person, 2 agents, 1 team, 0 apps, 1 outside contact, 5 links\.$/);
    assert.deepEqual(
      [...svg.querySelectorAll("g.g-node")].map((n) => n.getAttribute("data-id")).sort(),
      [ANN, FRONT, "psn_bot", SCOUT].sort(),
    );
    assert.ok(![...statuses(m.host)].some((t) => /later version/.test(t)));
    assert.equal(m.host.querySelectorAll('[aria-label="Relationships"] tbody tr').length, 5, "the table lists every relationship");
    await m.unmount();
  });

  it("layers: People and contacts is the default; App access draws the apps and the access wires, and the table follows the layer", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    const toggle = [...m.host.querySelectorAll(".tb-segmented button")];
    assert.deepEqual(toggle.map((b) => b.textContent), ["People and contacts", "App access"]);
    assert.equal(toggle[0]?.getAttribute("aria-pressed"), "true");
    preview("topology-people", m.host);
    await click(button(m.host, "App access"));
    const svg = m.host.querySelector("svg.topo-svg") as Element;
    assert.deepEqual(
      [...svg.querySelectorAll("g.g-node.is-app")].map((n) => n.getAttribute("data-id")).sort(),
      [INS_CN, INS_KN].sort(),
    );
    const rows = cells(m.host.querySelector('[aria-label="Relationships"]'));
    assert.ok(rows.some((r) => r[0]?.startsWith("Front desk") && r[1] === "may use (CRU)" && r[2]?.startsWith("Connect (app)")), JSON.stringify(rows));
    assert.ok(rows.some((r) => r[0]?.startsWith("Scout") && r[1] === "may use (R)" && r[3] === "Off"), "a paused grant is Off");
    assert.ok(rows.some((r) => r[0]?.startsWith("Connect (app)") && r[1] === "works with (R)" && r[2]?.startsWith("Knowledge (app)")));
    preview("topology-access", m.host);
    // back: the apps are gone again
    await click(button(m.host, "People and contacts"));
    assert.equal(m.host.querySelectorAll("g.g-node.is-app").length, 0);
    await m.unmount();
  });

  it("the inspector: select a card (click, or Enter) to see what ties it to the rest; select it again to close", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    assert.match(m.host.querySelector("aside")?.textContent ?? "", /Select a card or a team to see what ties it to the rest\./);
    const card = m.host.querySelector(`g.g-node[data-id="${FRONT}"]`) as Element;
    await act(async () => (card as unknown as HTMLElement).dispatchEvent(new (win.KeyboardEvent as unknown as typeof KeyboardEvent)("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const panel = m.host.querySelector('aside [aria-label="About Front desk"]');
    assert.ok(panel, "Enter opens the inspector");
    const text = panel.textContent ?? "";
    assert.match(text, /Front desk\s*Agent/);
    assert.match(text, /Trust\s*Trusted/);
    assert.match(text, /Next review\s*12 Oct 2026/);
    assert.match(text, /Owner and agents\s*is owned by Ann Example/);
    assert.match(text, /Teams\s*is a member of Support/);
    assert.equal(card.getAttribute("aria-pressed"), "true");
    await click(card);
    assert.equal(m.host.querySelector('aside [aria-label="About Front desk"]'), null);
    // a team region opens it too, and a card that changed since the last review says so
    stub.answer = ANSWER();
    await click(m.host.querySelector(`g.g-region[data-id="tm_support"]`) as Element);
    assert.match(m.host.querySelector('aside [aria-label="About Support"]')?.textContent ?? "", /Teams\s*is led by Ann Example.*has member Outside Bot/);
    await click(m.host.querySelector(`g.g-node[data-id="psn_bot"]`) as Element);
    assert.match(m.host.querySelector('aside [aria-label="About Outside Bot"]')?.textContent ?? "", /It changed since the last review\./);
    await m.unmount();
  });

  it("contacts available: contact wires are in the picture and the table; an outside node is named by the handle (no directory id)", async () => {
    reset();
    stub.answer = {
      nodes: [...ANSWER().nodes, node("ext_0123456789abcdef01234567", "outside_agent", "slack:UOUTSIDER1", { trust: null })],
      edges: [...ANSWER().edges, edge("contact", FRONT, ANN, "buzz, slack"), edge("contact", FRONT, "ext_0123456789abcdef01234567", "slack")],
      sources: { contacts: "available", access: "not_requested", note: "" },
    };
    const m = await mount(h(ui.TopologyPage, {}));
    const rows = cells(m.host.querySelector('[aria-label="Relationships"]'));
    assert.ok(rows.some((r) => r[0]?.startsWith("Front desk") && r[1] === "writes to (buzz, slack)" && r[2]?.startsWith("Ann Example")));
    const outside = rows.find((r) => r[2]?.startsWith("slack:UOUTSIDER1"));
    assert.equal(outside?.[2], "slack:UOUTSIDER1 (outside contact)", "named by the handle, no id");
    assert.ok(m.host.querySelector('svg.topo-svg g.g-node[data-id="ext_0123456789abcdef01234567"]'));
    assert.equal(statuses(m.host).length, 0, "quiet on good: nothing to say when both are available");
    // the outside contact is not a directory entry: not in the people table
    assert.ok(!cells(m.host.querySelector('[aria-label="People and agents"]')).some((r) => r[0]?.includes("UOUTSIDER1")));
    preview("topology-contacts", m.host);
    await m.unmount();
  });

  it("contacts unavailable: the server's plain sentence, no blank; app access not available: the note from access_get, on its layer", async () => {
    reset();
    stub.access = NOT_CONSENTED();
    const m = await mount(h(ui.TopologyPage, {}));
    assert.deepEqual(statuses(m.host), ["Channel contacts are not shown. Connect does not offer contacts yet; update Connect."]);
    await click(button(m.host, "App access"));
    assert.deepEqual(statuses(m.host), ["App access is not shown. Access is not shared with this app. Turn on 'See who has access' for Governance in the Portal (app settings) to show this."]);
    assert.ok(m.host.querySelector("svg.topo-svg"), "the people, agents and teams are still drawn");
    assert.equal(m.host.querySelectorAll("g.g-node.is-app").length, 0);
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream/);
    await m.unmount();
    // access_get failing is a plain sentence, not a broken page
    reset();
    stub.access = "fail";
    const failed = await mount(h(ui.TopologyPage, {}));
    await click(button(failed.host, "App access"));
    assert.ok(statuses(failed.host).includes("App access is not shown. The Access page could not be loaded. Try again later."));
    assert.doesNotMatch(failed.host.textContent ?? "", /raw upstream/);
    await failed.unmount();
    // contacts not asked for says so
    reset();
    stub.answer = { ...ANSWER(), sources: { contacts: "not_requested", access: "not_requested", note: "x" } };
    const part = await mount(h(ui.TopologyPage, {}));
    assert.ok(statuses(part.host).includes("Channel contacts were not asked for."));
    await part.unmount();
    // a shortened copy of access is said on the access layer
    reset();
    stub.access = { ...ACCESS(), topology: { ...ACCESS().topology, truncated: true } };
    const cut = await mount(h(ui.TopologyPage, {}));
    await click(button(cut.host, "App access"));
    assert.ok(statuses(cut.host).includes("The workspace sent a shortened copy of access: some apps and wires are not shown."));
    await cut.unmount();
  });

  it("lists the people and agents with trust, status and the next review, and flags a change since the last review", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    assert.deepEqual(cells(m.host.querySelector('[aria-label="People and agents"]')), [
      ["Ann Example", "Person", "psn_ann", "Trusted", "active", "1 Dec 2026"],
      ["Outside Bot", "Outside agent", "psn_bot", "Limited", "active", "2 Nov 2026Changed since the last review"],
      ["Front desk", "Agent", "…00000A", "Trusted", "active", "12 Oct 2026"],
      ["Scout", "Agent", "…00000B", "Blocked", "paused", "Not scheduled"],
    ]);
    assert.equal(m.host.querySelectorAll('[aria-label="People and agents"] tbody tr').length, 4, "teams are in the relationships, not here");
    await m.unmount();
  });

  it("Print for a security review opens the browser print, once per click; the printed page says when", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    assert.equal(printed, 0);
    await click(button(m.host, "Print for a security review"));
    assert.equal(printed, 1);
    assert.match(m.host.querySelector(".print-only")?.textContent ?? "", /^Governance topology, printed \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    assert.ok(button(m.host, "Print for a security review").className.includes("no-print"), "the button itself is not printed");
    await m.unmount();
  });

  it("names are shown as text, never as markup", async () => {
    reset();
    stub.answer = { ...ANSWER(), nodes: [node(ANN, "person", "<b>Ann</b>"), node("tm_support", "team", "Support")], edges: [edge("member", ANN, "tm_support", "lead")] };
    const m = await mount(h(ui.TopologyPage, {}));
    assert.equal(m.host.querySelector("td b"), null);
    assert.match(m.host.textContent ?? "", /<b>Ann<\/b> \(person\) psn_ann/);
    await m.unmount();
  });

  it("two entries with the same name differ in the printout: each shows the end of its id (S3-3)", async () => {
    reset();
    const A = "psn_01J00000000000000000000AAA";
    const B = "psn_01J00000000000000000000BBB";
    stub.answer = { ...ANSWER(), nodes: [node(A, "person", "Sam"), node(B, "person", "Sam"), node("tm_support", "team", "Support")], edges: [edge("member", A, "tm_support", "member"), edge("member", B, "tm_support", "lead")] };
    const m = await mount(h(ui.TopologyPage, {}));
    const rel = cells(m.host.querySelector('[aria-label="Relationships"]'));
    assert.deepEqual(rel.map((row) => row[0]), [`Sam (person) …${A.slice(-6)}`, `Sam (person) …${B.slice(-6)}`]);
    assert.notEqual(rel[0]?.[0], rel[1]?.[0]);
    const ppl = cells(m.host.querySelector('[aria-label="People and agents"]'));
    assert.deepEqual(ppl.map((row) => row[2]), [`…${A.slice(-6)}`, `…${B.slice(-6)}`]);
    assert.equal(m.host.querySelector(".id")?.getAttribute("title"), A, "the full id is in the title");
    await m.unmount();
  });

  it("no relationships: an empty state that says what to do; the people table still shows who exists", async () => {
    reset();
    stub.answer = { ...ANSWER(), edges: [] };
    const m = await mount(h(ui.TopologyPage, {}));
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "No relationships yet.");
    assert.equal(m.host.querySelectorAll('[aria-label="Relationships"] table').length, 0);
    assert.equal(m.host.querySelectorAll('[aria-label="People and agents"] tbody tr').length, 4);
    await m.unmount();
    reset();
    stub.answer = { nodes: [], edges: [], sources: SOURCES };
    const none = await mount(h(ui.TopologyPage, {}));
    assert.match(none.host.textContent ?? "", /No people or agents in the directory yet\./);
    await none.unmount();
  });

  it("RUL-14: a failed load is an error with Try again, not an empty state", async () => {
    reset();
    stub.fail = { status: 500, code: "internal_error" };
    const m = await mount(h(ui.TopologyPage, {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(alerts(m.host)[0] ?? "", /raw upstream/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    assert.equal(m.host.querySelector("table"), null);
    stub.fail = undefined;
    await click(button(m.host, "Try again"));
    assert.equal(m.host.querySelectorAll('[aria-label="Relationships"] tbody tr').length, 5);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("a directory beyond the caps: a plain notice with the numbers, no table, no raw error", async () => {
    reset();
    stub.fail = { status: 503, code: "topology_too_large" };
    const m = await mount(h(ui.TopologyPage, {}));
    assert.match(alerts(m.host)[0] ?? "", /too big to list in one answer: more than 3,000 people, agents and teams, or more than 10,000 relationships\. The Teams, People and Agents pages still list everything\./);
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream|topology_too_large/);
    assert.equal(m.host.querySelector("table"), null);
    assert.equal(m.host.querySelector(".tb-empty"), null, "not an empty state");
    await m.unmount();
  });

  it("a signed-out session is the shared message, not a blank page", async () => {
    reset();
    stub.fail = { status: 401, code: "session_required" };
    const m = await mount(h(ui.TopologyPage, {}));
    assert.match(alerts(m.host)[0] ?? "", /signed out/);
    await m.unmount();
  });
});

describe("Access page", () => {
  let accessUi: AccessPageUi;
  before(async () => {
    accessUi = (await import(pathToFileURL(join(outDir, "ui", "access-page.js")).href)) as AccessPageUi;
  });

  it("asks access_get (and nothing else), shows the grant view with words for the held actions, and a link to Portal", async () => {
    reset();
    const m = await mount(h(accessUi.AccessPage, { portalHref: "https://portal.example/canvas" }));
    assert.deepEqual(stub.calls.map((c) => c.op), ["access_get"]);
    assert.equal(m.host.querySelector("h1")?.textContent, "Access");
    const front = m.host.querySelector('[aria-label="Agent Front desk"]');
    assert.ok(front);
    assert.match(front.textContent ?? "", /con_01J0000000000000000000KEY/);
    assert.match(front.textContent ?? "", /npub1frontdesk/);
    assert.deepEqual(cells(front).map((r) => r.slice(0, 5)), [
      ["Connect", "CRU", "bound", "first contact, money", "3"],
      ["Knowledge", "R", "free", "None", "All"],
    ]);
    assert.doesNotMatch(m.host.textContent ?? "", /first_contact|profile_change|public_link/, "families are words, never ids");
    assert.equal(m.host.querySelector('a[href="https://portal.example/canvas"]')?.textContent, "Change access in Portal");
    preview("access-page", m.host);
    await m.unmount();
  });

  it("not consented: one plain notice with what to do, no table, no blank page; the Portal link stays", async () => {
    reset();
    stub.access = NOT_CONSENTED();
    const m = await mount(h(accessUi.AccessPage, { portalHref: "https://portal.example/canvas" }));
    assert.deepEqual(statuses(m.host), ["App access is not shown. Access is not shared with this app. Turn on 'See who has access' for Governance in the Portal (app settings) to show this."]);
    assert.equal(m.host.querySelector("table"), null);
    assert.equal(m.host.querySelector('a[href="https://portal.example/canvas"]')?.textContent, "Change access in Portal");
    preview("access-unavailable", m.host);
    await m.unmount();
  });

  it("a failed load is an error with Try again (RUL-14); the plain sentence has no raw upstream text", async () => {
    reset();
    stub.access = "fail";
    const m = await mount(h(accessUi.AccessPage, {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream/);
    assert.equal(m.host.querySelector("table"), null);
    stub.access = ACCESS();
    await click(button(m.host, "Try again"));
    assert.deepEqual(alerts(m.host), []);
    assert.ok(m.host.querySelector('[aria-label="Agent Front desk"]'));
    await m.unmount();
  });

  it("available with a note (Connect could not give channel identities): the note is shown above the picture", async () => {
    reset();
    stub.access = { ...ACCESS(), note: "Channel identities are not shown. Connect did not answer (error). Try again later.", identities: [] };
    const m = await mount(h(accessUi.AccessPage, {}));
    assert.ok(statuses(m.host).includes("Channel identities are not shown. Connect did not answer (error). Try again later."));
    assert.ok(m.host.querySelector('[aria-label="Agent Front desk"]'));
    await m.unmount();
  });
});
