// Join (src/ui/pages/join-flow.tsx, C380 T2-d) against the real SDK client and a stub server, rendered in happy-dom: one person with a last
// day, a pasted list, a person who is there already, a refused row and a repeat, the team step, and the switch that keeps Join off the page.
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
const outDir = join(root, "dist", "ui-test-join");

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

const DIR = {
  revision: 3,
  teams: [{ id: "tm_support", name: "Support", description: "", tags: [], people: 1, agents: 1, updatedAt: "2026-10-30T09:00:00Z", members: [{ kind: "person", id: "psn_old", name: "Old Lead", role: "lead" }, { kind: "agent", id: "agt_a", name: "Henry", role: "member" }] }],
  people: [{ id: "psn_ann", name: "Ann Smith", kind: "person", trust: "trusted", email: "ann@acme.example", title: "", status: "active", tags: [], handles: ["slack:U1ANN0001"], teams: [], updatedAt: "2026-10-30T09:00:00Z", org: "", relationship: "" }],
  agents: [],
};
interface Stub {
  calls: { op: string; input: any; key: string | null }[];
  /** person name -> refusal */
  refuse: Record<string, { status: number; code: string; message: string }>;
}
const stub: Stub = { calls: [], refuse: {} };
let made = 0;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/fleet/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["person_set"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: any; idempotencyKey?: string };
  stub.calls.push({ op, input: body.input, key: body.idempotencyKey ?? null });
  if (op === "overview_get") return json(200, { status: "ok", output: DIR });
  if (op === "person_set") {
    const r = stub.refuse[body.input.name];
    if (r) return json(r.status, { error: { code: r.code, message: r.message } });
    return json(200, { status: "ok", output: { person: { id: `psn_new${++made}`, name: body.input.name } } });
  }
  if (op === "members_set") return json(200, { status: "ok", output: { team: { id: body.input.team } } });
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
const ops = () => stub.calls.map((c) => c.op);
const reset = () => {
  stub.calls = [];
  stub.refuse = {};
  made = 0;
};

type Flow = typeof import("../src/ui/pages/join-flow.tsx");
type Features = typeof import("../src/ui/pages/features.ts");
let flow: Flow;
let features: Features;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  flow = (await import(pathToFileURL(join(outDir, "ui", "pages", "join-flow.js")).href)) as Flow;
  features = (await import(pathToFileURL(join(outDir, "ui", "pages", "features.js")).href)) as Features;
});
after(() => rmSync(outDir, { recursive: true, force: true }));
const open = (mode: "one" | "list", extra: { onChanged?: () => void } = {}) => mount(h(flow.JoinFlow, { mode, portalHref: "https://portal.tealbrick.com/", onClose() {}, onChanged: extra.onChanged ?? (() => {}) }));

describe("Join: one person", () => {
  it("a contractor: the last day is needed, ends at the end of that day, and goes in the same person_set with the tag; the result links to the person and to Portal", async () => {
    reset();
    let changed = 0;
    await open("one", { onChanged: () => void changed++ });
    assert.equal(button("Next").disabled, true, "a name is needed first");
    await type(field("Name"), "Dana Lee");
    await type(field("Email"), "dana@acme.example");
    await type(field("Channel handles"), "slack:U2DANA0002");
    await next();
    await choose("A contractor");
    assert.equal(button("Next").disabled, true, "a contractor needs a last day");
    await type(field("Last day"), "2099-12-31");
    assert.equal(button("Next").disabled, false);
    await next();
    const text = dialog().textContent ?? "";
    assert.match(text, /This adds directory entries\. It gives no access in any app and changes nothing in Portal\./);
    assert.match(text, /At the end of 2099-12-31 \(UTC\), Governance marks this person as stopped\./);
    assert.match(text, /does not end their own logins/);
    assert.deepEqual(ops(), ["overview_get"], "nothing is sent before Confirm");
    await next("Add person");
    const sent = stub.calls.filter((c) => c.op === "person_set");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.input, { name: "Dana Lee", handles: ["slack:U2DANA0002"], tags: ["contractor"], email: "dana@acme.example", validUntil: "2099-12-31T23:59:59.000Z" });
    assert.match(String(sent[0]?.key), /^join-[0-9a-f-]+-1$/);
    assert.equal(changed, 1);
    const after = dialog().textContent ?? "";
    assert.match(after, /Dana Lee is added\./);
    assert.match(after, /Last day saved: 2099-12-31 \(UTC\)/);
    assert.match(after, /Joining gives no access/);
    assert.ok([...dialog().querySelectorAll("a")].some((a) => a.textContent?.includes("See what apps report for Dana Lee")));
    assert.equal([...dialog().querySelectorAll("a")].find((a) => a.textContent === "Open Portal")?.getAttribute("href"), "https://portal.tealbrick.com/");
    assert.equal(ops().includes("members_set"), false, "no team chosen");
  });

  it("a contractor whose last day ends while the dialog is open is refused at the send: nothing is added, and never as a person with no end date", async () => {
    reset();
    await open("one");
    await type(field("Name"), "Dana Lee");
    await next();
    await choose("A contractor");
    const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await type(field("Last day"), day);
    await next();
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 86_400_000;
    try {
      await next("Add person");
    } finally {
      Date.now = realNow;
    }
    assert.match(alerts().join(" "), /The last day is not right\. This day has passed in UTC\. Choose a later day\. Nothing was added\./);
    assert.equal(ops().includes("person_set"), false);
  });

  it("a person who is in the directory already is not added again: the sentence says so and Next stays off", async () => {
    reset();
    await open("one");
    await type(field("Name"), "ann smith");
    assert.match(alerts().join(" "), /Ann Smith is in the directory already\. Join adds new people\./);
    assert.equal(button("Next").disabled, true);
    await type(field("Name"), "Ann Smyth");
    await type(field("Email"), "ANN@acme.example");
    assert.match(alerts().join(" "), /in the directory already/, "the same email is the same person");
    assert.deepEqual(ops(), ["overview_get"]);
  });

  it("fire on bad: a last day that has passed is said in the form and nothing is sent", async () => {
    reset();
    await open("one");
    await type(field("Name"), "Dana Lee");
    await next();
    await choose("A contractor");
    await type(field("Last day"), "2020-01-01");
    assert.match(dialog().textContent ?? "", /This day has passed in UTC\. Choose a later day\./);
    assert.equal(button("Next").disabled, true);
    assert.deepEqual(ops(), ["overview_get"]);
  });

  it("a refused person stays on Confirm's result with the server's sentence and Send again", async () => {
    reset();
    stub.refuse["Dana Lee"] = { status: 409, code: "handle_taken", message: "slack:u2dana0002 belongs to another person" };
    await open("one");
    await type(field("Name"), "Dana Lee");
    await type(field("Channel handles"), "slack:U2DANA0002");
    await next();
    await next();
    await next("Add person");
    assert.match(alerts().join(" "), /Slack:u2dana0002 belongs to another person\./);
    assert.ok(button("Send again"));
    delete stub.refuse["Dana Lee"];
    await click(button("Send again"));
    assert.match(dialog().textContent ?? "", /Dana Lee is added\./);
    assert.equal(new Set(stub.calls.filter((c) => c.op === "person_set").map((c) => c.key)).size, 1, "the same key for the same person");
  });
});

describe("Join: a pasted list", () => {
  const LIST = ["Name, Email", "Bo Bell, bo@acme.example, slack:U3BO00003", "Ann Smith", "Cy Cole\tcy@acme.example\tDesigner", "x@y.example, a@b.example, Zed"].join("\n");
  it("checks the list first, adds only the people who are ready, and says what was left out", async () => {
    reset();
    await open("list");
    assert.equal(button("Next").disabled, true);
    await type(field("The list"), LIST);
    await next();
    const check = dialog().textContent ?? "";
    assert.match(check, /2 ready to add, 1 in the directory already, 1 to fix\./);
    assert.match(check, /The first line is a header and is left out\./);
    assert.match(check, /Ann Smith is in the directory already\./);
    assert.match(check, /There is more than one email\./);
    assert.deepEqual(ops(), ["overview_get"]);
    await next();
    await next();
    assert.match(dialog().textContent ?? "", /2 to add, 2 left out/);
    await next("Add 2 people");
    const sent = stub.calls.filter((c) => c.op === "person_set");
    assert.deepEqual(sent.map((c) => c.input.name), ["Bo Bell", "Cy Cole"]);
    assert.deepEqual(sent.map((c) => c.input.title ?? ""), ["", "Designer"]);
    assert.deepEqual(sent.map((c) => c.input.tags), [[], []]);
    assert.match(dialog().textContent ?? "", /2 added\./);
    assert.equal(ops().includes("members_set"), false);
  });

  it("a refused row does not stop the others; Send again sends only that one", async () => {
    reset();
    stub.refuse["Cy Cole"] = { status: 409, code: "handle_taken", message: "slack:u3cy00003 belongs to another person" };
    await open("list");
    await type(field("The list"), "Bo Bell\nCy Cole, slack:U3CY00003\nDi Dole");
    await next();
    await next();
    await next();
    await next("Add 3 people");
    assert.match(dialog().textContent ?? "", /2 added, 1 did not go through, 0 not tried\./);
    assert.match(dialog().textContent ?? "", /Slack:u3cy00003 belongs to another person|slack:u3cy00003 belongs to another person/i);
    delete stub.refuse["Cy Cole"];
    const before = stub.calls.length;
    await click(button("Send again"));
    assert.deepEqual(stub.calls.slice(before).filter((c) => c.op === "person_set").map((c) => c.input.name), ["Cy Cole"], "Bo and Di are not sent twice");
    assert.match(dialog().textContent ?? "", /3 added\./);
  });

  it("the team: read again right before, the old members are kept, the new people are added as members in ONE members_set", async () => {
    reset();
    await open("list");
    await type(field("The list"), "Bo Bell\nCy Cole");
    await next();
    await next();
    await click(dialog().querySelector('[role="combobox"]') as Element);
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Support") as Element);
    await next();
    await next("Add 2 people");
    assert.deepEqual(ops(), ["overview_get", "person_set", "person_set", "overview_get", "members_set"]);
    const set = stub.calls.at(-1)?.input;
    assert.deepEqual(set, { team: "tm_support", people: [{ id: "psn_old", role: "lead" }, { id: "psn_new1", role: "member" }, { id: "psn_new2", role: "member" }], agents: [{ id: "agt_a", role: "member" }] });
    assert.match(dialog().textContent ?? "", /Added to the team Support\./);
  });
});

describe("Join stays off the page until its rows pass", () => {
  it("the route needs the three ops; the Add people button needs the QA switch as well", () => {
    const ops = ["person_set", "overview_get", "members_set"];
    assert.equal(features.JOIN_ROWS_PASSED, false, "the switch is off in this PR");
    assert.deepEqual([features.featuresOf(ops).join, features.featuresOf(ops).joinInNav], [true, false]);
    assert.deepEqual([features.featuresOf(ops, true).join, features.featuresOf(ops, true).joinInNav], [true, true]);
    assert.deepEqual([features.featuresOf(["person_set", "overview_get"], true).join, features.featuresOf(["person_set", "overview_get"], true).joinInNav], [false, false]);
  });
});
