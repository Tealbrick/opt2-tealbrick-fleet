// The list filters of Governance (C382 batch 4): People and agents, Access, the Relationships table and Identities. Each one says N of M and has
// Clear, a remembered filter shows after a reload, a list the server cut says the filter read only what is loaded, a complete list says it
// searched all rows, held calls the text hides are counted, and the print of the Relationships table keeps every row. Compiled with the build
// tsconfig and rendered in happy-dom against a stub server (the harness of the Tier 2 page tests).
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { cleanUi, compileUi, h, mount, ok, reset, stub, typeInto } from "./ui-harness.ts";

const root = new URL("..", import.meta.url).pathname;
const NAME = "ui-test-c382-filter";
const loadPage = compileUi(NAME);
const loadUi = (file: string) => import(pathToFileURL(join(root, "dist", NAME, "ui", `${file}.js`)).href);
after(() => cleanUi(NAME));

const KEY = "tb-filter:/a/fleet/:";
const remember = (screen: string, v: string) => localStorage.setItem(`${KEY}${screen}`, v);
const text = (host: Element) => host.textContent ?? "";
const click = async (el: Element) => {
  const { act } = await import("react");
  await act(async () => (el as HTMLElement).click());
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const buttons = (host: Element, label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
const input = (host: Element) => host.querySelector("input") as HTMLInputElement;
const fresh = () => {
  reset();
  localStorage.clear();
};

// ── People and agents ──────────────────────────────────────────────────────
const ROW = (n: number, over: Record<string, unknown> = {}) => ({
  kind: n % 3 === 0 ? "person" : "agent",
  id: `${n % 3 === 0 ? "per" : "agt"}_${n}`,
  name: `${n % 3 === 0 ? "Person" : "Agent"} ${String(n).padStart(2, "0")}`,
  lifecycle: "active",
  effective: "active",
  runtime: "running",
  trust: "trusted",
  owner: n % 3 === 0 ? null : { id: "per_0", name: "Marco" },
  line: "Working",
  findings: [],
  validFrom: null,
  validUntil: null,
  keepRunning: false,
  at: null,
  ...over,
});
const colleagues = (n: number, total = n) => ok({ items: Array.from({ length: n }, (_, i) => ROW(i)), total, nextCursor: null });

describe("People and agents filter", () => {
  it("a short list shows no filter bar", async () => {
    fresh();
    stub.answers.colleagues_list = colleagues(3);
    const { EveryonePage } = (await loadPage("everyone")) as { EveryonePage: (p: any) => never };
    const m = await mount(h(EveryonePage, {}));
    assert.equal(m.host.querySelector("input"), null);
    assert.equal(m.host.querySelectorAll("tbody tr").length, 3);
    await m.unmount();
  });

  it("a long list: the text narrows it, shows N of M, Clear brings every row back", async () => {
    fresh();
    stub.answers.colleagues_list = colleagues(10);
    const { EveryonePage } = (await loadPage("everyone")) as { EveryonePage: (p: any) => never };
    const m = await mount(h(EveryonePage, {}));
    assert.equal(m.host.querySelectorAll("tbody tr").length, 10);
    await typeInto(input(m.host), "Agent 04");
    assert.equal(m.host.querySelectorAll("tbody tr").length, 1);
    assert.match(text(m.host), /Showing 1 of 10 people and agents\./);
    assert.doesNotMatch(text(m.host), /loaded so far/, "the list is whole: nothing is cut");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll("tbody tr").length, 10);
    assert.equal(localStorage.getItem(`${KEY}everyone`), "");
    await m.unmount();
  });

  it("a remembered filter shows after a reload even when the list is short, and a whole list with no match says all rows were searched", async () => {
    fresh();
    stub.answers.colleagues_list = colleagues(3);
    remember("everyone", "zzz");
    const { EveryonePage } = (await loadPage("everyone")) as { EveryonePage: (p: any) => never };
    const m = await mount(h(EveryonePage, {}));
    assert.equal(input(m.host).value, "zzz");
    assert.match(text(m.host), /Showing 0 of 3 people and agents\./);
    assert.match(text(m.host), /No person or agent matches\. The filter searched all 3 people and agents\./);
    await m.unmount();
  });

  it("the Show choice counts as a filter, and Clear sets it back", async () => {
    fresh();
    stub.answers.colleagues_list = colleagues(10);
    const { EveryonePage } = (await loadPage("everyone")) as { EveryonePage: (p: any) => never };
    const m = await mount(h(EveryonePage, {}));
    await click(buttons(m.host, "People")[0] ?? ([...m.host.querySelectorAll('[role="radio"],button,label')].find((e) => e.textContent?.trim() === "People") as Element));
    assert.match(text(m.host), /Showing 4 of 10 people and agents\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll("tbody tr").length, 10);
    await m.unmount();
  });

  it("a list the page limit cut says the filter read only the loaded rows", async () => {
    fresh();
    stub.answers.colleagues_list = colleagues(10, 4000);
    remember("everyone", "nobody here");
    const { EveryonePage } = (await loadPage("everyone")) as { EveryonePage: (p: any) => never };
    const m = await mount(h(EveryonePage, {}));
    assert.match(text(m.host), /No loaded person or agent matches\./);
    assert.match(text(m.host), /The filter searches only the 10 people and agents loaded so far\./);
    assert.match(text(m.host), /Showing 0 of 10 loaded people and agents\./);
    await m.unmount();
  });
});

describe("People and agents filter, review round 1", () => {
  it("a list the server cut: the Show choice alone with no rows says it read only the loaded rows, never 'all'", async () => {
    fresh();
    stub.answers.colleagues_list = ok({ items: Array.from({ length: 10 }, (_, i) => ROW(i, { kind: "agent", id: `agt_${i}`, name: `Agent ${i}` })), total: 4000, nextCursor: null });
    const { EveryonePage } = (await loadPage("everyone")) as { EveryonePage: (p: any) => never };
    const m = await mount(h(EveryonePage, {}));
    await click(buttons(m.host, "People")[0] ?? ([...m.host.querySelectorAll('[role="radio"],button,label')].find((e) => e.textContent?.trim() === "People") as Element));
    assert.equal(m.host.querySelectorAll("tbody tr").length, 0);
    assert.match(text(m.host), /No loaded person or agent matches\./);
    assert.match(text(m.host), /The filter searches only the 10 people and agents loaded so far\./);
    assert.doesNotMatch(text(m.host), /The filter searched all/);
    await m.unmount();
  });
});

// ── Identities ─────────────────────────────────────────────────────────────
const idRows = (n: number) => Array.from({ length: n }, (_, i) => ({ agent: { id: `agt_${i}`, name: `Agent ${String(i).padStart(2, "0")}` }, channel: i % 2 ? "buzz" : "email", identity: `${i % 2 ? "buzz" : "email"}:handle-${i}` }));
const identities = (n: number, note = "") => ok({ connect: { status: "available", note }, people: [], agents: idRows(n) });

describe("Identities filter", () => {
  it("narrows by agent, channel or handle, shows N of M, and Clear restores", async () => {
    fresh();
    stub.answers.identities_view = identities(10);
    const { Identities } = (await loadPage("identities")) as { Identities: (p: any) => never };
    const m = await mount(h(Identities, {}));
    assert.equal(m.host.querySelectorAll(".item").length, 10);
    await typeInto(input(m.host), "buzz");
    assert.equal(m.host.querySelectorAll(".item").length, 5);
    assert.match(text(m.host), /Showing 5 of 10 identities\./);
    await typeInto(input(m.host), "handle-7");
    assert.equal(m.host.querySelectorAll(".item").length, 1);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll(".item").length, 10);
    await m.unmount();
  });

  it("a remembered filter shows on a short list; a whole list says all rows were searched", async () => {
    fresh();
    stub.answers.identities_view = identities(3);
    remember("identities", "nothing");
    const { Identities } = (await loadPage("identities")) as { Identities: (p: any) => never };
    const m = await mount(h(Identities, {}));
    assert.equal(input(m.host).value, "nothing");
    assert.match(text(m.host), /No identity matches\. The filter searched all 3 identities\./);
    await m.unmount();
  });

  it("when Connect holds more than the server read (the note says so), the filter says it read only the loaded rows", async () => {
    fresh();
    stub.answers.identities_view = identities(10, "Showing the first 10 identities.");
    remember("identities", "nothing");
    const { Identities } = (await loadPage("identities")) as { Identities: (p: any) => never };
    const m = await mount(h(Identities, {}));
    assert.match(text(m.host), /No loaded identity matches\./);
    assert.match(text(m.host), /The filter searches only the 10 identities loaded so far\./);
    await m.unmount();
  });
});

// ── Access ─────────────────────────────────────────────────────────────────
const INS = ["ins_knowledge", "ins_connect"];
const slice = (agents: number, truncated = false) => ({
  instances: [
    { ins: INS[0], product: "knowledge", name: "Knowledge", version: "1.0.0" },
    { ins: INS[1], product: "connect", name: "Connect", version: "0.7.5" },
  ],
  // every third agent has a call family held for approval at Connect
  edges: Array.from({ length: agents }, (_, i) => ({ agent: `agt_${i}`, ins: i % 3 === 0 ? INS[1] : INS[0], product: i % 3 === 0 ? "connect" : "knowledge", crud: ["read"], mode: "free", held: i % 3 === 0 ? ["money"] : [] })),
  companions: [],
  connections: [],
  ...(truncated ? { truncated: true as const } : {}),
});
const agentList = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `agt_${i}`, name: `Agent ${String(i).padStart(2, "0")}` }));

describe("Access filter", () => {
  it("a short list keeps the two selects and shows no bar", async () => {
    fresh();
    const { AccessView } = (await loadUi("access")) as { AccessView: (p: any) => never };
    const m = await mount(h(AccessView, { slice: slice(3), agents: agentList(3), identities: [] }));
    assert.equal(m.host.querySelectorAll("select").length, 2);
    assert.equal(m.host.querySelector("input"), null);
    await m.unmount();
  });

  it("a long list: the text narrows the cards, shows N of M, keeps the selects, keeps Held for approval, counts hidden held calls, and Clear restores", async () => {
    fresh();
    const { AccessView } = (await loadUi("access")) as { AccessView: (p: any) => never };
    const m = await mount(h(AccessView, { slice: slice(9), agents: agentList(9), identities: [] }));
    assert.equal(m.host.querySelectorAll(".access-card").length, 9);
    assert.equal(m.host.querySelectorAll("select").length, 2, "the two selects stay next to the text");
    await typeInto(input(m.host), "Agent 01");
    assert.equal(m.host.querySelectorAll(".access-card").length, 1);
    assert.match(text(m.host), /Showing 1 of 9 agents\./);
    assert.match(text(m.host), /Held for approval/, "the column stays");
    const alert = [...m.host.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");
    assert.match(alert, /3 agents that have calls held for approval are hidden by the filter\./, "agents 0, 3, 6 hold calls and are hidden");
    await typeInto(input(m.host), "Agent 03");
    const alert2 = [...m.host.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");
    assert.match(alert2, /2 agents that have calls held for approval are hidden/, "agent 03 is shown, 0 and 6 are hidden");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll(".access-card").length, 9);
    assert.equal(input(m.host).value, "");
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
    await m.unmount();
  });

  it("a remembered filter shows after a reload; a whole copy with no match says all rows were searched; a shortened copy says the filter read only the loaded rows", async () => {
    fresh();
    remember("access", "zzz");
    const { AccessView } = (await loadUi("access")) as { AccessView: (p: any) => never };
    const m = await mount(h(AccessView, { slice: slice(3), agents: agentList(3), identities: [] }));
    assert.equal(input(m.host).value, "zzz");
    assert.match(text(m.host), /No agent matches\. The filter searched all 3 agents\./);
    // the selects stay where they are when Clear removes the bar
    const before = [...m.host.querySelectorAll("select")];
    assert.equal(before.length, 2);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelector("input"), null, "the bar is gone on a short list");
    const after = [...m.host.querySelectorAll("select")];
    assert.equal(after.length, 2);
    assert.ok(after.every((el, i) => el === before[i]), "the same two select elements: focus is kept");
    await m.unmount();
    remember("access", "zzz");
    const t = await mount(h(AccessView, { slice: slice(9, true), agents: agentList(9), identities: [] }));
    assert.match(text(t.host), /No loaded agent matches\./);
    assert.match(text(t.host), /The filter searches only the 9 agents loaded so far\./);
    assert.match(text(t.host), /shortened copy of access/, "the page's own notice stays");
    await t.unmount();
  });

  it("an agent chosen in the select is a filter: Clear resets it and the text", async () => {
    fresh();
    const { AccessView } = (await loadUi("access")) as { AccessView: (p: any) => never };
    const m = await mount(h(AccessView, { slice: slice(9), agents: agentList(9), identities: [] }));
    const { act } = await import("react");
    const sel = m.host.querySelectorAll("select")[0] as HTMLSelectElement;
    await act(async () => {
      sel.value = "agt_2";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(m.host.querySelectorAll(".access-card").length, 1);
    assert.match(text(m.host), /Showing 1 of 9 agents\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll(".access-card").length, 9);
    await m.unmount();
  });
});

// ── Relationships ──────────────────────────────────────────────────────────
const node = (id: string, kind: string, name: string) => ({ id, kind, name, trust: kind === "team" ? null : "trusted", status: "active", reviewDueAt: null, changedSinceReview: false });
const topology = (agents: number) => ({
  nodes: [node("psn_ann", "person", "Ann Example"), ...Array.from({ length: agents }, (_, i) => node(`agt_${i}`, "agent", `Agent ${String(i).padStart(2, "0")}`))],
  edges: Array.from({ length: agents }, (_, i) => ({ id: `owner:psn_ann:agt_${i}`, kind: "owner", from: "psn_ann", to: `agt_${i}`, label: "owns", state: "live", since: null })),
  sources: { contacts: "unavailable", access: "not_requested", note: "Channel contacts are not shown." },
});
const relRows = (host: Element) => [...host.querySelectorAll('section[aria-label="Relationships"] table:not(.print-only) tbody tr')];

describe("Relationships filter", () => {
  it("a long table: the text narrows it, shows N of M, the print copy keeps every row, Clear restores", async () => {
    fresh();
    stub.answers.topology_get = ok(topology(10));
    stub.answers.access_get = () => ({ status: 500, body: { error: { code: "internal_error", message: "x" } } });
    const { TopologyPage } = (await loadUi("topology")) as { TopologyPage: (p: any) => never };
    const m = await mount(h(TopologyPage, {}));
    assert.equal(relRows(m.host).length, 10);
    assert.equal(m.host.querySelectorAll("table.print-only").length, 0, "nothing is hidden: no second table");
    await typeInto(input(m.host), "Agent 07");
    assert.equal(relRows(m.host).length, 1);
    assert.match(text(m.host), /Showing 1 of 10 relationships\./);
    assert.doesNotMatch(text(m.host), /loaded so far/, "topology_get answers whole or refuses");
    const printed = m.host.querySelector('section[aria-label="Relationships"] table.print-only') as Element;
    assert.equal(printed.querySelectorAll("tbody tr").length, 10, "the security-review print lists every relationship");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(relRows(m.host).length, 10);
    assert.equal(m.host.querySelectorAll("table.print-only").length, 0);
    await m.unmount();
  });

  it("a remembered filter with no match says all relationships were searched", async () => {
    fresh();
    stub.answers.topology_get = ok(topology(3));
    stub.answers.access_get = () => ({ status: 500, body: { error: { code: "internal_error", message: "x" } } });
    remember("topology:relationships", "zzz");
    const { TopologyPage } = (await loadUi("topology")) as { TopologyPage: (p: any) => never };
    const m = await mount(h(TopologyPage, {}));
    assert.equal(input(m.host).value, "zzz");
    assert.match(text(m.host), /No relationship matches\. The filter searched all 3 relationships\./);
    await m.unmount();
  });
});
