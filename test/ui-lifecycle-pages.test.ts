// Summary, People and agents, Stop now (src/ui/pages) against the real SDK client and a stub server, rendered in happy-dom: the page says
// what the server said and no more, Stop now sends one reason and reads back the result, the cap confirm sends the server's count, a lost
// answer does not read as a failure. The pixel matrix is scripts/ui-preview.ts; this one runs in CI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-lifecycle");

const win = new Window({ url: "http://localhost/a/fleet/", width: 1280, height: 860 });
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

const FLOOR = (over: Record<string, unknown> = {}) => ({ state: "not_confirmed", text: "Not confirmed: nothing may stop until you approve in Portal.", version: "0.7.0", feedRevision: 1, entries: 0, lastGateAt: null, gateNote: null, ...over });
const SUMMARY = (over: Record<string, unknown> = {}) => ({
  generatedAt: "2026-10-30T16:00:00Z",
  revision: 1,
  agents: { total: 2, running: 2, paused: 0, stopping: 0, notReviewed: 1 },
  people: { total: 1, leaving: 0, suspended: 0 },
  noOwner: 1,
  differences: 2,
  canWriteOrSend: null,
  stores: [
    { product: "core", name: "Portal", state: "read", text: "From the workspace copy.", at: "2026-10-30T16:00:00Z" },
    { product: "rules", name: "Rules & Approvals", state: "not_read", text: "Could not be read.", at: null },
  ],
  readiness: [{ id: "owners", state: "missing", text: "1 agents have no owner.", path: "/people-and-agents" }],
  stoppedToday: 0,
  stopCap: { limit: 5, windowMinutes: 10, used: 0 },
  floor: FLOOR({ state: "confirmed", text: "Rules has this change." }),
  settings: { coolingDays: 30, defaultOwner: null, stopCap: 5 },
  ...over,
});
const ROW = (over: Record<string, unknown> = {}) => ({ kind: "agent", id: "agt_A", name: "Henry", lifecycle: "active", effective: "active", runtime: "running", trust: "trusted", owner: { id: "per_1", name: "Marco" }, line: "Working", findings: [], validFrom: null, validUntil: null, keepRunning: false, at: null, ...over });
const DETAIL = (over: Record<string, unknown> = {}) => ({
  ...ROW({ lifecycle: "suspended", effective: "suspended", line: "Stop asked: still running" }),
  title: "",
  rev: 2,
  reason: "left",
  note: null,
  keepReason: null,
  teams: [],
  agents: [],
  actions: [],
  close: null,
  plan: { mode: "portal_link", applied: false, headline: "Not applied: do these in Portal", portalUrl: null, steps: [{ id: "pause:agt_A", agent: { id: "agt_A", name: "Henry" }, action: "pause", text: "Pause Henry in Portal.", state: "open", proof: "Portal shows this agent as running." }], openSteps: 1, notChanged: ["Their own logins, such as Slack, Google or a bank."], note: null },
  floor: FLOOR(),
  grantsBefore: null,
  notices: [],
  history: [],
  ...over,
});

interface Stub {
  calls: { op: string; input: any }[];
  answers: Record<string, ((input: any) => { status: number; body: unknown }) | undefined>;
}
const ok = (output: unknown) => () => ({ status: 200, body: { status: "ok", output } });
const refuse = (status: number, code: string, message: string, details?: unknown) => () => ({ status, body: { error: { code, message, details } } });
const stub: Stub = { calls: [], answers: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any };
  stub.calls.push({ op, input: body.input });
  const answer = stub.answers[op];
  if (!answer) return json(404, { error: { code: "unknown_tool", message: op } });
  const a = answer(body.input);
  return json(a.status, a.body);
}) as typeof fetch;

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
const chooseReason = async (rootEl: ParentNode, label: string) => {
  await click(rootEl.querySelector('[role="combobox"]') as Element);
  const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(label));
  assert.ok(opt, `option ${label}`);
  await click(opt as Element);
};
const stopInput = () => stub.calls.filter((c) => c.op === "lifecycle_set").map((c) => c.input);

type Summary = typeof import("../src/ui/pages/summary.tsx");
type Everyone = typeof import("../src/ui/pages/everyone.tsx");
type Flow = typeof import("../src/ui/pages/leave-flow.tsx");
type Changes = typeof import("../src/ui/pages/change-dialogs.tsx");
let flow: Flow;
let changes: Changes;
let summary: Summary;
let everyone: Everyone;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  summary = (await import(pathToFileURL(join(outDir, "ui", "pages", "summary.js")).href)) as Summary;
  everyone = (await import(pathToFileURL(join(outDir, "ui", "pages", "everyone.js")).href)) as Everyone;
  flow = (await import(pathToFileURL(join(outDir, "ui", "pages", "leave-flow.js")).href)) as Flow;
  changes = (await import(pathToFileURL(join(outDir, "ui", "pages", "change-dialogs.js")).href)) as Changes;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const reset = () => {
  stub.calls = [];
  stub.answers = {};
};

describe("Summary", () => {
  it("shows the numbers, keeps Not installed apart from Could not be read, and turns a server path into a page link", async () => {
    reset();
    stub.answers.summary_get = ok(SUMMARY());
    const m = await mount(h(summary.SummaryPage, {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /Ready to stop an agent\?/);
    assert.match(text, /Could not be read/);
    assert.equal(m.host.querySelector('.ready a')?.getAttribute("href"), "./people-and-agents");
    await m.unmount();
  });
  it("with no open stop it does not say that Rules has a change", async () => {
    reset();
    stub.answers.summary_get = ok(SUMMARY());
    const m = await mount(h(summary.SummaryPage, {}));
    assert.doesNotMatch(m.host.textContent ?? "", /Rules has this change/);
    await m.unmount();
  });
  it("with an open stop it says what Rules has, and what Governance cannot see", async () => {
    reset();
    stub.answers.summary_get = ok(SUMMARY({ agents: { total: 2, running: 2, paused: 0, stopping: 1, notReviewed: 0 } }));
    const m = await mount(h(summary.SummaryPage, {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /Rules has this change\. If its hook is on/);
    assert.match(text, /cannot see that switch/);
    await m.unmount();
  });
  it("a failed load is an error with Try again, not an empty page (RUL-14)", async () => {
    reset();
    stub.answers.summary_get = refuse(500, "internal", "raw upstream");
    const m = await mount(h(summary.SummaryPage, {}));
    assert.ok(button(m.host, "Try again"));
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream|Nothing to show/);
    await m.unmount();
  });
  it("an empty workspace says what to do first", async () => {
    reset();
    stub.answers.summary_get = ok(SUMMARY({ agents: { total: 0, running: 0, paused: 0, stopping: 0, notReviewed: 0 }, people: { total: 0, leaving: 0, suspended: 0 } }));
    const m = await mount(h(summary.SummaryPage, {}));
    assert.match(m.host.textContent ?? "", /Add your first person\. Agents appear when you add them in Portal\./);
    await m.unmount();
  });
});

describe("People and agents, Stop now", () => {
  const list = () => ok({ items: [ROW(), ROW({ id: "agt_B", name: "Gone", runtime: "gone" }), ROW({ id: "agt_C", name: "Old", lifecycle: "leaving", effective: "leaving" }), ROW({ kind: "person", id: "per_1", name: "Marco", runtime: null, owner: null, line: "Active" })], nextCursor: null, total: 4 });
  it("offers Stop now only on an agent that can stop; no raw id on the page", async () => {
    reset();
    stub.answers.colleagues_list = list();
    const m = await mount(h(everyone.EveryonePage, {}));
    const rows = [...m.host.querySelectorAll("tbody tr")];
    assert.deepEqual(
      rows.map((r) => [...r.querySelectorAll("button")].map((b) => b.textContent).includes("Stop now")),
      [true, false, false, false],
    );
    assert.doesNotMatch(m.host.textContent ?? "", /agt_|per_/);
    await m.unmount();
  });
  it("one dialog: no reason, no Stop; the result reads back the server and claims no stop", async () => {
    reset();
    stub.answers.colleagues_list = list();
    stub.answers.lifecycle_set = ok({ colleague: DETAIL(), transition: { from: "active", to: "suspended", event: "lev_1" } });
    const m = await mount(h(everyone.EveryonePage, {}));
    await click(button(m.host, "Stop now"));
    const dialog = m.host.querySelector("dialog") as Element;
    assert.equal(button(dialog, "Stop").disabled, true);
    assert.match(dialog.textContent ?? "", /Not changed/);
    await chooseReason(dialog, "They left");
    await click(button(dialog, "Stop"));
    assert.deepEqual(stopInput(), [{ kind: "agent", id: "agt_A", to: "suspended", reason: "left" }]);
    const after = m.host.querySelector("dialog")?.textContent ?? "";
    assert.match(after, /Not confirmed: nothing may stop until you approve in Portal\./);
    assert.match(after, /Not applied: do these in Portal/);
    assert.match(after, /Waiting for you in Portal/);
    assert.doesNotMatch(after, /has stopped|calls stopped|Rules has this change/);
    await m.unmount();
  });
  it("the stop cap: names the count and sends the server's number on the second press", async () => {
    reset();
    stub.answers.colleagues_list = list();
    let first = true;
    stub.answers.lifecycle_set = (input) => {
      if (first) {
        first = false;
        return refuse(409, "stop_cap_reached", "x", { count: 6 })();
      }
      return ok({ colleague: DETAIL(), transition: null })(input);
    };
    const m = await mount(h(everyone.EveryonePage, {}));
    await click(button(m.host, "Stop now"));
    const dialog = m.host.querySelector("dialog") as Element;
    await chooseReason(dialog, "Security");
    await click(button(dialog, "Stop"));
    assert.match(dialog.textContent ?? "", /You stopped 5 entries in the last 10 minutes/);
    await click(button(dialog, "Stop this one too"));
    assert.equal(stopInput()[1].confirmCount, 6);
    await m.unmount();
  });
  it("a lost answer: the retry finds the stop made and shows the result, not a failure", async () => {
    reset();
    stub.answers.colleagues_list = list();
    stub.answers.lifecycle_set = refuse(409, "already_in_state", "It is already in this state.");
    stub.answers.colleague_get = ok({ colleague: DETAIL() });
    const m = await mount(h(everyone.EveryonePage, {}));
    await click(button(m.host, "Stop now"));
    const dialog = m.host.querySelector("dialog") as Element;
    await chooseReason(dialog, "Security");
    await click(button(dialog, "Stop"));
    assert.match(m.host.querySelector("dialog")?.textContent ?? "", /Not applied: do these in Portal/);
    assert.equal(m.host.querySelector('dialog [role="alert"]'), null);
    await m.unmount();
  });
  it("another refusal stays in the dialog as a sentence, with no raw text", async () => {
    reset();
    stub.answers.colleagues_list = list();
    stub.answers.lifecycle_set = refuse(500, "internal", "raw upstream text");
    const m = await mount(h(everyone.EveryonePage, {}));
    await click(button(m.host, "Stop now"));
    const dialog = m.host.querySelector("dialog") as Element;
    await chooseReason(dialog, "Security");
    await click(button(dialog, "Stop"));
    const alert = dialog.querySelector('[role="alert"]')?.textContent ?? "";
    assert.match(alert, /Something went wrong/);
    assert.doesNotMatch(alert, /raw upstream/);
    await m.unmount();
  });
  it("an empty list says what to do first; a failed load has Try again", async () => {
    reset();
    stub.answers.colleagues_list = ok({ items: [], nextCursor: null, total: 0 });
    let m = await mount(h(everyone.EveryonePage, {}));
    assert.match(m.host.textContent ?? "", /Add your first person/);
    await m.unmount();
    reset();
    stub.answers.colleagues_list = refuse(500, "internal", "x");
    m = await mount(h(everyone.EveryonePage, {}));
    assert.ok(button(m.host, "Try again"));
    await m.unmount();
  });
});

describe("the person flow", () => {
  const person = (over: Record<string, unknown> = {}) =>
    DETAIL({ kind: "person", id: "per_1", name: "Marco", lifecycle: "active", effective: "active", runtime: null, owner: null, line: "Active", plan: null, agents: [ROW(), ROW({ id: "agt_L", name: "Already leaving", lifecycle: "leaving", effective: "leaving" })], rev: 7, ...over }) as never;
  /** A step change fades with a timer: wait until it is done, as in test/ui-reviews.test.ts. */
  const next = async (host: Element, label = "Next") => {
    await click(button(host, label));
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    await flush();
  };
  it("one send: a decision for each agent that can still decide, the revision it read, then only the result", async () => {
    reset();
    stub.answers.lifecycle_set = ok({ colleague: DETAIL({ kind: "person", name: "Marco" }), transition: null });
    const m = await mount(h(flow.LeaveFlow, { c: person(), onClose: () => {}, onChanged: () => {} }));
    const dlg = m.host.querySelector("dialog") as Element;
    assert.equal(button(dlg, "Next").disabled, true, "no reason, no Next");
    await chooseReason(dlg, "They left");
    await next(dlg);
    assert.match(dlg.textContent ?? "", /Henry/);
    assert.doesNotMatch(dlg.textContent ?? "", /Already leaving/);
    await next(dlg);
    assert.match(dlg.textContent ?? "", /Not changed/);
    assert.match(dlg.textContent ?? "", /Their own logins/);
    assert.doesNotMatch(dlg.textContent ?? "", /last day:/i);
    await next(dlg, "Stop");
    assert.deepEqual(stopInput(), [{ kind: "person", id: "per_1", to: "leaving", reason: "left", expectedRev: 7, decisions: [{ agent: "agt_A", decision: "stop" }] }]);
    const after = m.host.querySelector("dialog")?.textContent ?? "";
    assert.match(after, /Not applied: do these in Portal/);
    assert.doesNotMatch(after, /Their agents/, "the earlier steps are gone: going back could not change what was sent");
    assert.equal(stopInput().length, 1);
    await m.unmount();
  });
  it("a refused send stays on Confirm with the sentence; a stale page is read again", async () => {
    reset();
    stub.answers.lifecycle_set = refuse(409, "lifecycle_stale", "This entry changed since you looked. Open it again.");
    let reloaded = 0;
    const m = await mount(h(flow.LeaveFlow, { c: person(), onClose: () => {}, onChanged: () => void reloaded++ }));
    const dlg = m.host.querySelector("dialog") as Element;
    await chooseReason(dlg, "Security");
    await next(dlg);
    await next(dlg);
    await next(dlg, "Stop");
    assert.match(dlg.querySelector('[role="alert"]')?.textContent ?? "", /This entry changed since you looked/);
    assert.ok(button(dlg, "Stop"));
    assert.equal(reloaded, 1);
    await m.unmount();
  });
  it("Keep running needs a named reason before Next", async () => {
    reset();
    const m = await mount(h(flow.LeaveFlow, { c: person(), onClose: () => {}, onChanged: () => {} }));
    const dlg = m.host.querySelector("dialog") as Element;
    await chooseReason(dlg, "They left");
    await next(dlg);
    const keep = [...dlg.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes("Keep running"));
    assert.ok(keep);
    await click(keep as Element);
    assert.match(dlg.textContent ?? "", /may still hold this agent's key/);
    assert.equal(button(dlg, "Next").disabled, true);
    await m.unmount();
  });
});

describe("Close and Bring back", () => {
  const leaving = (over: Record<string, unknown> = {}) => DETAIL({ lifecycle: "leaving", effective: "leaving", runtime: "paused", reason: "migrated", close: { coolingDays: 30, coolingEndsAt: "2026-11-29T00:00:00Z", coolingOver: false, limits: ["Connect could not be read."] }, ...over }) as never;
  const closeAction = { to: "archived", label: "Close", blocked: null, needsWaive: true } as never;
  it("before the cooling period ends a waive is required and sent; a migrated reason is not offered as chosen", async () => {
    reset();
    stub.answers.lifecycle_set = ok({ colleague: DETAIL(), transition: null });
    const m = await mount(h(changes.CloseDialog, { c: leaving(), action: closeAction, onClose: () => {}, onChanged: () => {} }));
    const dlg = m.host.querySelector("dialog") as Element;
    const close = () => button(dlg, "Close this entry");
    assert.equal(close().disabled, true);
    assert.match(dlg.textContent ?? "", /Nothing closes by itself/);
    assert.match(dlg.textContent ?? "", /Connect could not be read/);
    await chooseReason(dlg, "They left");
    assert.equal(close().disabled, true, "still no waive");
    const input = [...dlg.querySelectorAll("input")].filter((i) => i.type !== "hidden").at(-1) as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      set?.call(input, "Handover done");
      input.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
    });
    await flush();
    assert.equal(close().disabled, false);
    await click(close());
    assert.deepEqual(stopInput(), [{ kind: "agent", id: "agt_A", expectedRev: 2, to: "archived", reason: "left", waive: "Handover done" }]);
    await m.unmount();
  });
  it("Bring back after a close restores nothing, and says so", async () => {
    reset();
    const c = DETAIL({ lifecycle: "archived", effective: "archived" }) as never;
    const m = await mount(h(changes.ChangeDialog, { c, action: { to: "proposed", label: "Bring back", blocked: null, needsWaive: false } as never, onClose: () => {}, onChanged: () => {} }));
    assert.match(m.host.querySelector("dialog")?.textContent ?? "", /This restores nothing\. Teams and access do not come back/);
    await m.unmount();
  });
  it("Bring back before a close does not say that teams are gone", async () => {
    reset();
    const c = DETAIL({ lifecycle: "leaving", effective: "leaving" }) as never;
    const m = await mount(h(changes.ChangeDialog, { c, action: { to: "proposed", label: "Bring back", blocked: null, needsWaive: false } as never, onClose: () => {}, onChanged: () => {} }));
    const text = m.host.querySelector("dialog")?.textContent ?? "";
    assert.match(text, /Access that was removed does not come back/);
    assert.doesNotMatch(text, /Teams/);
    await m.unmount();
  });
  it("Mark as reviewed grants nothing, and says so", async () => {
    reset();
    const c = DETAIL({ lifecycle: "proposed", effective: "proposed" }) as never;
    const m = await mount(h(changes.ChangeDialog, { c, action: { to: "active", label: "Mark as reviewed", blocked: null, needsWaive: false } as never, onClose: () => {}, onChanged: () => {} }));
    assert.match(m.host.querySelector("dialog")?.textContent ?? "", /It grants nothing/);
    await m.unmount();
  });
});
