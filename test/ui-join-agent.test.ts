// Join for a new agent (src/ui/pages/join-agent.tsx, C380 T2-d) against the real SDK client and a stub server, rendered in happy-dom: which agent,
// its owner, what apps report (no words about stopping), the review last, a failed review and Send again, and nothing waiting.
// The pixel matrix is scripts/ui-preview.ts; this one runs in CI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-join-agent");

const win = new Window({ url: "http://localhost/a/fleet/join", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "PopStateEvent"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const PEOPLE = [{ kind: "person", id: "psn_marco", name: "Marco Rossi", lifecycle: "active" }, { kind: "person", id: "psn_ann", name: "Ann Smith", lifecycle: "active" }];
const AGENTS = [{ kind: "agent", id: "agt_henry", name: "Henry", lifecycle: "proposed", owner: null, validUntil: null }];
const PREVIEW = { subject: { kind: "agent", id: "agt_henry", name: "Henry" }, asOf: "2026-10-30T16:00:00Z", unlinkedAccounts: 0, stores: [{ product: "knowledge", name: "Knowledge", state: "read", text: null, at: "2026-10-30T16:00:00Z", notShown: [], items: [{ id: "k:1", kind: "agent_area", label: "Area: Sales notes", level: "use", direction: "held_by", state: "active", effect: "stops", who: null }] }] };
const DIR = { revision: 3, teams: [{ id: "tm_support", name: "Support", description: "", tags: [], people: 1, agents: 0, updatedAt: "2026-10-30T09:00:00Z", members: [{ kind: "person", id: "psn_marco", name: "Marco Rossi", role: "lead" }] }], people: [], agents: [] };
interface Stub {
  calls: { op: string; input: any; key: string | null }[];
  agents: unknown[];
  refuse: Record<string, { status: number; code: string; message: string } | undefined>;
}
const stub: Stub = { calls: [], agents: AGENTS, refuse: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["lifecycle_set"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any; idempotencyKey?: string };
  stub.calls.push({ op, input: body.input, key: body.idempotencyKey ?? null });
  const r = stub.refuse[op];
  if (r) {
    stub.refuse[op] = undefined; // refused once
    return json(r.status, { error: { code: r.code, message: r.message } });
  }
  if (op === "colleagues_list") return json(200, { status: "ok", output: { items: body.input.kind === "agent" ? stub.agents : PEOPLE, nextCursor: null, total: 1 } });
  if (op === "overview_get") return json(200, { status: "ok", output: DIR });
  if (op === "plan_preview") return json(200, { status: "ok", output: PREVIEW });
  if (op === "colleague_get") return json(200, { status: "ok", output: { colleague: { rev: 5 } } });
  if (op === "agent_set" || op === "members_set" || op === "lifecycle_set") return json(200, { status: "ok", output: {} });
  return json(404, { error: { code: "unknown_tool", message: op } });
}) as typeof fetch;
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const off of mounted.splice(0)) await off();
  for (const d of document.querySelectorAll("dialog")) d.remove();
});
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  let live = true;
  mounted.push(async () => {
    if (live) await act(async () => r.unmount());
    live = false;
    host.remove();
  });
  await act(async () => r.render(h(TbProvider, { product: "fleet" }, el)));
  await flush();
  return host;
}
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const dialog = () => document.querySelector("dialog") as HTMLDialogElement;
const button = (text: string) => {
  const found = [...dialog().querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
async function type(el: Element, value: string) {
  await act(async () => {
    const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    assert.ok(set, "the value setter");
    set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    el.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
  });
}
const field = (label: string) => {
  const l = [...dialog().querySelectorAll("label")].find((x) => x.textContent?.startsWith(label));
  assert.ok(l, `field ${label}`);
  return (l as HTMLElement).querySelector("input, textarea") as Element;
};
/** A step change fades with a timer: wait until it is done, as in test/ui-lifecycle-pages.test.ts. */
const next = async (label = "Next") => {
  await click(button(label));
  await act(async () => new Promise((r) => setTimeout(r, 450)));
  await flush();
};
const choose = async (title: string) => click([...dialog().querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes(title)) as Element);
const alerts = () => [...dialog().querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const reset = () => {
  stub.calls = [];
  stub.refuse = {};
  stub.agents = AGENTS;
};

type Flow = typeof import("../src/ui/pages/join-agent.tsx");
let flow: Flow;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  flow = (await import(pathToFileURL(join(outDir, "ui", "pages", "join-agent.js")).href)) as Flow;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const open = () => mount(h(flow.JoinAgentFlow, { portalHref: "https://portal.tealbrick.com/", onClose() {}, onChanged: () => {} }));
const pick = async (index: number, option: string) => {
  await click(dialog().querySelectorAll('[role="combobox"]')[index] as Element);
  await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === option) as Element);
};

describe("Join: a new agent", () => {
  it("which agent, an owner, what apps report with no words about stopping, then the review last", async () => {
    reset();
    await open();
    assert.equal(button("Next").disabled, true, "an agent is chosen first");
    await pick(0, "Henry");
    await next();
    assert.equal(button("Next").disabled, true, "the review needs an owner: this agent has none");
    await pick(1, "Marco Rossi");
    assert.equal(button("Next").disabled, false);
    await pick(2, "Support");
    await next();
    const reach = dialog().textContent ?? "";
    assert.match(reach, /Area: Sales notes/);
    assert.match(reach, /Reviewing it changes none of this\./);
    assert.doesNotMatch(reach, /Would stop/, "nothing stops here: the words about a stop are not shown");
    await next();
    assert.match(dialog().textContent ?? "", /It grants no access and changes nothing in Portal\./);
    const sentBefore = stub.calls.filter((c) => ["agent_set", "members_set", "lifecycle_set"].includes(c.op));
    assert.deepEqual(sentBefore, [], "nothing is sent before Confirm");
    await next("Mark as reviewed");
    const sent = stub.calls.filter((c) => ["agent_set", "members_set", "colleague_get", "lifecycle_set"].includes(c.op));
    assert.deepEqual(sent.map((c) => c.op), ["agent_set", "members_set", "colleague_get", "lifecycle_set"]);
    assert.deepEqual(sent[0]?.input, { agent: "agt_henry", owner: "psn_marco" });
    assert.deepEqual(sent[1]?.input, { team: "tm_support", people: [{ id: "psn_marco", role: "lead" }], agents: [{ id: "agt_henry", role: "member" }] });
    assert.deepEqual(sent[3]?.input, { kind: "agent", id: "agt_henry", to: "active", reason: "reviewed", expectedRev: 5 });
    assert.match(String(sent[3]?.key), /^join-[0-9a-f-]+-review-1$/);
    const text = dialog().textContent ?? "";
    assert.match(text, /Henry is marked as reviewed\./);
    assert.match(text, /The agent is in the team Support\./);
  });

  it("a last day goes in the review; a refused review keeps the owner and Send again repeats only the review", async () => {
    reset();
    stub.refuse.lifecycle_set = { status: 409, code: "lifecycle_stale", message: "This entry changed since you looked. Open it again." };
    await open();
    await pick(0, "Henry");
    await next();
    await pick(1, "Ann Smith");
    await choose("Has a last day");
    await type(field("Last day"), "2099-12-31");
    await next();
    await next();
    await next("Mark as reviewed");
    assert.match(alerts().join(" "), /The agent was not marked as reviewed\./);
    assert.match(dialog().textContent ?? "", /The owner is saved\./);
    await click(button("Send again"));
    const reviews = stub.calls.filter((c) => c.op === "lifecycle_set");
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1]?.input.validUntil, "2099-12-31T23:59:59.000Z");
    assert.equal(stub.calls.filter((c) => c.op === "agent_set").length, 1, "the owner is not set again");
    assert.match(dialog().textContent ?? "", /Henry is marked as reviewed\./);
  });

  it("an agent that has a last day already: it is said, and \"Has no end\" removes it (validUntil null) instead of leaving a stop the screen did not mention", async () => {
    reset();
    stub.agents = [{ ...AGENTS[0], validUntil: "2026-12-01T00:00:00Z" }];
    await open();
    await pick(0, "Henry");
    await next();
    assert.match(dialog().textContent ?? "", /This agent has a last day already: 1 Dec 2026/);
    await pick(1, "Marco Rossi");
    await next();
    await next();
    assert.match(dialog().textContent ?? "", /None\. The last day it has now is removed\./);
    await next("Mark as reviewed");
    assert.equal(stub.calls.find((c) => c.op === "lifecycle_set")?.input.validUntil, null);
  });

  it("a last day that ended while the dialog was open is refused at the send: the agent is not marked as reviewed with no end date", async () => {
    reset();
    await open();
    await pick(0, "Henry");
    await next();
    await pick(1, "Marco Rossi");
    await choose("Has a last day");
    await type(field("Last day"), new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
    await next();
    await next();
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 86_400_000;
    try {
      await next("Mark as reviewed");
    } finally {
      Date.now = realNow;
    }
    assert.match(alerts().join(" "), /The last day is not right\. This day has passed in UTC\. Choose a later day\. Nothing was changed\./);
    assert.deepEqual(stub.calls.filter((c) => ["agent_set", "members_set", "lifecycle_set"].includes(c.op)), []);
  });

  it("no new agent waits: the page says so and Next stays off", async () => {
    reset();
    stub.agents = [];
    await open();
    assert.match(dialog().textContent ?? "", /No new agent waits for a review\./);
    assert.equal(button("Next").disabled, true);
  });
});
