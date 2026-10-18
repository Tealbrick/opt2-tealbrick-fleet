// The Topology page (src/ui/topology.tsx) against the real SDK client and a stub server, rendered in happy-dom: the
// Relationships table, the table of people and agents, the notices (no graph yet, contacts and access unavailable),
// the print button, plain messages for failures (L18), RUL-14 (a failed load is an error, not an empty state), names
// shown as text. The module is compiled with the build tsconfig into dist/ui-test-topology (JSX needs a compile).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type Page = typeof import("../src/ui/topology.tsx");

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
const SOURCES = { contacts: "unavailable", access: "unavailable", note: "Channel contacts are not shown: the Connect contact book is not available to apps yet. App access is not shown: the copy of access from Portal is not available to apps yet. Change access in Portal." };
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
interface Stub {
  calls: { op: string; input: any }[];
  fail: { status: number; code: string } | undefined;
  answer: any;
}
const stub: Stub = { calls: [], fail: undefined, answer: ANSWER() };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any };
  stub.calls.push({ op, input: body.input });
  if (stub.fail) return json(stub.fail.status, { error: { code: stub.fail.code, message: `raw upstream text for ${stub.fail.code}`, requestId: "req_1" } });
  if (op === "topology_get") return json(200, { status: "ok", output: stub.answer });
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
  await act(async () => (el as HTMLElement).click());
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
const reset = () => {
  stub.calls = [];
  stub.fail = undefined;
  stub.answer = ANSWER();
  printed = 0;
};

describe("Topology page", () => {
  it("asks for the three layers and lists every relationship in a table, with the state of each", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    assert.deepEqual(stub.calls, [{ op: "topology_get", input: { layers: ["org", "contacts", "access"] } }]);
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

  it("says plainly that the network picture comes later, and draws no graph", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    assert.ok(statuses(m.host).includes("The network picture comes in a later version. The table below lists every relationship."));
    assert.equal(m.host.querySelector("canvas, svg"), null, "no app-local graph");
    await m.unmount();
  });

  it("states that contacts and access are not available: what is missing and what to do (L18, L3)", async () => {
    reset();
    const m = await mount(h(ui.TopologyPage, {}));
    const notes = statuses(m.host);
    assert.ok(notes.some((t) => /^Channel contacts are not shown\. The Connect contact book is not available to apps yet/.test(t)));
    assert.ok(notes.some((t) => /^App access is not shown\. The copy of access from Portal is not available to apps yet.*Change access in Portal\.$/.test(t)));
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream/);
    await m.unmount();
    // quiet on good: a layer that is available has no notice
    reset();
    stub.answer = { ...ANSWER(), sources: { contacts: "available", access: "available", note: "" } };
    const ok = await mount(h(ui.TopologyPage, {}));
    assert.equal(statuses(ok.host).length, 1, "only the graph notice");
    await ok.unmount();
    // a layer that was not asked for says so too
    reset();
    stub.answer = { ...ANSWER(), sources: { contacts: "not_requested", access: "unavailable", note: "x" } };
    const part = await mount(h(ui.TopologyPage, {}));
    assert.ok(statuses(part.host).includes("Channel contacts were not asked for."));
    await part.unmount();
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
